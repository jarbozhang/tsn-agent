//! DB → tsn-sim 任务请求体序列化（2026-06-26，U2）。
//!
//! 把会话的拓扑 + 时钟树数据组装成发往 tsn-sim HTTP 服务的「任务请求体」JSON。
//! 字段全 snake_case（外部服务契约，**不同于** 前端 camelCase IPC）。
//!
//! 不复用软仿 `load_topology`/`load_timing`（它们只读子集，缺 mac/ip/port_count/
//! queue_count 与 port_ptp_enabled/report_enable/mean_link_delay_thresh）——本模块新写
//! 读全列 SQL（列同 `timesync_sidecar_routes.rs` 已读的那批）。
//!
//! 映射要点（KTD5）：`task.type` ← `task` 行 `type` 列（hardware）；`task.scope` 固定常量
//! `time_sync`（不来自表）；`offset_ns_max` 不传（字段不定义）。

use crate::task_store::TaskRow;
use serde::Serialize;
use sqlx::{Pool, Row, Sqlite};

/// tsn-sim 任务请求体（发往外部服务的完整 JSON）。
#[derive(Debug, Serialize, PartialEq)]
pub struct TaskRequest {
    pub task: TaskMeta,
    pub topology_nodes: Vec<TopologyNode>,
    pub topology_links: Vec<TopologyLink>,
    pub timesync_domain: Vec<TimesyncDomain>,
    pub timesync_nodes: Vec<TimesyncNode>,
}

/// `task` 段。`offset_ns_max` 故意不定义（不序列化）；`scope` 固定 `time_sync`。
#[derive(Debug, Serialize, PartialEq)]
pub struct TaskMeta {
    pub task_id: String,
    pub scope: String,
    #[serde(rename = "type")]
    pub task_type: String,
    pub duration: i64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TopologyNode {
    pub mid: String,
    pub node_type: Option<String>,
    pub mac: Option<String>,
    pub ip: Option<String>,
    pub port_count: i64,
    pub queue_count: i64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TopologyLink {
    pub src_node: String,
    pub dst_node: String,
    pub src_port: Option<i64>,
    pub dst_port: Option<i64>,
    pub speed: Option<i64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TimesyncDomain {
    pub gm_mid: Option<String>,
    pub one_step_mode: i64,
    pub fre_switch: i64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TimesyncNode {
    pub mid: String,
    pub master_port: Vec<i64>,
    pub slave_port: Vec<i64>,
    pub port_ptp_enabled: Vec<i64>,
    pub sync_period: Option<i64>,
    pub measure_period: Option<i64>,
    pub report_enable: Option<i64>,
    pub mean_link_delay_thresh: Option<i64>,
    pub offset_threshold: Option<i64>,
}

/// 库里端口数组以 JSON 字符串存（`"[0,1]"`），API 要求真数组——解析成 `Vec<i64>`，
/// 残缺/空串回退空数组（同软仿 `parse_i64_array`）。
fn parse_port_array(json: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(json).unwrap_or_default()
}

/// 读全列组装请求体。`task.type` ← 行 `type` 列；`task.scope` = 常量 `time_sync`。
pub async fn build_task_request(
    pool: &Pool<Sqlite>,
    session_id: &str,
    task_row: &TaskRow,
) -> Result<TaskRequest, sqlx::Error> {
    // 拓扑节点：mid/node_type/mac/ip/port_count/queue_count（顺序按 insert_order，稳定）。
    let node_rows = sqlx::query(
        "SELECT mid, node_type, mac, ip, port_count, queue_count \
         FROM topology_nodes WHERE session_id = ? ORDER BY insert_order, mid",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let topology_nodes = node_rows
        .iter()
        .map(|r| TopologyNode {
            mid: r.get("mid"),
            node_type: r.get("node_type"),
            mac: r.get("mac"),
            ip: r.get("ip"),
            port_count: r.get("port_count"),
            queue_count: r.get("queue_count"),
        })
        .collect();

    // 拓扑链路：src/dst_node、src/dst_port、speed（顺序按 link_seq）。
    let link_rows = sqlx::query(
        "SELECT src_node, dst_node, src_port, dst_port, speed \
         FROM topology_links WHERE session_id = ? ORDER BY link_seq",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let topology_links = link_rows
        .iter()
        .map(|r| TopologyLink {
            src_node: r.get("src_node"),
            dst_node: r.get("dst_node"),
            src_port: r.get("src_port"),
            dst_port: r.get("dst_port"),
            speed: r.get("speed"),
        })
        .collect();

    // 时钟域：单行（一会话一行）。无行 → 单个 gm_mid=None 的元素（结构在、validate 兜底）。
    let domain_row = sqlx::query(
        "SELECT gm_mid, one_step_mode, fre_switch \
         FROM timesync_domain WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    let timesync_domain = vec![match domain_row {
        Some(r) => TimesyncDomain {
            gm_mid: r.get("gm_mid"),
            one_step_mode: r.get("one_step_mode"),
            fre_switch: r.get("fre_switch"),
        },
        None => TimesyncDomain {
            gm_mid: None,
            one_step_mode: 0,
            fre_switch: 0,
        },
    }];

    // 时钟节点：端口角色数组（JSON 串 → Vec<i64>）+ 同步参数全列。
    let timing_rows = sqlx::query(
        "SELECT mid, master_port, slave_port, port_ptp_enabled, \
                sync_period, measure_period, report_enable, \
                mean_link_delay_thresh, offset_threshold \
         FROM timesync_nodes WHERE session_id = ? ORDER BY mid",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let timesync_nodes = timing_rows
        .iter()
        .map(|r| TimesyncNode {
            mid: r.get("mid"),
            master_port: parse_port_array(&r.get::<String, _>("master_port")),
            slave_port: parse_port_array(&r.get::<String, _>("slave_port")),
            port_ptp_enabled: parse_port_array(&r.get::<String, _>("port_ptp_enabled")),
            sync_period: r.get("sync_period"),
            measure_period: r.get("measure_period"),
            report_enable: r.get("report_enable"),
            mean_link_delay_thresh: r.get("mean_link_delay_thresh"),
            offset_threshold: r.get("offset_threshold"),
        })
        .collect();

    Ok(TaskRequest {
        task: TaskMeta {
            task_id: task_row.task_id.clone(),
            scope: "time_sync".to_string(),
            task_type: task_row.task_type.clone(),
            duration: task_row.duration,
        },
        topology_nodes,
        topology_links,
        timesync_domain,
        timesync_nodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// 内存 pool + 全 schema（safety-net 建所有 P0 表）+ 一行 session。
    async fn fixture_pool() -> Pool<Sqlite> {
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

    async fn seed_minimal(pool: &Pool<Sqlite>) {
        // 一个 switch（端口角色全 master）+ 一个 endSystem（slave）。
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, mac, ip, port_count, queue_count, insert_order) \
             VALUES ('s1','0','SW-1',0,0,'switch','02:00:00:00:00:00','10.0.0.1',8,8,0)",
        ).execute(pool).await.unwrap();
        // mac/ip 留 NULL，验序列化成 null。
        sqlx::query(
            "INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) \
             VALUES ('s1','2','ES-1',0,0,'endSystem',2,8,1)",
        ).execute(pool).await.unwrap();
        sqlx::query(
            "INSERT INTO topology_links (session_id, link_seq, src_node, dst_node, src_port, dst_port, speed, styles_json) \
             VALUES ('s1',0,'2','0',0,0,1000,'{}')",
        ).execute(pool).await.unwrap();
        sqlx::query(
            "INSERT INTO timesync_domain (session_id, gm_mid, one_step_mode, fre_switch, disabled_link_seqs) \
             VALUES ('s1','0',0,1,'[]')",
        ).execute(pool).await.unwrap();
        sqlx::query(
            "INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port, port_ptp_enabled, sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold) \
             VALUES ('s1','0','[0,1]','[]','[0,1]',128,1024,1,64,1000)",
        ).execute(pool).await.unwrap();
        sqlx::query(
            "INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port, port_ptp_enabled, sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold) \
             VALUES ('s1','2','[]','[0]','[0]',128,1024,1,64,1000)",
        ).execute(pool).await.unwrap();
    }

    fn hw_task() -> TaskRow {
        TaskRow {
            task_id: "hw-s1-123".into(),
            duration: 60,
            task_type: "hardware".into(),
            created_at: "now".into(),
        }
    }

    #[tokio::test]
    async fn builds_full_request_with_task_meta() {
        let pool = fixture_pool().await;
        seed_minimal(&pool).await;
        let req = build_task_request(&pool, "s1", &hw_task()).await.unwrap();
        let v = serde_json::to_value(&req).unwrap();
        // 5 段都在。
        for k in [
            "task",
            "topology_nodes",
            "topology_links",
            "timesync_domain",
            "timesync_nodes",
        ] {
            assert!(v.get(k).is_some(), "缺段 {k}");
        }
        // task.type=hardware（来自 type 列）、scope=time_sync（常量）、无 offset_ns_max。
        assert_eq!(v["task"]["type"], "hardware");
        assert_eq!(v["task"]["scope"], "time_sync");
        assert_eq!(v["task"]["duration"], 60);
        assert!(v["task"].get("offset_ns_max").is_none());
    }

    #[tokio::test]
    async fn includes_api_required_fields() {
        let pool = fixture_pool().await;
        seed_minimal(&pool).await;
        let req = build_task_request(&pool, "s1", &hw_task()).await.unwrap();
        let v = serde_json::to_value(&req).unwrap();
        // 必填字段齐全（核心「读全列」保护）。
        let node0 = &v["topology_nodes"][0];
        assert_eq!(node0["port_count"], 8);
        assert_eq!(node0["queue_count"], 8);
        let tnode0 = &v["timesync_nodes"][0];
        assert!(tnode0.get("port_ptp_enabled").is_some());
        assert_eq!(tnode0["report_enable"], 1);
        assert_eq!(tnode0["mean_link_delay_thresh"], 64);
    }

    #[tokio::test]
    async fn port_arrays_become_real_arrays() {
        let pool = fixture_pool().await;
        seed_minimal(&pool).await;
        let req = build_task_request(&pool, "s1", &hw_task()).await.unwrap();
        assert_eq!(req.timesync_nodes[0].master_port, vec![0, 1]);
        assert_eq!(req.timesync_nodes[0].slave_port, Vec::<i64>::new());
        assert_eq!(req.timesync_nodes[0].port_ptp_enabled, vec![0, 1]);
        assert_eq!(req.timesync_nodes[1].slave_port, vec![0]);
    }

    #[tokio::test]
    async fn domain_carries_gm_and_flags() {
        let pool = fixture_pool().await;
        seed_minimal(&pool).await;
        let req = build_task_request(&pool, "s1", &hw_task()).await.unwrap();
        assert_eq!(req.timesync_domain.len(), 1);
        assert_eq!(req.timesync_domain[0].gm_mid.as_deref(), Some("0"));
        assert_eq!(req.timesync_domain[0].one_step_mode, 0);
        assert_eq!(req.timesync_domain[0].fre_switch, 1);
    }

    #[tokio::test]
    async fn missing_mac_ip_serialize_as_null() {
        let pool = fixture_pool().await;
        seed_minimal(&pool).await;
        let req = build_task_request(&pool, "s1", &hw_task()).await.unwrap();
        let v = serde_json::to_value(&req).unwrap();
        // 第二个节点（ES-1）mac/ip 留 NULL。
        assert!(v["topology_nodes"][1]["mac"].is_null());
        assert!(v["topology_nodes"][1]["ip"].is_null());
    }

    #[tokio::test]
    async fn node_and_link_order_stable() {
        let pool = fixture_pool().await;
        seed_minimal(&pool).await;
        let req = build_task_request(&pool, "s1", &hw_task()).await.unwrap();
        // 节点按 insert_order：SW-1(mid 0) 在前、ES-1(mid 2) 在后。
        assert_eq!(req.topology_nodes[0].mid, "0");
        assert_eq!(req.topology_nodes[1].mid, "2");
    }
}
