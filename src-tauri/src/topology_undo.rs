//! 单步撤销核心（纯 Rust，不含 push/emit）。
//!
//! `snapshot_pre_image` 在结构变更前、调用方已开的事务里，把两表
//! （topology_nodes / topology_links）序列化成一份 blob，
//! 按 `(session_id, domain="topology")` 覆盖式写入 `topology_undo_snapshots`。
//! `restore_pre_image` 自开事务，把 blob 盖回两表并清除 pre-image（撤销后
//! 无可再撤——R11）。两面入口（Tauri command / sidecar route）共用此核心，
//! 各自的 push/emit 留在调用点（KTD2）。

use serde::{Deserialize, Serialize};
use sqlx::{Pool, Row, Sqlite, SqliteConnection};

const UNDO_DOMAIN: &str = "topology";

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

/// 写前快照：读三表、序列化成 blob、覆盖式写入 undo 表。
/// 接调用方已开的事务/连接句柄——不自开事务（dry-run rollback 时随事务一并丢弃）。
pub async fn snapshot_pre_image(
    conn: &mut SqliteConnection,
    session_id: &str,
) -> Result<(), sqlx::Error> {
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

    let blob_json = serde_json::to_string(&pre_image).map_err(json_err)?;

    sqlx::query(
        r#"INSERT INTO topology_undo_snapshots (session_id, domain, blob_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, domain)
           DO UPDATE SET blob_json = excluded.blob_json, created_at = excluded.created_at"#,
    )
    .bind(session_id)
    .bind(UNDO_DOMAIN)
    .bind(&blob_json)
    .bind(chrono_like_iso_now())
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// 撤销：读 pre-image（无则 no-op 返 false），自开事务把三表盖回，
/// 清除 pre-image（使再次撤销返 false），commit 后返 true。
pub async fn restore_pre_image(pool: &Pool<Sqlite>, session_id: &str) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let blob: Option<String> = sqlx::query_scalar(
        r#"SELECT blob_json FROM topology_undo_snapshots
           WHERE session_id = ? AND domain = ?"#,
    )
    .bind(session_id)
    .bind(UNDO_DOMAIN)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(blob_json) = blob else {
        // 无快照：不动三表，直接 no-op。
        return Ok(false);
    };

    let pre_image: TopologyPreImage = serde_json::from_str(&blob_json).map_err(json_err)?;

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

    // 撤销后清除 pre-image：再次 restore 返 false（R11「无可撤销」）。
    sqlx::query(r#"DELETE FROM topology_undo_snapshots WHERE session_id = ? AND domain = ?"#)
        .bind(session_id)
        .bind(UNDO_DOMAIN)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(true)
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
        snapshot_pre_image(&mut tx, "s1").await.unwrap();
        tx.commit().await.unwrap();
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

            let restored = restore_pre_image(&pool, "s1").await.unwrap();
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

            assert!(restore_pre_image(&pool, "s1").await.unwrap(), "首次有快照");
            assert!(
                !restore_pre_image(&pool, "s1").await.unwrap(),
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
                !restore_pre_image(&pool, "s1").await.unwrap(),
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
            assert!(restore_pre_image(&pool, "s1").await.unwrap());
            assert!(
                dump_links(&pool).await.is_empty(),
                "盖回最后一次快照（无链路）"
            );
        });
    }
}
