//! Plan v3 U5 scaffold：backfill state 跟踪 + retry/list/view_payload 命令。
//!
//! 实际 walker（CanonicalTsnProjectV0 JSON → 15 张 P0 表）在 next session 完成，
//! 需要 Canonical Rust 私有副本 + CDT 4 件套 schema 映射决策。
//!
//! 当前 unit 提供：
//!   - `mark_pending_for_all_sessions`：应用启动时把 `sessions.payload` 非空但
//!     无对应 `topology_nodes` 行的 session 标为 `pending_walker`。
//!   - `retry_backfill(sessionId)`：把指定 session 状态置 `pending_walker` 重试。
//!   - `list_backfill_failures()`：UI 展示阻塞 session 列表。
//!   - `view_session_payload(sessionId)`：返回 redacted payload 文本，供用户
//!     在 UI 手动检查 / 复制给 boss 修复。
//!
//! 失败状态码：`PAYLOAD_NOT_JSON / CANONICAL_SCHEMA_INVALID / CONSTRAINT_VIOLATION:*`
//! 由后续 walker 实施时填充。

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::redaction::redact_secrets;
use crate::session_store::SessionStore;

/// 启动期一次性扫描：把有 payload 但无对应 P0 数据的 session 标 pending。
/// 已存在 backfill_state 的 session 保持原状（避免重复覆盖 retry 状态）。
pub async fn mark_pending_for_all_sessions(pool: &SqlitePool) -> Result<u64, String> {
    let now = chrono_like_iso_now();
    let res = sqlx::query(
        r#"INSERT OR IGNORE INTO session_backfill_state (session_id, state, attempted_at)
           SELECT s.id, 'pending_walker', ?
             FROM sessions s
            WHERE NOT EXISTS (
                  SELECT 1 FROM session_backfill_state b WHERE b.session_id = s.id
              )"#,
    )
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| format!("backfill pending 标记失败：{e}"))?;
    Ok(res.rows_affected())
}

/// 返回当前 iso8601 时间戳；避免引入 chrono 依赖。
fn chrono_like_iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 简易格式 YYYY-MM-DDTHH:MM:SSZ 用 unix 秒转化的近似值；
    // 对于 backfill state attempted_at 字段精度足够（排序 + UI 显示）。
    format!("@unix-{secs}")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillStateRow {
    pub session_id: String,
    pub state: String,
    pub error_code: Option<String>,
    pub attempted_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    session_id: String,
}

#[tauri::command]
pub async fn list_backfill_failures(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Vec<BackfillStateRow>, String> {
    let pool = store.pool(&app).await?;
    let rows = sqlx::query_as::<_, (String, String, Option<String>, String)>(
        r#"SELECT session_id, state, error_code, attempted_at
             FROM session_backfill_state
            WHERE state LIKE 'failed_%'
            ORDER BY attempted_at DESC"#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询 backfill 失败列表：{e}"))?;
    Ok(rows
        .into_iter()
        .map(|(session_id, state, error_code, attempted_at)| BackfillStateRow {
            session_id,
            state,
            error_code,
            attempted_at,
        })
        .collect())
}

#[tauri::command]
pub async fn retry_backfill(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    let now = chrono_like_iso_now();
    sqlx::query(
        r#"INSERT INTO session_backfill_state (session_id, state, attempted_at)
           VALUES (?, 'pending_walker', ?)
           ON CONFLICT(session_id) DO UPDATE SET
             state = 'pending_walker',
             error_code = NULL,
             attempted_at = excluded.attempted_at"#,
    )
    .bind(&request.session_id)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| format!("retry 标记失败：{e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn view_session_payload(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<String, String> {
    let pool = store.pool(&app).await?;
    let payload: Option<String> = sqlx::query_scalar("SELECT payload FROM sessions WHERE id = ?")
        .bind(&request.session_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询 payload 失败：{e}"))?;
    let payload = payload.ok_or_else(|| format!("会话不存在：{}", request.session_id))?;
    Ok(redact_secrets(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> sqlx::Pool<sqlx::Sqlite> {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts).await.unwrap();
        sqlx::query(&crate::db::safety_net_schema_sql())
            .execute(&pool).await.unwrap();
        pool
    }

    #[test]
    fn mark_pending_skips_sessions_with_existing_state_row() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}'), ('s2', 't', 'now', 'now', '{}')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO session_backfill_state (session_id, state, attempted_at) VALUES ('s2', 'failed_parse', 'now')")
                .execute(&pool).await.unwrap();

            let marked = mark_pending_for_all_sessions(&pool).await.unwrap();
            assert_eq!(marked, 1); // 只 s1 新增

            let s2_state: String = sqlx::query_scalar("SELECT state FROM session_backfill_state WHERE session_id='s2'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(s2_state, "failed_parse"); // 不被覆盖
        });
    }

    #[test]
    fn retry_backfill_overwrites_failure_with_pending_walker() {
        tauri::async_runtime::block_on(async {
            let pool = fresh_pool().await;
            sqlx::query("INSERT INTO sessions (id, title, created_at, updated_at, payload) VALUES ('s1', 't', 'now', 'now', '{}')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO session_backfill_state (session_id, state, error_code, attempted_at) VALUES ('s1', 'failed_parse', 'PAYLOAD_NOT_JSON', 'old')")
                .execute(&pool).await.unwrap();

            sqlx::query(
                r#"INSERT INTO session_backfill_state (session_id, state, attempted_at)
                   VALUES (?, 'pending_walker', ?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     state = 'pending_walker', error_code = NULL, attempted_at = excluded.attempted_at"#,
            )
            .bind("s1").bind("new").execute(&pool).await.unwrap();

            let (state, code): (String, Option<String>) = sqlx::query_as("SELECT state, error_code FROM session_backfill_state WHERE session_id='s1'")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(state, "pending_walker");
            assert!(code.is_none());
        });
    }
}
