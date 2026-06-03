//! Plan v3 U4a-1：拓扑 sidecar 8 个领域 route 的实际 sqlx 实现。
//!
//! 已接：
//!   - POST /db/topology/apply_operations  (insert/update/delete + emit mutation)
//!   - POST /db/topology/inspect           (only counts / row dump per session)
//!   - POST /db/topology/validate          (structural sanity)
//!
//! 仍占位（待 U4a-2 完成 artifacts.ts 的 Rust 端重写）：
//!   - describe_templates / describe_artifacts / build_artifacts /
//!     validate_artifacts
//!
//! `initialize` 简化实现：写 sessions 不存在则报错 (template 逻辑 deferred)。

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::Arc;

use crate::topology_mutation_buffer::{MutationRecord, TopologyMutationBuffer};
use crate::topology_ops::{apply_op, TopologyOp};

/// 闭包形式的 mutation 发射器：生产用 Tauri AppHandle wrap，测试用 no-op。
/// 通过 trait object 解耦 runtime 泛型，避免 `RouteState` 被 `MockRuntime` 污染。
pub type MutationEmitFn = Arc<dyn Fn(MutationRecord) + Send + Sync>;

#[derive(Clone)]
pub struct RouteState {
    pub pool: sqlx::Pool<sqlx::Sqlite>,
    pub mutation_buffer: Arc<TopologyMutationBuffer>,
    pub emit: MutationEmitFn,
}

const NOT_IMPLEMENTED_BODY: &str = r#"{"error":"not_implemented","unit":"U4a-2"}"#;

fn not_implemented() -> Response {
    (StatusCode::NOT_IMPLEMENTED, NOT_IMPLEMENTED_BODY).into_response()
}

fn structured_error(status: StatusCode, code: &str, message: &str, retryable: bool) -> Response {
    let body = serde_json::json!({
        "ok": false,
        "code": code,
        "message": message,
        "retryable": retryable,
    });
    (status, Json(body)).into_response()
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

pub async fn build_artifacts() -> Response {
    not_implemented()
}

pub async fn validate_artifacts() -> Response {
    not_implemented()
}

// ---------- initialize ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeRequest {
    session_id: String,
    /// 模板初始化 deferred 到 U4a-2 完成模板库 Rust 重写；
    /// 当前仅校验 session 存在并返回空 changeSet 占位。
    #[serde(default)]
    #[allow(dead_code)]
    template_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    ok: bool,
    summary: serde_json::Value,
}

pub async fn initialize(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<InitializeRequest>,
) -> Response {
    match require_session(&state.pool, &req.session_id).await {
        Ok(()) => (
            StatusCode::OK,
            Json(InitializeResponse {
                ok: true,
                summary: serde_json::json!({
                    "note": "template instantiation deferred to U4a-2",
                    "sessionId": req.session_id,
                }),
            }),
        )
            .into_response(),
        Err(resp) => resp,
    }
}

// ---------- inspect ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRequest {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectResponse {
    ok: bool,
    summary: InspectSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectSummary {
    session_id: String,
    node_count: i64,
    link_count: i64,
}

pub async fn inspect(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<InspectRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    let node_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id = ?")
            .bind(&req.session_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(0);
    let link_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM topology_links WHERE session_id = ?")
            .bind(&req.session_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(0);
    (
        StatusCode::OK,
        Json(InspectResponse {
            ok: true,
            summary: InspectSummary {
                session_id: req.session_id,
                node_count,
                link_count,
            },
        }),
    )
        .into_response()
}

// ---------- validate ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateRequest {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateResponse {
    ok: bool,
    summary: ValidateSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateSummary {
    errors: Vec<String>,
    warnings: Vec<String>,
}

pub async fn validate(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<ValidateRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    // 基础检查：节点 0 个 → 错误；链路引用未知节点 → 错误。
    let node_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM topology_nodes WHERE session_id = ?")
            .bind(&req.session_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(0);
    if node_count == 0 {
        warnings.push("topology has no nodes yet".to_string());
    }

    let dangling: Vec<(i64, i64)> = sqlx::query(
        r#"SELECT l.src_imac, l.dst_imac FROM topology_links l
           WHERE l.session_id = ?
             AND (
               NOT EXISTS (SELECT 1 FROM topology_nodes n
                           WHERE n.session_id = l.session_id AND n.imac = l.src_imac)
               OR
               NOT EXISTS (SELECT 1 FROM topology_nodes n
                           WHERE n.session_id = l.session_id AND n.imac = l.dst_imac)
             )"#,
    )
    .bind(&req.session_id)
    .fetch_all(&state.pool)
    .await
    .map(|rows| {
        rows.into_iter()
            .map(|r| (r.get::<i64, _>("src_imac"), r.get::<i64, _>("dst_imac")))
            .collect()
    })
    .unwrap_or_default();
    for (src, dst) in dangling {
        errors.push(format!("link references missing node(s): {src}->{dst}"));
    }

    (
        StatusCode::OK,
        Json(ValidateResponse {
            ok: errors.is_empty(),
            summary: ValidateSummary { errors, warnings },
        }),
    )
        .into_response()
}

// ---------- apply_operations ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOpsRequest {
    session_id: String,
    operations: Vec<TopologyOp>,
    #[serde(default)]
    dry_run: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOpsResponse {
    ok: bool,
    summary: ApplyOpsSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOpsSummary {
    session_id: String,
    dry_run: bool,
    applied: Vec<crate::topology_ops::OpResultSummary>,
    /// 仅 commit 成功且非 dryRun 时有值；UI 用此 mutation_id 查 catch-up。
    mutation_id: Option<u64>,
}

pub async fn apply_operations(
    State(state): State<Arc<RouteState>>,
    Json(req): Json<ApplyOpsRequest>,
) -> Response {
    if let Err(resp) = require_session(&state.pool, &req.session_id).await {
        return resp;
    }

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(e) => return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "BEGIN_FAILED",
            &e.to_string(),
            true,
        ),
    };

    let mut applied = Vec::with_capacity(req.operations.len());
    for op in &req.operations {
        match apply_op(&mut *tx, &req.session_id, op).await {
            Ok(s) => applied.push(s),
            Err(err) => {
                let _ = tx.rollback().await;
                return structured_error(
                    err.http_status(),
                    err.code(),
                    &err.message(),
                    false,
                );
            }
        }
    }

    if req.dry_run {
        if let Err(e) = tx.rollback().await {
            return structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ROLLBACK_FAILED",
                &e.to_string(),
                true,
            );
        }
        return (
            StatusCode::OK,
            Json(ApplyOpsResponse {
                ok: true,
                summary: ApplyOpsSummary {
                    session_id: req.session_id,
                    dry_run: true,
                    applied,
                    mutation_id: None,
                },
            }),
        )
            .into_response();
    }

    if let Err(e) = tx.commit().await {
        return structured_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "COMMIT_FAILED",
            &e.to_string(),
            true,
        );
    }

    let record = state
        .mutation_buffer
        .push(req.session_id.clone(), "topology".to_string());
    (state.emit)(record.clone());
    (
        StatusCode::OK,
        Json(ApplyOpsResponse {
            ok: true,
            summary: ApplyOpsSummary {
                session_id: req.session_id,
                dry_run: false,
                applied,
                mutation_id: Some(record.mutation_id),
            },
        }),
    )
        .into_response()
}

// ---------- helpers ----------

async fn require_session(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    session_id: &str,
) -> Result<(), Response> {
    let count: i64 = match sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(pool)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            return Err(structured_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "DATABASE_ERROR",
                &e.to_string(),
                true,
            ))
        }
    };
    if count == 0 {
        return Err(structured_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "FORBIDDEN_OPERATION",
            "session does not exist or not authorized",
            false,
        ));
    }
    Ok(())
}
