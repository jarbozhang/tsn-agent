use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Pool, Row, Sqlite,
};
use std::path::PathBuf;
use tauri::Manager;
use tokio::sync::OnceCell;

const CURRENT_SESSION_KEY: &str = "current_session_id";

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionPayload {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    message_count: i64,
    event_count: i64,
    has_project: bool,
    project_name: Option<String>,
    bundle_file_count: i64,
    payload: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionRequest {
    session: SessionPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdRequest {
    session_id: String,
}

#[derive(Default)]
pub struct SessionStore {
    pool: OnceCell<Pool<Sqlite>>,
}

#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Vec<SessionPayload>, String> {
    let pool = store.pool(&app).await?;
    let rows = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT 12
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(db_error)?;

    Ok(rows.iter().map(row_to_payload).collect())
}

#[tauri::command]
pub async fn get_current_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
) -> Result<Option<SessionPayload>, String> {
    let pool = store.pool(&app).await?;
    let current_id: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_state WHERE key = ? LIMIT 1")
            .bind(CURRENT_SESSION_KEY)
            .fetch_optional(pool)
            .await
            .map_err(db_error)?;

    if let Some(session_id) = current_id {
        if let Some(session) = select_session(pool, &session_id).await? {
            return Ok(Some(session));
        }
    }

    let latest = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;

    Ok(latest.as_ref().map(row_to_payload))
}

#[tauri::command]
pub async fn save_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SaveSessionRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    let session = request.session;

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO sessions (
            id, title, created_at, updated_at, message_count, event_count,
            has_project, project_name, bundle_file_count, payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&session.id)
    .bind(&session.title)
    .bind(&session.created_at)
    .bind(&session.updated_at)
    .bind(session.message_count)
    .bind(session.event_count)
    .bind(if session.has_project { 1_i64 } else { 0_i64 })
    .bind(&session.project_name)
    .bind(session.bundle_file_count)
    .bind(&session.payload)
    .execute(pool)
    .await
    .map_err(db_error)?;

    set_current_session_id(pool, &session.id).await
}

#[tauri::command]
pub async fn set_current_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;

    set_current_session_id(pool, &request.session_id).await
}

#[tauri::command]
pub async fn remove_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, SessionStore>,
    request: SessionIdRequest,
) -> Result<(), String> {
    let pool = store.pool(&app).await?;
    let current_id = current_session_id(pool).await?;

    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(&request.session_id)
        .execute(pool)
        .await
        .map_err(db_error)?;
    crate::diagnostic_store::clear_logs_for_session(pool, &request.session_id).await?;

    if current_id.as_deref() != Some(request.session_id.as_str()) {
        return Ok(());
    }

    if let Some(next) = latest_session_id(pool).await? {
        set_current_session_id(pool, &next).await
    } else {
        sqlx::query("DELETE FROM app_state WHERE key = ?")
            .bind(CURRENT_SESSION_KEY)
            .execute(pool)
            .await
            .map_err(db_error)?;
        Ok(())
    }
}

impl SessionStore {
    async fn pool(&self, app: &tauri::AppHandle) -> Result<&Pool<Sqlite>, String> {
        self.pool
            .get_or_try_init(|| async { connect_app_database(app).await })
            .await
    }
}

pub async fn connect_app_database(app: &tauri::AppHandle) -> Result<Pool<Sqlite>, String> {
    let db_path = session_database_path(app)?;
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(db_error)?;

    sqlx::query(crate::db::SESSION_SCHEMA_SQL)
        .execute(&pool)
        .await
        .map_err(db_error)?;

    Ok(pool)
}

async fn select_session(
    pool: &Pool<Sqlite>,
    session_id: &str,
) -> Result<Option<SessionPayload>, String> {
    let row = sqlx::query(
        r#"
        SELECT id, title, created_at, updated_at, message_count, event_count,
               has_project, project_name, bundle_file_count, payload
        FROM sessions
        WHERE id = ?
        LIMIT 1
        "#,
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;

    Ok(row.as_ref().map(row_to_payload))
}

async fn set_current_session_id(pool: &Pool<Sqlite>, session_id: &str) -> Result<(), String> {
    sqlx::query(
        r#"
        INSERT OR REPLACE INTO app_state (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        "#,
    )
    .bind(CURRENT_SESSION_KEY)
    .bind(session_id)
    .execute(pool)
    .await
    .map_err(db_error)?;

    Ok(())
}

async fn latest_session_id(pool: &Pool<Sqlite>) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(db_error)
}

async fn current_session_id(pool: &Pool<Sqlite>) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM app_state WHERE key = ? LIMIT 1")
        .bind(CURRENT_SESSION_KEY)
        .fetch_optional(pool)
        .await
        .map_err(db_error)
}

fn session_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))?;

    std::fs::create_dir_all(&app_dir).map_err(|error| format!("无法创建应用配置目录：{error}"))?;

    Ok(app_dir.join("tsn-agent.db"))
}

fn row_to_payload(row: &sqlx::sqlite::SqliteRow) -> SessionPayload {
    SessionPayload {
        id: row.get("id"),
        title: row.get("title"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        message_count: row.get("message_count"),
        event_count: row.get("event_count"),
        has_project: row.get::<i64, _>("has_project") == 1,
        project_name: row.get("project_name"),
        bundle_file_count: row.get("bundle_file_count"),
        payload: row.get("payload"),
    }
}

fn db_error(error: sqlx::Error) -> String {
    format!("session database error: {error}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn session_schema_contains_expected_tables() {
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS sessions"));
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS app_state"));
        assert!(
            crate::db::SESSION_SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS diagnostic_logs")
        );
        assert!(crate::db::SESSION_SCHEMA_SQL.contains("idx_sessions_updated_at"));
    }
}
