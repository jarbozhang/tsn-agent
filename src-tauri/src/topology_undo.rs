//! 单步撤销核心（纯 Rust，不含 push/emit）。
//!
//! `snapshot_pre_image` 在结构变更前、调用方已开的事务里，把某 domain 的若干表
//! 序列化成一份 blob，按 `(session_id, domain)` 覆盖式写入 `topology_undo_snapshots`。
//! `restore_pre_image` 自开事务，把 blob 盖回对应表并清除 pre-image（撤销后
//! 无可再撤——R11）。两面入口（Tauri command / sidecar route）共用此核心，
//! 各自的 push/emit 留在调用点（KTD2）。
//!
//! 多 domain 分派（R19）：blob 形状、读哪些表、盖回哪些表都按 `domain` 选——
//! `"topology"` → `[topology_nodes, topology_links]`、`"timesync"` →
//! `[timesync_domain, timesync_nodes]`。**绝不**让某 domain 的撤销跑到另一
//! domain 的表名（否则会清空别的 domain 数据）。

use serde::{Deserialize, Serialize};
use sqlx::{Pool, Row, Sqlite, SqliteConnection};

pub const TOPOLOGY_DOMAIN: &str = "topology";
pub const TIMESYNC_DOMAIN: &str = "timesync";

/// pre-image blob 的整体形状：两表各一段。列清单与 `SESSION_SCOPED_TABLES`
/// 的 topology_* 条目一一对应，避免漂移。
#[derive(Debug, Serialize, Deserialize)]
struct TopologyPreImage {
    nodes: Vec<NodeRow>,
    links: Vec<LinkRow>,
}

#[derive(Debug, Serialize, Deserialize)]
struct NodeRow {
    session_id: String,
    mid: String,
    name: Option<String>,
    x: f64,
    y: f64,
    node_type: Option<String>,
    // U1 新增列：旧 blob 缺这些键时 serde default（mac/ip=None、port/queue=0）。
    #[serde(default)]
    mac: Option<String>,
    #[serde(default)]
    ip: Option<String>,
    #[serde(default)]
    port_count: i64,
    #[serde(default)]
    queue_count: i64,
    insert_order: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct LinkRow {
    session_id: String,
    link_seq: i64,
    name: Option<String>,
    src_node: String,
    dst_node: String,
    // U2 新增列：旧 blob 缺这些键时 serde default（None）。
    #[serde(default)]
    src_port: Option<i64>,
    #[serde(default)]
    dst_port: Option<i64>,
    #[serde(default)]
    speed: Option<i64>,
    styles_json: String,
}

/// timesync domain 的 pre-image：单域配置行（至多一行）+ 每节点行。
/// 列清单与 `timesync_domain` / `timesync_nodes` schema 一一对应。
#[derive(Debug, Serialize, Deserialize)]
struct TimesyncPreImage {
    domain: Vec<TimesyncDomainRow>,
    nodes: Vec<TimesyncNodeRow>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TimesyncDomainRow {
    session_id: String,
    gm_mid: Option<String>,
    one_step_mode: i64,
    fre_switch: i64,
    disabled_link_seqs: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TimesyncNodeRow {
    session_id: String,
    mid: String,
    master_port: String,
    slave_port: String,
    port_ptp_enabled: String,
    sync_period: Option<i64>,
    measure_period: Option<i64>,
    report_enable: Option<i64>,
    mean_link_delay_thresh: Option<i64>,
    offset_threshold: Option<i64>,
}

/// serde_json 错误折进 sqlx::Error，保持函数签名为 `Result<_, sqlx::Error>`
/// （与邻近 DB 函数一致）。
fn json_err(e: serde_json::Error) -> sqlx::Error {
    sqlx::Error::Protocol(format!("undo blob json error: {e}"))
}

/// 当前 iso8601 风格时间戳（`@unix-{secs}`），避免引入 chrono 依赖。
/// 用于 undo 快照 created_at 字段（精度足够：仅排序/显示）。
fn chrono_like_iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("@unix-{secs}")
}

/// 写前快照：按 domain 读对应表、序列化成 blob、覆盖式写入 undo 表。
/// 接调用方已开的事务/连接句柄——不自开事务（dry-run rollback 时随事务一并丢弃）。
pub async fn snapshot_pre_image(
    conn: &mut SqliteConnection,
    session_id: &str,
    domain: &str,
) -> Result<(), sqlx::Error> {
    let blob_json = match domain {
        TIMESYNC_DOMAIN => snapshot_timesync_blob(conn, session_id).await?,
        // 默认（含 TOPOLOGY_DOMAIN）走 topology 两表。
        _ => snapshot_topology_blob(conn, session_id).await?,
    };

    sqlx::query(
        r#"INSERT INTO topology_undo_snapshots (session_id, domain, blob_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, domain)
           DO UPDATE SET blob_json = excluded.blob_json, created_at = excluded.created_at"#,
    )
    .bind(session_id)
    .bind(domain)
    .bind(&blob_json)
    .bind(chrono_like_iso_now())
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// 读 topology 两表 → blob JSON。
async fn snapshot_topology_blob(
    conn: &mut SqliteConnection,
    session_id: &str,
) -> Result<String, sqlx::Error> {
    let node_rows = sqlx::query(
        r#"SELECT session_id, mid, name, x, y, node_type, mac, ip, port_count, queue_count, insert_order
           FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, mid"#,
    )
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    let link_rows = sqlx::query(
        r#"SELECT session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json
           FROM topology_links WHERE session_id = ? ORDER BY link_seq"#,
    )
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;

    let pre_image = TopologyPreImage {
        nodes: node_rows
            .into_iter()
            .map(|r| NodeRow {
                session_id: r.get("session_id"),
                mid: r.get("mid"),
                name: r.get("name"),
                x: r.get("x"),
                y: r.get("y"),
                node_type: r.get("node_type"),
                mac: r.get("mac"),
                ip: r.get("ip"),
                port_count: r.get("port_count"),
                queue_count: r.get("queue_count"),
                insert_order: r.get("insert_order"),
            })
            .collect(),
        links: link_rows
            .into_iter()
            .map(|r| LinkRow {
                session_id: r.get("session_id"),
                link_seq: r.get("link_seq"),
                name: r.get("name"),
                src_node: r.get("src_node"),
                dst_node: r.get("dst_node"),
                src_port: r.get("src_port"),
                dst_port: r.get("dst_port"),
                speed: r.get("speed"),
                styles_json: r.get("styles_json"),
            })
            .collect(),
    };

    serde_json::to_string(&pre_image).map_err(json_err)
}

/// 读 timesync 两表 → blob JSON。
async fn snapshot_timesync_blob(
    conn: &mut SqliteConnection,
    session_id: &str,
) -> Result<String, sqlx::Error> {
    let domain_rows = sqlx::query(
        r#"SELECT session_id, gm_mid, one_step_mode, fre_switch, disabled_link_seqs
           FROM timesync_domain WHERE session_id = ?"#,
    )
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;
    let node_rows = sqlx::query(
        r#"SELECT session_id, mid, master_port, slave_port, port_ptp_enabled,
                  sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold
           FROM timesync_nodes WHERE session_id = ? ORDER BY mid"#,
    )
    .bind(session_id)
    .fetch_all(&mut *conn)
    .await?;

    let pre_image = TimesyncPreImage {
        domain: domain_rows
            .into_iter()
            .map(|r| TimesyncDomainRow {
                session_id: r.get("session_id"),
                gm_mid: r.get("gm_mid"),
                one_step_mode: r.get("one_step_mode"),
                fre_switch: r.get("fre_switch"),
                disabled_link_seqs: r.get("disabled_link_seqs"),
            })
            .collect(),
        nodes: node_rows
            .into_iter()
            .map(|r| TimesyncNodeRow {
                session_id: r.get("session_id"),
                mid: r.get("mid"),
                master_port: r.get("master_port"),
                slave_port: r.get("slave_port"),
                port_ptp_enabled: r.get("port_ptp_enabled"),
                sync_period: r.get("sync_period"),
                measure_period: r.get("measure_period"),
                report_enable: r.get("report_enable"),
                mean_link_delay_thresh: r.get("mean_link_delay_thresh"),
                offset_threshold: r.get("offset_threshold"),
            })
            .collect(),
    };

    serde_json::to_string(&pre_image).map_err(json_err)
}

/// 撤销：读对应 domain 的 pre-image（无则 no-op 返 false），自开事务把该 domain
/// 的表盖回，清除 pre-image（使再次撤销返 false），commit 后返 true。
/// 盖回的 DELETE/INSERT 目标表集合严格按 domain 分派——绝不触碰别的 domain 的表。
pub async fn restore_pre_image(
    pool: &Pool<Sqlite>,
    session_id: &str,
    domain: &str,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let blob: Option<String> = sqlx::query_scalar(
        r#"SELECT blob_json FROM topology_undo_snapshots
           WHERE session_id = ? AND domain = ?"#,
    )
    .bind(session_id)
    .bind(domain)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(blob_json) = blob else {
        // 无快照：不动任何表，直接 no-op。
        return Ok(false);
    };

    match domain {
        TIMESYNC_DOMAIN => restore_timesync(&mut tx, session_id, &blob_json).await?,
        // 默认（含 TOPOLOGY_DOMAIN）走 topology 两表。
        _ => restore_topology(&mut tx, session_id, &blob_json).await?,
    }

    // 撤销后清除 pre-image：再次 restore 返 false（R11「无可撤销」）。
    sqlx::query(r#"DELETE FROM topology_undo_snapshots WHERE session_id = ? AND domain = ?"#)
        .bind(session_id)
        .bind(domain)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(true)
}

/// 盖回 topology 两表（topology_nodes / topology_links）。
async fn restore_topology(
    tx: &mut SqliteConnection,
    session_id: &str,
    blob_json: &str,
) -> Result<(), sqlx::Error> {
    let pre_image: TopologyPreImage = serde_json::from_str(blob_json).map_err(json_err)?;

    for table in ["topology_nodes", "topology_links"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE session_id = ?"))
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
    }

    for node in &pre_image.nodes {
        sqlx::query(
            r#"INSERT INTO topology_nodes
               (session_id, mid, name, x, y, node_type, mac, ip, port_count, queue_count, insert_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&node.session_id)
        .bind(&node.mid)
        .bind(&node.name)
        .bind(node.x)
        .bind(node.y)
        .bind(&node.node_type)
        .bind(&node.mac)
        .bind(&node.ip)
        .bind(node.port_count)
        .bind(node.queue_count)
        .bind(node.insert_order)
        .execute(&mut *tx)
        .await?;
    }

    for link in &pre_image.links {
        sqlx::query(
            r#"INSERT INTO topology_links
               (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&link.session_id)
        .bind(link.link_seq)
        .bind(&link.name)
        .bind(&link.src_node)
        .bind(&link.dst_node)
        .bind(link.src_port)
        .bind(link.dst_port)
        .bind(link.speed)
        .bind(&link.styles_json)
        .execute(&mut *tx)
        .await?;
    }

    Ok(())
}

/// 盖回 timesync 两表（timesync_domain / timesync_nodes）。
async fn restore_timesync(
    tx: &mut SqliteConnection,
    session_id: &str,
    blob_json: &str,
) -> Result<(), sqlx::Error> {
    let pre_image: TimesyncPreImage = serde_json::from_str(blob_json).map_err(json_err)?;

    for table in ["timesync_domain", "timesync_nodes"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE session_id = ?"))
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
    }

    for row in &pre_image.domain {
        sqlx::query(
            r#"INSERT INTO timesync_domain
               (session_id, gm_mid, one_step_mode, fre_switch, disabled_link_seqs)
               VALUES (?, ?, ?, ?, ?)"#,
        )
        .bind(&row.session_id)
        .bind(&row.gm_mid)
        .bind(row.one_step_mode)
        .bind(row.fre_switch)
        .bind(&row.disabled_link_seqs)
        .execute(&mut *tx)
        .await?;
    }

    for node in &pre_image.nodes {
        sqlx::query(
            r#"INSERT INTO timesync_nodes
               (session_id, mid, master_port, slave_port, port_ptp_enabled,
                sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&node.session_id)
        .bind(&node.mid)
        .bind(&node.master_port)
        .bind(&node.slave_port)
        .bind(&node.port_ptp_enabled)
        .bind(node.sync_period)
        .bind(node.measure_period)
        .bind(node.report_enable)
        .bind(node.mean_link_delay_thresh)
        .bind(node.offset_threshold)
        .execute(&mut *tx)
        .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn fresh_pool() -> Pool<Sqlite> {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sessions (id, title, created_at, updated_at, payload) \
             VALUES ('s1', 't', 'now', 'now', '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    /// 写一套含 x/y、mac/ip/port_count、styles_json、端口列的两表样本。
    async fn seed_topology(pool: &Pool<Sqlite>) {
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, mac, ip, port_count, queue_count, insert_order) \
             VALUES ('s1', '0', 'ES-1', 10.5, 20.25, 'endSystem', '02:00:00:00:00:01', '10.0.0.1', 8, 8, 0), \
                    ('s1', '1', NULL, 30.0, 40.0, 'switch', NULL, NULL, 16, 8, 1)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO topology_links (session_id, link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json) \
             VALUES ('s1', 0, 'l0', '0', '1', 0, 1, 1000, '{\"leftLabel\":\"0\",\"rightLabel\":\"1\"}')",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    #[allow(clippy::type_complexity)]
    async fn dump_nodes(
        pool: &Pool<Sqlite>,
    ) -> Vec<(
        String,
        Option<String>,
        f64,
        f64,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        i64,
        i64,
    )> {
        sqlx::query(
            "SELECT mid, name, x, y, node_type, mac, ip, port_count, queue_count, insert_order FROM topology_nodes \
             WHERE session_id='s1' ORDER BY insert_order, mid",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| {
            (
                r.get("mid"),
                r.get("name"),
                r.get("x"),
                r.get("y"),
                r.get("node_type"),
                r.get("mac"),
                r.get("ip"),
                r.get("port_count"),
                r.get("queue_count"),
                r.get("insert_order"),
            )
        })
        .collect()
    }

    #[allow(clippy::type_complexity)]
    async fn dump_links(
        pool: &Pool<Sqlite>,
    ) -> Vec<(
        i64,
        Option<String>,
        String,
        String,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        String,
    )> {
        sqlx::query(
            "SELECT link_seq, name, src_node, dst_node, src_port, dst_port, speed, styles_json FROM topology_links \
             WHERE session_id='s1' ORDER BY link_seq",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| {
            (
                r.get("link_seq"),
                r.get("name"),
                r.get("src_node"),
                r.get("dst_node"),
                r.get("src_port"),
                r.get("dst_port"),
                r.get("speed"),
                r.get("styles_json"),
            )
        })
        .collect()
    }

    async fn snapshot(pool: &Pool<Sqlite>) {
        let mut tx = pool.begin().await.unwrap();
        snapshot_pre_image(&mut tx, "s1", TOPOLOGY_DOMAIN)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    async fn snapshot_domain(pool: &Pool<Sqlite>, domain: &str) {
        let mut tx = pool.begin().await.unwrap();
        snapshot_pre_image(&mut tx, "s1", domain).await.unwrap();
        tx.commit().await.unwrap();
    }

    /// 写一套 timesync 两表样本（一域 + 两节点，含禁用集与同步参数）。
    async fn seed_timesync(pool: &Pool<Sqlite>) {
        sqlx::query(
            "INSERT INTO timesync_domain (session_id, gm_mid, one_step_mode, fre_switch, disabled_link_seqs) \
             VALUES ('s1', '0', 1, 0, '[3]')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port, port_ptp_enabled, sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold) \
             VALUES ('s1', '0', '[1]', '[]', '[1]', 128, 1024, 1, 800, 1000), \
                    ('s1', '1', '[]', '[2]', '[2]', NULL, NULL, NULL, NULL, NULL)",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    #[allow(clippy::type_complexity)]
    async fn dump_timesync_domain(pool: &Pool<Sqlite>) -> Vec<(Option<String>, i64, i64, String)> {
        sqlx::query(
            "SELECT gm_mid, one_step_mode, fre_switch, disabled_link_seqs FROM timesync_domain \
             WHERE session_id='s1'",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| {
            (
                r.get("gm_mid"),
                r.get("one_step_mode"),
                r.get("fre_switch"),
                r.get("disabled_link_seqs"),
            )
        })
        .collect()
    }

    #[allow(clippy::type_complexity)]
    async fn dump_timesync_nodes(
        pool: &Pool<Sqlite>,
    ) -> Vec<(String, String, String, Option<i64>, Option<i64>)> {
        sqlx::query(
            "SELECT mid, master_port, slave_port, sync_period, offset_threshold FROM timesync_nodes \
             WHERE session_id='s1' ORDER BY mid",
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| {
            (
                r.get("mid"),
                r.get("master_port"),
                r.get("slave_port"),
                r.get("sync_period"),
                r.get("offset_threshold"),
            )
        })
        .collect()
    }

    #[test]
    fn snapshot_then_restore_round_trips_both_tables() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_topology(&pool).await;

            let nodes_before = dump_nodes(&pool).await;
            let links_before = dump_links(&pool).await;

            snapshot(&pool).await;

            // 在快照之后改动两表，模拟一次结构变更。
            sqlx::query("DELETE FROM topology_links WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("UPDATE topology_nodes SET x = 999.0 WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();

            let restored = restore_pre_image(&pool, "s1", TOPOLOGY_DOMAIN)
                .await
                .unwrap();
            assert!(restored);

            assert_eq!(
                dump_nodes(&pool).await,
                nodes_before,
                "节点逐字段还原（含 x/y）"
            );
            assert_eq!(
                dump_links(&pool).await,
                links_before,
                "链路还原（含 styles_json）"
            );
        });
    }

    #[test]
    fn restore_clears_blob_so_second_restore_is_false() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_topology(&pool).await;
            snapshot(&pool).await;

            assert!(
                restore_pre_image(&pool, "s1", TOPOLOGY_DOMAIN)
                    .await
                    .unwrap(),
                "首次有快照"
            );
            assert!(
                !restore_pre_image(&pool, "s1", TOPOLOGY_DOMAIN)
                    .await
                    .unwrap(),
                "撤销后 pre-image 已清除，再撤返 false（R11）"
            );
        });
    }

    #[test]
    fn restore_without_pre_image_is_noop_false() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_topology(&pool).await;

            let nodes_before = dump_nodes(&pool).await;
            let links_before = dump_links(&pool).await;

            assert!(
                !restore_pre_image(&pool, "s1", TOPOLOGY_DOMAIN)
                    .await
                    .unwrap(),
                "无 pre-image 返 false"
            );

            assert_eq!(dump_nodes(&pool).await, nodes_before, "两表不动");
            assert_eq!(dump_links(&pool).await, links_before, "两表不动");
        });
    }

    #[test]
    fn snapshot_is_overwrite_only_keeps_last() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_topology(&pool).await;

            // 第一次快照（含 link l0）。
            snapshot(&pool).await;

            // 改库后第二次快照覆盖前一份（PK 冲突走 UPDATE）。
            sqlx::query("DELETE FROM topology_links WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            snapshot(&pool).await;

            // 只有一行快照。
            let snap_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_undo_snapshots WHERE session_id='s1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(snap_count, 1, "(session_id, domain) 主键只留一份");

            // 还乱动一下三表，restore 应盖回「第二次快照」态（无链路）。
            sqlx::query("INSERT INTO topology_links (session_id, link_seq, src_node, dst_node, styles_json) VALUES ('s1', 7, '0', '1', '{}')")
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                restore_pre_image(&pool, "s1", TOPOLOGY_DOMAIN)
                    .await
                    .unwrap()
            );
            assert!(
                dump_links(&pool).await.is_empty(),
                "盖回最后一次快照（无链路）"
            );
        });
    }

    // ---------- timesync domain ----------

    #[test]
    fn timesync_snapshot_then_restore_round_trips_both_tables() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_timesync(&pool).await;

            let domain_before = dump_timesync_domain(&pool).await;
            let nodes_before = dump_timesync_nodes(&pool).await;

            snapshot_domain(&pool, TIMESYNC_DOMAIN).await;

            // 快照后改 GM、参数、禁用集，模拟一次写。
            sqlx::query("UPDATE timesync_domain SET gm_mid='1', disabled_link_seqs='[]' WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("UPDATE timesync_nodes SET sync_period=512 WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();

            let restored = restore_pre_image(&pool, "s1", TIMESYNC_DOMAIN)
                .await
                .unwrap();
            assert!(restored);

            assert_eq!(
                dump_timesync_domain(&pool).await,
                domain_before,
                "timesync_domain 逐字段还原（含 gm_mid/禁用集）"
            );
            assert_eq!(
                dump_timesync_nodes(&pool).await,
                nodes_before,
                "timesync_nodes 还原（含同步参数）"
            );
        });
    }

    #[test]
    fn timesync_restore_does_not_touch_topology_tables() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            // 先种 topology 数据 + timesync 数据。
            seed_topology(&pool).await;
            seed_timesync(&pool).await;

            let topo_nodes_before = dump_nodes(&pool).await;
            let topo_links_before = dump_links(&pool).await;

            // 只对 timesync 快照 + 改 + 撤销。
            snapshot_domain(&pool, TIMESYNC_DOMAIN).await;
            sqlx::query("UPDATE timesync_domain SET gm_mid='1' WHERE session_id='s1'")
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                restore_pre_image(&pool, "s1", TIMESYNC_DOMAIN)
                    .await
                    .unwrap()
            );

            // topology 两表一行不动（证明 timesync restore 不 DELETE topology 表）。
            assert_eq!(
                dump_nodes(&pool).await,
                topo_nodes_before,
                "timesync 撤销不碰 topology_nodes"
            );
            assert_eq!(
                dump_links(&pool).await,
                topo_links_before,
                "timesync 撤销不碰 topology_links"
            );
        });
    }

    #[test]
    fn domain_snapshots_are_isolated() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_topology(&pool).await;
            seed_timesync(&pool).await;

            // 两 domain 各存一份快照。
            snapshot_domain(&pool, TOPOLOGY_DOMAIN).await;
            snapshot_domain(&pool, TIMESYNC_DOMAIN).await;

            let snap_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM topology_undo_snapshots WHERE session_id='s1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(snap_count, 2, "topology 与 timesync 各一份，互不覆盖");

            // 撤销 timesync 后，topology 快照仍在（撤销 topology 仍返 true）。
            assert!(
                restore_pre_image(&pool, "s1", TIMESYNC_DOMAIN)
                    .await
                    .unwrap()
            );
            assert!(
                restore_pre_image(&pool, "s1", TOPOLOGY_DOMAIN)
                    .await
                    .unwrap(),
                "timesync 撤销不消费 topology 快照"
            );
        });
    }

    #[test]
    fn timesync_restore_without_pre_image_is_noop_false() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_timesync(&pool).await;

            let domain_before = dump_timesync_domain(&pool).await;
            let nodes_before = dump_timesync_nodes(&pool).await;

            assert!(
                !restore_pre_image(&pool, "s1", TIMESYNC_DOMAIN)
                    .await
                    .unwrap(),
                "无 pre-image 返 false"
            );
            assert_eq!(dump_timesync_domain(&pool).await, domain_before, "两表不动");
            assert_eq!(dump_timesync_nodes(&pool).await, nodes_before, "两表不动");
        });
    }

    #[test]
    fn timesync_restore_clears_blob_so_second_restore_is_false() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            seed_timesync(&pool).await;
            snapshot_domain(&pool, TIMESYNC_DOMAIN).await;

            assert!(
                restore_pre_image(&pool, "s1", TIMESYNC_DOMAIN)
                    .await
                    .unwrap(),
                "首次有快照"
            );
            assert!(
                !restore_pre_image(&pool, "s1", TIMESYNC_DOMAIN)
                    .await
                    .unwrap(),
                "撤销后 pre-image 已清除，再撤返 false（R11）"
            );
        });
    }
}
