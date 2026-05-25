use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerCommandRequest {
    base_url: String,
    payload: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlannerServiceEnvelope {
    err_code: i64,
    err_msg: String,
    data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
}

#[tauri::command]
pub async fn planner_start_plan(
    request: PlannerCommandRequest,
) -> Result<PlannerServiceEnvelope, String> {
    post_planner_json(&request.base_url, "/api/start_plan/", request.payload).await
}

#[tauri::command]
pub async fn planner_query_plan_status(
    request: PlannerCommandRequest,
) -> Result<PlannerServiceEnvelope, String> {
    post_planner_json(&request.base_url, "/api/query_plan_status/", request.payload).await
}

#[tauri::command]
pub async fn planner_get_plan_result(
    request: PlannerCommandRequest,
) -> Result<PlannerServiceEnvelope, String> {
    post_planner_json(&request.base_url, "/api/get_plan_result/", request.payload).await
}

#[tauri::command]
pub async fn planner_stop_plan(
    request: PlannerCommandRequest,
) -> Result<PlannerServiceEnvelope, String> {
    post_planner_json(&request.base_url, "/api/stop_plan/", request.payload).await
}

async fn post_planner_json(
    base_url: &str,
    path: &str,
    payload: Value,
) -> Result<PlannerServiceEnvelope, String> {
    let url = build_planner_url(base_url, path)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("无法创建规划服务 HTTP 客户端：{error}"))?;
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("规划服务请求失败：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取规划服务响应：{error}"))?;

    if !status.is_success() {
        return Err(format!(
            "规划服务返回 HTTP {}：{}",
            status.as_u16(),
            truncate_for_error(&body)
        ));
    }

    let envelope: PlannerServiceEnvelope = serde_json::from_str(&body)
        .map_err(|error| format!("规划服务响应不是合法 JSON：{error}"))?;

    if !envelope.data.is_object() {
        return Err("规划服务响应缺少 data 对象。".to_string());
    }

    Ok(envelope)
}

fn build_planner_url(base_url: &str, path: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');

    if trimmed.is_empty() {
        return Err("规划服务地址不能为空。".to_string());
    }

    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };

    Ok(format!("{trimmed}{path}"))
}

fn truncate_for_error(value: &str) -> String {
    const MAX_LEN: usize = 400;

    if value.chars().count() <= MAX_LEN {
        return value.to_string();
    }

    let truncated = value.chars().take(MAX_LEN).collect::<String>();
    format!("{truncated}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_planner_urls_with_or_without_trailing_slash() {
        assert_eq!(
            build_planner_url("http://planner.local:18080", "/api/start_plan/").unwrap(),
            "http://planner.local:18080/api/start_plan/"
        );
        assert_eq!(
            build_planner_url("http://planner.local:18080/", "api/query_plan_status/").unwrap(),
            "http://planner.local:18080/api/query_plan_status/"
        );
    }

    #[test]
    fn rejects_empty_base_urls() {
        let error = build_planner_url("   ", "/api/start_plan/").expect_err("empty base URL should fail");

        assert!(error.contains("不能为空"));
    }

    #[test]
    fn truncates_long_error_bodies() {
        let body = "a".repeat(450);
        let truncated = truncate_for_error(&body);

        assert!(truncated.ends_with("..."));
        assert!(truncated.len() < body.len());
    }

    #[test]
    fn decodes_service_envelope() {
        let envelope: PlannerServiceEnvelope = serde_json::from_str(
            r#"{"err_code":0,"err_msg":"ok","data":{"state":"running"},"trace_id":"trace-1"}"#,
        )
        .expect("decode envelope");

        assert_eq!(envelope.err_code, 0);
        assert_eq!(envelope.trace_id.as_deref(), Some("trace-1"));
        assert_eq!(envelope.data["state"], "running");
    }
}
