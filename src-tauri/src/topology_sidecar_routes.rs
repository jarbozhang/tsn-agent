//! Plan v3 U3 占位：8 个 topology MCP route 返回 501 Not Implemented。
//! U4a 替换为 sqlx Transaction + ops whitelist + DB-direct artifact build。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

const NOT_IMPLEMENTED_BODY: &str = r#"{"error":"not_implemented","unit":"U4a"}"#;

fn not_implemented() -> Response {
    (StatusCode::NOT_IMPLEMENTED, NOT_IMPLEMENTED_BODY).into_response()
}

pub async fn healthz() -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        r#"{"status":"ok","service":"tsn_topology_sidecar"}"#,
    )
        .into_response()
}

pub async fn describe_templates() -> Response {
    not_implemented()
}

pub async fn describe_artifacts() -> Response {
    not_implemented()
}

pub async fn initialize() -> Response {
    not_implemented()
}

pub async fn inspect() -> Response {
    not_implemented()
}

pub async fn validate() -> Response {
    not_implemented()
}

pub async fn build_artifacts() -> Response {
    not_implemented()
}

pub async fn validate_artifacts() -> Response {
    not_implemented()
}

pub async fn apply_operations() -> Response {
    not_implemented()
}
