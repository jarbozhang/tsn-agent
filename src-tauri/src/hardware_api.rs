//! tsn-sim HTTP 服务调用器（2026-06-26，U3）。
//!
//! `HardwareApiClient` trait 封装 8 个端点，生产用 `ReqwestHardwareClient`（含连接/读超时，
//! KTD10），命令层泛型注入便于测试（同 `run_timesync_sim_inner<R: RemoteRunner>` 模式）。
//! metrics 走 `serde_json::Value` 原样透传（KTD11——保 snake_case，否则喂坏 echarts）。
//!
//! 无 async-trait crate，用原生 RPITIT（`impl Future + Send`，显式 Send 界满足 tauri 命令）。

use crate::task_request::TaskRequest;
use serde::Deserialize;
use std::future::Future;
use std::time::Duration;

/// 调用失败分类——命令层据此映射成带中文说明的 `Err(String)`。
#[derive(Debug, Clone, PartialEq)]
pub enum HardwareApiError {
    /// 网络 / 超时 / 连接失败。
    Network(String),
    /// 非 2xx + 服务端 error.code/message。
    Server { code: String, message: String },
    /// 响应反序列化失败。
    Decode(String),
}

impl std::fmt::Display for HardwareApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HardwareApiError::Network(m) => write!(f, "连接硬件服务失败：{m}"),
            HardwareApiError::Server { code, message } => {
                write!(f, "硬件服务返回错误（{code}）：{message}")
            }
            HardwareApiError::Decode(m) => write!(f, "解析硬件服务响应失败：{m}"),
        }
    }
}

// ---------- 响应结构（按 API 文档出参建模；未消费字段 serde 自动忽略）----------

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct HealthzResp {
    pub status: String,
}

// 注：`/sim/version` 由 U9 e2e 脚本（scripts/verify-hardware-api.mjs）直连查，Rust 客户端不消费，
// 故此处不建 VersionResp、trait 不含 version 方法（YAGNI）。

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Avail {
    pub available: bool,
    pub reason: Option<String>,
}

/// task_check：只消费 hardware.available/reason（KTD——simulation 字段忽略）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TaskCheckResp {
    pub hardware: Avail,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ValidateIssue {
    pub severity: String,
    pub category: Option<String>,
    pub code: Option<String>,
    pub message: String,
    pub location: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TaskValidateResp {
    pub verdict: String,
    pub summary: Option<String>,
    pub task_start_compatible: bool,
    pub ready: bool,
    #[serde(default)]
    pub issues: Vec<ValidateIssue>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TaskStartResp {
    pub task_id: String,
    pub status: String,
    pub accepted: bool,
}

/// task_query / task_stop 共用形状（API 文档：task_stop 出参同 task_query）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TaskQueryResp {
    pub status: String,
    pub verdict: Option<String>,
    pub summary: Option<String>,
}

// ---------- trait + 真实现 ----------

pub trait HardwareApiClient {
    fn healthz(
        &self,
        base_url: &str,
    ) -> impl Future<Output = Result<HealthzResp, HardwareApiError>> + Send;
    fn task_check(
        &self,
        base_url: &str,
    ) -> impl Future<Output = Result<TaskCheckResp, HardwareApiError>> + Send;
    fn task_validate(
        &self,
        base_url: &str,
        req: &TaskRequest,
    ) -> impl Future<Output = Result<TaskValidateResp, HardwareApiError>> + Send;
    fn task_start(
        &self,
        base_url: &str,
        req: &TaskRequest,
    ) -> impl Future<Output = Result<TaskStartResp, HardwareApiError>> + Send;
    fn task_query(
        &self,
        base_url: &str,
        task_id: &str,
    ) -> impl Future<Output = Result<TaskQueryResp, HardwareApiError>> + Send;
    /// 原样透传 series（snake_case 不改写，KTD11）。
    fn task_metrics_query(
        &self,
        base_url: &str,
        task_id: &str,
    ) -> impl Future<Output = Result<serde_json::Value, HardwareApiError>> + Send;
    fn task_stop(
        &self,
        base_url: &str,
        task_id: &str,
    ) -> impl Future<Output = Result<TaskQueryResp, HardwareApiError>> + Send;
}

/// 生产实现：reqwest，连接超时 10s / 读超时 30s（KTD10）。
pub struct ReqwestHardwareClient {
    client: reqwest::Client,
}

impl Default for ReqwestHardwareClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ReqwestHardwareClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("构建 reqwest client 失败");
        Self { client }
    }
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}/sim/{}", base_url.trim_end_matches('/'), path)
}

#[derive(Deserialize)]
struct ApiErrorEnvelope {
    error: ApiErrorBody,
}
#[derive(Deserialize)]
struct ApiErrorBody {
    code: String,
    message: String,
}

/// 统一处理响应：非 2xx 取 error.code/message，2xx 反序列化成 T。
async fn parse_json<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, HardwareApiError> {
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| HardwareApiError::Network(e.to_string()))?;
    if !status.is_success() {
        if let Ok(env) = serde_json::from_slice::<ApiErrorEnvelope>(&bytes) {
            return Err(HardwareApiError::Server {
                code: env.error.code,
                message: env.error.message,
            });
        }
        return Err(HardwareApiError::Server {
            code: status.as_u16().to_string(),
            message: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
    serde_json::from_slice::<T>(&bytes).map_err(|e| HardwareApiError::Decode(e.to_string()))
}

impl HardwareApiClient for ReqwestHardwareClient {
    async fn healthz(&self, base_url: &str) -> Result<HealthzResp, HardwareApiError> {
        let resp = self
            .client
            .get(endpoint(base_url, "healthz"))
            .send()
            .await
            .map_err(|e| HardwareApiError::Network(e.to_string()))?;
        parse_json(resp).await
    }

    async fn task_check(&self, base_url: &str) -> Result<TaskCheckResp, HardwareApiError> {
        let resp = self
            .client
            .post(endpoint(base_url, "task_check"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| HardwareApiError::Network(e.to_string()))?;
        parse_json(resp).await
    }

    async fn task_validate(
        &self,
        base_url: &str,
        req: &TaskRequest,
    ) -> Result<TaskValidateResp, HardwareApiError> {
        let resp = self
            .client
            .post(endpoint(base_url, "task_validate"))
            .json(req)
            .send()
            .await
            .map_err(|e| HardwareApiError::Network(e.to_string()))?;
        parse_json(resp).await
    }

    async fn task_start(
        &self,
        base_url: &str,
        req: &TaskRequest,
    ) -> Result<TaskStartResp, HardwareApiError> {
        let resp = self
            .client
            .post(endpoint(base_url, "task_start"))
            .json(req)
            .send()
            .await
            .map_err(|e| HardwareApiError::Network(e.to_string()))?;
        parse_json(resp).await
    }

    async fn task_query(
        &self,
        base_url: &str,
        task_id: &str,
    ) -> Result<TaskQueryResp, HardwareApiError> {
        let resp = self
            .client
            .post(endpoint(base_url, "task_query"))
            .json(&serde_json::json!({ "task_id": task_id }))
            .send()
            .await
            .map_err(|e| HardwareApiError::Network(e.to_string()))?;
        parse_json(resp).await
    }

    async fn task_metrics_query(
        &self,
        base_url: &str,
        task_id: &str,
    ) -> Result<serde_json::Value, HardwareApiError> {
        let resp = self
            .client
            .post(endpoint(base_url, "task_metrics_query"))
            .json(&serde_json::json!({
                "task_id": task_id,
                "source": "hardware",
                "mode": "series",
                "bucket": "1s",
                "only_synced": false,
            }))
            .send()
            .await
            .map_err(|e| HardwareApiError::Network(e.to_string()))?;
        parse_json(resp).await
    }

    async fn task_stop(
        &self,
        base_url: &str,
        task_id: &str,
    ) -> Result<TaskQueryResp, HardwareApiError> {
        let resp = self
            .client
            .post(endpoint(base_url, "task_stop"))
            .json(&serde_json::json!({ "task_id": task_id }))
            .send()
            .await
            .map_err(|e| HardwareApiError::Network(e.to_string()))?;
        parse_json(resp).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_joins_and_trims_trailing_slash() {
        assert_eq!(
            endpoint("http://h:19080", "healthz"),
            "http://h:19080/sim/healthz"
        );
        assert_eq!(
            endpoint("http://h:19080/", "task_check"),
            "http://h:19080/sim/task_check"
        );
    }

    #[test]
    fn task_check_resp_deserializes_hardware_only_ignores_simulation() {
        let raw = r#"{"status":"ok","simulation":{"available":true,"reason":null},"hardware":{"available":false,"reason":"无设备"}}"#;
        let resp: TaskCheckResp = serde_json::from_str(raw).unwrap();
        assert!(!resp.hardware.available);
        assert_eq!(resp.hardware.reason.as_deref(), Some("无设备"));
    }

    #[test]
    fn validate_resp_carries_issues() {
        let raw = r#"{"verdict":"FAIL","summary":"s","task_start_compatible":false,"ready":false,"counts":{},"issues":[{"severity":"ERROR","category":"param","code":"bad_sync","message":"sync_period 不支持","location":null}]}"#;
        let resp: TaskValidateResp = serde_json::from_str(raw).unwrap();
        assert_eq!(resp.verdict, "FAIL");
        assert!(!resp.ready);
        assert_eq!(resp.issues.len(), 1);
        assert_eq!(resp.issues[0].message, "sync_period 不支持");
    }

    #[test]
    fn validate_resp_missing_issues_defaults_empty() {
        let raw = r#"{"verdict":"PASS","summary":"ok","task_start_compatible":true,"ready":true,"counts":{}}"#;
        let resp: TaskValidateResp = serde_json::from_str(raw).unwrap();
        assert!(resp.issues.is_empty());
    }

    #[test]
    fn error_envelope_maps_to_server_error() {
        // parse_json 的非 2xx 分支用同样的 envelope 反序列化。
        let raw = r#"{"error":{"code":"queue_full","message":"队列满"}}"#;
        let env: ApiErrorEnvelope = serde_json::from_str(raw).unwrap();
        assert_eq!(env.error.code, "queue_full");
        assert_eq!(env.error.message, "队列满");
    }

    #[test]
    fn error_display_is_chinese() {
        let e = HardwareApiError::Server {
            code: "queue_full".into(),
            message: "队列满".into(),
        };
        assert!(e.to_string().contains("硬件服务返回错误"));
    }
}
