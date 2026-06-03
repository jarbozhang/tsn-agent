pub const DATABASE_URL: &str = "sqlite:tsn-agent.db";

/// Schema-version 1：sessions / app_state / diagnostic_logs。原始 plan baseline 表。
pub const SESSION_SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        has_project INTEGER NOT NULL DEFAULT 0,
        project_name TEXT,
        bundle_file_count INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
        ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS diagnostic_logs (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        run_id TEXT,
        duration_ms INTEGER,
        details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_session_created_at
        ON diagnostic_logs(session_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_session_category
        ON diagnostic_logs(session_id, category);
"#;

/// Schema-version 2：plan v3 U2a — 15 张 P0 领域表（schema 草案
/// `docs/plans/2026-06-03-001-schema-draft.md`，Spike A 已通过 BFE fixture
/// canonical byte-equal round-trip）。
///
/// 分组：
/// - topology.json (3 表): topology_nodes / topology_links / topology_refs
/// - topo_feature.json (1 表): topo_feature_links
/// - node.json (11 表): nodes + 10 类业务配置子表
///
/// 字段 NULLABLE 取舍依据 Spike A 报告：
/// - topology_nodes.node_type：BFE fixture 不含 → NULLABLE
/// - topology_links.name：BFE fixture 不含 → NULLABLE
/// - nodes base_info 列：BFE node.json 不含 → 全 NULLABLE
///
/// `application_id` 在本 migration 末尾设置（dev db v1→v2 升级时自动 set）。
pub const P0_DOMAIN_SCHEMA_SQL: &str = r#"
    -- topology.json (3 tables)
    CREATE TABLE IF NOT EXISTS topology_nodes (
        session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        imac          INTEGER NOT NULL,
        sync_name     TEXT    NOT NULL,
        x             REAL    NOT NULL,
        y             REAL    NOT NULL,
        sync_type     TEXT    NOT NULL,
        node_type     TEXT,
        insert_order  INTEGER NOT NULL,
        PRIMARY KEY (session_id, imac)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_nodes_session
        ON topology_nodes(session_id, insert_order);

    CREATE TABLE IF NOT EXISTS topology_links (
        session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        link_seq     INTEGER NOT NULL,
        name         TEXT,
        src_imac     INTEGER NOT NULL,
        dst_imac     INTEGER NOT NULL,
        styles_json  TEXT    NOT NULL,
        PRIMARY KEY (session_id, link_seq)
    );
    CREATE INDEX IF NOT EXISTS idx_topology_links_session
        ON topology_links(session_id, src_imac, dst_imac);

    CREATE TABLE IF NOT EXISTS topology_refs (
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ref_json    TEXT NOT NULL,
        PRIMARY KEY (session_id)
    );

    -- topo_feature.json (1 table)
    CREATE TABLE IF NOT EXISTS topo_feature_links (
        session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        link_id     INTEGER NOT NULL,
        src_node    INTEGER NOT NULL,
        src_port    INTEGER NOT NULL,
        dst_node    INTEGER NOT NULL,
        dst_port    INTEGER NOT NULL,
        speed       INTEGER NOT NULL,
        st_queues   INTEGER NOT NULL,
        macrotick   INTEGER,
        PRIMARY KEY (session_id, link_id)
    );
    CREATE INDEX IF NOT EXISTS idx_topo_feature_session_src
        ON topo_feature_links(session_id, src_node);
    CREATE INDEX IF NOT EXISTS idx_topo_feature_session_dst
        ON topo_feature_links(session_id, dst_node);

    -- node.json (11 tables)
    CREATE TABLE IF NOT EXISTS nodes (
        session_id        TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        node_id           TEXT    NOT NULL,
        is_global         INTEGER NOT NULL DEFAULT 0,
        node_name         TEXT,
        node_type         TEXT,
        queue_num         INTEGER,
        buffer_num        INTEGER,
        port_num          INTEGER,
        mac_address       TEXT,
        ip                TEXT,
        config_file_name  TEXT,
        device_id         TEXT,
        test_port         TEXT,
        PRIMARY KEY (session_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_session
        ON nodes(session_id, is_global, node_id);

    CREATE TABLE IF NOT EXISTS nodes_oss_cfg (
        session_id  TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        cfg_json    TEXT NOT NULL,
        PRIMARY KEY (session_id, node_id),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_sdu_table_cfg (
        session_id      TEXT    NOT NULL,
        node_id         TEXT    NOT NULL,
        port_id         INTEGER NOT NULL,
        traffic_class   INTEGER NOT NULL CHECK (traffic_class BETWEEN 0 AND 7),
        sdu_size        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, node_id, port_id, traffic_class),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_gcl_cfg (
        session_id            TEXT    NOT NULL,
        node_id               TEXT    NOT NULL,
        port_id               INTEGER NOT NULL,
        slot_index            INTEGER NOT NULL,
        operation_name        TEXT    NOT NULL,
        gate_state_value      TEXT    NOT NULL,
        time_interval_value   INTEGER NOT NULL,
        PRIMARY KEY (session_id, node_id, port_id, slot_index),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_time_cfg (
        session_id  TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        cfg_json    TEXT NOT NULL,
        PRIMARY KEY (session_id, node_id),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_psfg_stream_filters (
        session_id      TEXT    NOT NULL,
        node_id         TEXT    NOT NULL,
        filter_id       INTEGER NOT NULL,
        spec_json       TEXT    NOT NULL,
        flow_meter_id   INTEGER,
        stream_gate_id  INTEGER,
        PRIMARY KEY (session_id, node_id, filter_id),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_psfg_flow_meters (
        session_id  TEXT    NOT NULL,
        node_id     TEXT    NOT NULL,
        meter_id    INTEGER NOT NULL,
        spec_json   TEXT    NOT NULL,
        PRIMARY KEY (session_id, node_id, meter_id),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_psfg_stream_gates (
        session_id  TEXT    NOT NULL,
        node_id     TEXT    NOT NULL,
        gate_id     INTEGER NOT NULL,
        spec_json   TEXT    NOT NULL,
        PRIMARY KEY (session_id, node_id, gate_id),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_frer_cfg (
        session_id  TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        cfg_json    TEXT NOT NULL,
        PRIMARY KEY (session_id, node_id),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_array_cfg (
        session_id   TEXT    NOT NULL,
        node_id      TEXT    NOT NULL,
        cfg_kind     TEXT    NOT NULL CHECK (cfg_kind IN ('fwd_cfg', 'inform_cfg')),
        entry_seq    INTEGER NOT NULL,
        entry_json   TEXT    NOT NULL,
        PRIMARY KEY (session_id, node_id, cfg_kind, entry_seq),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes_object_cfg (
        session_id   TEXT NOT NULL,
        node_id      TEXT NOT NULL,
        cfg_kind     TEXT NOT NULL CHECK (cfg_kind IN ('para_cfg', 'static_mac_cfg', 'tsnlight_cfg', 'multicast_cfg')),
        cfg_json     TEXT NOT NULL,
        PRIMARY KEY (session_id, node_id, cfg_kind),
        FOREIGN KEY (session_id, node_id)
            REFERENCES nodes(session_id, node_id) ON DELETE CASCADE
    );

    PRAGMA application_id = 1414745601;  -- 0x54534E01 ("TSN\x01")
"#;

/// `connect_app_database` 内 safety-net 用：覆盖 v1 + v2 全部 schema，
/// `CREATE TABLE IF NOT EXISTS` 幂等，老 db 升级与新 db 创建都安全。
pub fn safety_net_schema_sql() -> String {
    format!("{SESSION_SCHEMA_SQL}\n{P0_DOMAIN_SCHEMA_SQL}")
}

pub fn migrations() -> Vec<tauri_plugin_sql::Migration> {
    vec![
        tauri_plugin_sql::Migration {
            version: 1,
            description: "create_session_store",
            sql: SESSION_SCHEMA_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
        tauri_plugin_sql::Migration {
            version: 2,
            description: "create_p0_domain_tables",
            sql: P0_DOMAIN_SCHEMA_SQL,
            kind: tauri_plugin_sql::MigrationKind::Up,
        },
    ]
}
