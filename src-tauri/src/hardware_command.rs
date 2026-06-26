//! 硬件部署命令层（2026-06-26，U5）：把 U1-U4 编排成前端可调的 5 个 Tauri 命令。
//!
//! check / start（含 validate）/ query / metrics / stop。每个命令 resolve 配置 + 取 pool 后，
//! 调泛型 inner（注入 `HardwareApiClient`，便于测试）。生产注入 `ReqwestHardwareClient`。
//!
//! 出参 camelCase（前端 IPC 契约），**例外** `hardware_metrics`：原样透传 `serde_json::Value`
//! 的 snake_case series（KTD11，否则喂坏 echarts）。错误返回带中文说明的 `Err(String)`。

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::hardware_api::{HardwareApiClient, ReqwestHardwareClient, TaskValidateResp};
use crate::hardware_api_config::resolve_hardware_api_url;
use crate::task_request::build_task_request;
use crate::task_store::{TaskRow, insert_task, latest_task};

/// 默认硬件测试时长（秒）——前端未指定时用（与软仿 60s 口径一致）。
const DEFAULT_HARDWARE_DURATION_S: i64 = 60;

// ---------- 出参结构（camelCase IPC）----------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareCheckResult {
    pub healthz_ok: bool,
    pub hardware_available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueOut {
    pub severity: String,
    pub category: Option<String>,
    pub code: Option<String>,
    pub message: String,
    pub location: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidateOut {
    pub verdict: String,
    pub summary: Option<String>,
    pub ready: bool,
    pub task_start_compatible: bool,
    pub issues: Vec<IssueOut>,
}

impl From<TaskValidateResp> for ValidateOut {
    fn from(r: TaskValidateResp) -> Self {
        ValidateOut {
            verdict: r.verdict,
            summary: r.summary,
            ready: r.ready,
            task_start_compatible: r.task_start_compatible,
            issues: r
                .issues
                .into_iter()
                .map(|i| IssueOut {
                    severity: i.severity,
                    category: i.category,
                    code: i.code,
                    message: i.message,
                    location: i.location,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartOut {
    pub status: String,
    pub accepted: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareStartResult {
    pub task_id: String,
    pub validate: ValidateOut,
    /// 启动门未过（ready && task_start_compatible 不满足）时为 None。
    pub start: Option<StartOut>,
}

/// task_query / task_stop 共用出参（status + 裁决/摘要）。
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusOut {
    pub status: String,
    pub verdict: Option<String>,
    pub summary: Option<String>,
}

// ---------- 入参 ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareStartRequest {
    pub session_id: String,
    /// 硬件测试时长（秒）；缺省走默认。
    pub duration_s: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    pub session_id: String,
}

/// 生成 task_id：`hw-<session_id 前 8 位>-<unix 毫秒>`（毫秒避免同秒撞 PK，KTD4）。
fn gen_task_id(session_id: &str) -> String {
    let prefix: String = session_id.chars().take(8).collect();
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("hw-{prefix}-{millis}")
}

// ---------- 命令 + 泛型 inner ----------

/// 探活 + 环境检查：healthz → task_check（只看 hardware.available）。
#[tauri::command]
pub async fn hardware_check(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
) -> Result<HardwareCheckResult, String> {
    let pool = store.pool(&app).await?;
    let base_url = resolve_hardware_api_url(pool).await?;
    hardware_check_inner(&ReqwestHardwareClient::new(), &base_url).await
}

async fn hardware_check_inner<C: HardwareApiClient>(
    client: &C,
    base_url: &str,
) -> Result<HardwareCheckResult, String> {
    client.healthz(base_url).await.map_err(|e| e.to_string())?;
    let check = client
        .task_check(base_url)
        .await
        .map_err(|e| e.to_string())?;
    Ok(HardwareCheckResult {
        healthz_ok: true,
        hardware_available: check.hardware.available,
        reason: check.hardware.reason,
    })
}

/// 启动：生成 task_id → insert task 行 → build 请求体 → validate → 门过则 start。
#[tauri::command]
pub async fn hardware_start(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: HardwareStartRequest,
) -> Result<HardwareStartResult, String> {
    let pool = store.pool(&app).await?;
    let base_url = resolve_hardware_api_url(pool).await?;
    let duration = request.duration_s.unwrap_or(DEFAULT_HARDWARE_DURATION_S);
    hardware_start_inner(
        pool,
        &ReqwestHardwareClient::new(),
        &base_url,
        &request.session_id,
        duration,
    )
    .await
}

async fn hardware_start_inner<C: HardwareApiClient>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    client: &C,
    base_url: &str,
    session_id: &str,
    duration: i64,
) -> Result<HardwareStartResult, String> {
    let task_id = gen_task_id(session_id);
    insert_task(pool, session_id, &task_id, duration, "hardware")
        .await
        .map_err(|e| format!("写入任务记录失败（可能同会话重复启动）：{e}"))?;

    let task_row = TaskRow {
        task_id: task_id.clone(),
        duration,
        task_type: "hardware".to_string(),
        created_at: String::new(),
    };
    let req = build_task_request(pool, session_id, &task_row)
        .await
        .map_err(|e| format!("组装任务请求失败：{e}"))?;

    let validate = client
        .task_validate(base_url, &req)
        .await
        .map_err(|e| e.to_string())?;
    // 启动门：ready（满足本次 type 启动前条件）且 task_start_compatible（满足 task_start 条件）。
    let gate = validate.ready && validate.task_start_compatible;
    let validate_out: ValidateOut = validate.into();

    if !gate {
        return Ok(HardwareStartResult {
            task_id,
            validate: validate_out,
            start: None,
        });
    }

    let start = client
        .task_start(base_url, &req)
        .await
        .map_err(|e| e.to_string())?;
    Ok(HardwareStartResult {
        task_id,
        validate: validate_out,
        start: Some(StartOut {
            status: start.status,
            accepted: start.accepted,
        }),
    })
}

/// 查询：取会话最新 task → task_query 一次（前端 confirming + observing 5s 探终态共用）。
#[tauri::command]
pub async fn hardware_query(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: SessionRequest,
) -> Result<TaskStatusOut, String> {
    let pool = store.pool(&app).await?;
    let base_url = resolve_hardware_api_url(pool).await?;
    hardware_query_inner(
        pool,
        &ReqwestHardwareClient::new(),
        &base_url,
        &request.session_id,
    )
    .await
}

async fn hardware_query_inner<C: HardwareApiClient>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    client: &C,
    base_url: &str,
    session_id: &str,
) -> Result<TaskStatusOut, String> {
    let task = require_latest_task(pool, session_id).await?;
    let q = client
        .task_query(base_url, &task.task_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TaskStatusOut {
        status: q.status,
        verdict: q.verdict,
        summary: q.summary,
    })
}

/// 实时指标：取会话最新 task → task_metrics_query（series），原样透传 snake_case（KTD11）。
#[tauri::command]
pub async fn hardware_metrics(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: SessionRequest,
) -> Result<serde_json::Value, String> {
    let pool = store.pool(&app).await?;
    let base_url = resolve_hardware_api_url(pool).await?;
    hardware_metrics_inner(
        pool,
        &ReqwestHardwareClient::new(),
        &base_url,
        &request.session_id,
    )
    .await
}

async fn hardware_metrics_inner<C: HardwareApiClient>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    client: &C,
    base_url: &str,
    session_id: &str,
) -> Result<serde_json::Value, String> {
    let task = require_latest_task(pool, session_id).await?;
    client
        .task_metrics_query(base_url, &task.task_id)
        .await
        .map_err(|e| e.to_string())
}

/// 停止：取会话最新 task → task_stop，**按返回 status 带回**（可能 stopped/done/failed/timeout）。
#[tauri::command]
pub async fn hardware_stop(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::session_store::SessionStore>,
    request: SessionRequest,
) -> Result<TaskStatusOut, String> {
    let pool = store.pool(&app).await?;
    let base_url = resolve_hardware_api_url(pool).await?;
    hardware_stop_inner(
        pool,
        &ReqwestHardwareClient::new(),
        &base_url,
        &request.session_id,
    )
    .await
}

async fn hardware_stop_inner<C: HardwareApiClient>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    client: &C,
    base_url: &str,
    session_id: &str,
) -> Result<TaskStatusOut, String> {
    let task = require_latest_task(pool, session_id).await?;
    let s = client
        .task_stop(base_url, &task.task_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TaskStatusOut {
        status: s.status,
        verdict: s.verdict,
        summary: s.summary,
    })
}

async fn require_latest_task(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<TaskRow, String> {
    latest_task(pool, session_id)
        .await
        .map_err(|e| format!("读取任务记录失败：{e}"))?
        .ok_or_else(|| "当前会话还没有硬件部署任务。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware_api::{
        Avail, HardwareApiError, HealthzResp, TaskCheckResp, TaskQueryResp, TaskStartResp,
        TaskValidateResp,
    };
    use crate::task_request::TaskRequest;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// 本文件局部 fake（cfg(test) 类型不能跨文件引用，故 hardware_api.rs 与本文件各自定义）。
    #[derive(Clone)]
    struct FakeClient {
        check: TaskCheckResp,
        validate: TaskValidateResp,
        start: TaskStartResp,
        query: TaskQueryResp,
        stop: TaskQueryResp,
        metrics: serde_json::Value,
    }

    impl Default for FakeClient {
        fn default() -> Self {
            FakeClient {
                check: TaskCheckResp {
                    hardware: Avail {
                        available: true,
                        reason: None,
                    },
                },
                validate: TaskValidateResp {
                    verdict: "PASS".into(),
                    summary: Some("ok".into()),
                    task_start_compatible: true,
                    ready: true,
                    issues: vec![],
                },
                start: TaskStartResp {
                    task_id: "x".into(),
                    status: "queued".into(),
                    accepted: true,
                },
                query: TaskQueryResp {
                    status: "running".into(),
                    verdict: None,
                    summary: None,
                },
                stop: TaskQueryResp {
                    status: "stopped".into(),
                    verdict: None,
                    summary: None,
                },
                metrics: serde_json::json!({
                    "series": [{ "points": [{ "node_id": "2", "latest_offset_ns": 12 }] }]
                }),
            }
        }
    }

    impl HardwareApiClient for FakeClient {
        async fn healthz(&self, _b: &str) -> Result<HealthzResp, HardwareApiError> {
            Ok(HealthzResp {
                status: "ok".into(),
            })
        }
        async fn task_check(&self, _b: &str) -> Result<TaskCheckResp, HardwareApiError> {
            Ok(self.check.clone())
        }
        async fn task_validate(
            &self,
            _b: &str,
            _r: &TaskRequest,
        ) -> Result<TaskValidateResp, HardwareApiError> {
            Ok(self.validate.clone())
        }
        async fn task_start(
            &self,
            _b: &str,
            _r: &TaskRequest,
        ) -> Result<TaskStartResp, HardwareApiError> {
            Ok(self.start.clone())
        }
        async fn task_query(&self, _b: &str, _t: &str) -> Result<TaskQueryResp, HardwareApiError> {
            Ok(self.query.clone())
        }
        async fn task_metrics_query(
            &self,
            _b: &str,
            _t: &str,
        ) -> Result<serde_json::Value, HardwareApiError> {
            Ok(self.metrics.clone())
        }
        async fn task_stop(&self, _b: &str, _t: &str) -> Result<TaskQueryResp, HardwareApiError> {
            Ok(self.stop.clone())
        }
    }

    async fn seeded_pool() -> sqlx::Pool<sqlx::Sqlite> {
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
        crate::db::ensure_task_table(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO sessions (id, title, created_at, updated_at, payload) \
             VALUES ('s1','t','now','now','{}')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // 最小拓扑 + 时钟树，让 build_task_request 有数据。
        sqlx::query("INSERT INTO topology_nodes (session_id, mid, name, x, y, node_type, port_count, queue_count, insert_order) VALUES ('s1','0','SW',0,0,'switch',8,8,0)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO timesync_domain (session_id, gm_mid, one_step_mode, fre_switch, disabled_link_seqs) VALUES ('s1','0',0,0,'[]')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO timesync_nodes (session_id, mid, master_port, slave_port, port_ptp_enabled, sync_period, measure_period, report_enable, mean_link_delay_thresh, offset_threshold) VALUES ('s1','0','[0]','[]','[0]',128,1024,1,64,1000)").execute(&pool).await.unwrap();
        pool
    }

    #[test]
    fn gen_task_id_matches_api_regex() {
        let id = gen_task_id("a7f06ff1-2222-3333");
        assert!(id.starts_with("hw-a7f06ff1-"));
        // 仅 [A-Za-z0-9_.:-]，首字符字母数字。
        assert!(id.chars().next().unwrap().is_ascii_alphanumeric());
        assert!(
            id.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
        );
    }

    #[tokio::test]
    async fn check_available() {
        let pool = seeded_pool().await;
        let _ = pool;
        let res = hardware_check_inner(&FakeClient::default(), "http://x")
            .await
            .unwrap();
        assert!(res.healthz_ok);
        assert!(res.hardware_available);
    }

    #[tokio::test]
    async fn check_unavailable_returns_reason() {
        let mut fake = FakeClient::default();
        fake.check = TaskCheckResp {
            hardware: Avail {
                available: false,
                reason: Some("无设备".into()),
            },
        };
        let res = hardware_check_inner(&fake, "http://x").await.unwrap();
        assert!(!res.hardware_available);
        assert_eq!(res.reason.as_deref(), Some("无设备"));
    }

    #[tokio::test]
    async fn start_validate_pass_inserts_and_starts() {
        let pool = seeded_pool().await;
        let res = hardware_start_inner(&pool, &FakeClient::default(), "http://x", "s1", 60)
            .await
            .unwrap();
        assert!(res.start.is_some());
        assert!(res.start.unwrap().accepted);
        // 行落库（type=hardware）。
        let row = latest_task(&pool, "s1").await.unwrap().unwrap();
        assert_eq!(row.task_id, res.task_id);
        assert_eq!(row.task_type, "hardware");
    }

    #[tokio::test]
    async fn start_validate_fail_does_not_start() {
        let pool = seeded_pool().await;
        let mut fake = FakeClient::default();
        fake.validate = TaskValidateResp {
            verdict: "FAIL".into(),
            summary: Some("bad".into()),
            task_start_compatible: false,
            ready: false,
            issues: vec![crate::hardware_api::ValidateIssue {
                severity: "ERROR".into(),
                category: None,
                code: Some("bad_sync".into()),
                message: "sync_period 不支持".into(),
                location: None,
            }],
        };
        let res = hardware_start_inner(&pool, &fake, "http://x", "s1", 60)
            .await
            .unwrap();
        assert!(res.start.is_none());
        assert_eq!(res.validate.issues.len(), 1);
    }

    #[tokio::test]
    async fn start_ready_but_not_compatible_does_not_start() {
        let pool = seeded_pool().await;
        let mut fake = FakeClient::default();
        fake.validate.ready = true;
        fake.validate.task_start_compatible = false;
        let res = hardware_start_inner(&pool, &fake, "http://x", "s1", 60)
            .await
            .unwrap();
        assert!(res.start.is_none());
    }

    #[tokio::test]
    async fn metrics_passthrough_keeps_snake_case() {
        let pool = seeded_pool().await;
        // 先建一个 task 行（metrics 取 latest）。
        hardware_start_inner(&pool, &FakeClient::default(), "http://x", "s1", 60)
            .await
            .unwrap();
        let v = hardware_metrics_inner(&pool, &FakeClient::default(), "http://x", "s1")
            .await
            .unwrap();
        // snake_case 字段名原样保留（没被改写成 camelCase）。
        assert!(v["series"][0]["points"][0]["latest_offset_ns"].is_number());
        assert!(v["series"][0]["points"][0].get("latestOffsetNs").is_none());
    }

    #[tokio::test]
    async fn stop_returns_done_when_task_finished() {
        let pool = seeded_pool().await;
        hardware_start_inner(&pool, &FakeClient::default(), "http://x", "s1", 60)
            .await
            .unwrap();
        let mut fake = FakeClient::default();
        fake.stop = TaskQueryResp {
            status: "done".into(),
            verdict: Some("PASS".into()),
            summary: None,
        };
        let res = hardware_stop_inner(&pool, &fake, "http://x", "s1")
            .await
            .unwrap();
        // 任务恰好跑完 → 带回 done，不硬编码 stopped。
        assert_eq!(res.status, "done");
    }

    #[tokio::test]
    async fn metrics_without_task_errors() {
        let pool = seeded_pool().await;
        let err = hardware_metrics_inner(&pool, &FakeClient::default(), "http://x", "s1")
            .await
            .unwrap_err();
        assert!(err.contains("还没有硬件部署任务"));
    }
}
