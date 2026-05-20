pub const DATABASE_URL: &str = "sqlite:tsn-agent.db";
pub const SESSION_SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        has_project INTEGER NOT NULL DEFAULT 0,
        project_name TEXT,
        bundle_file_count INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
        ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS diagnostic_logs (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        run_id TEXT,
        duration_ms INTEGER,
        details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_session_created_at
        ON diagnostic_logs(session_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_session_category
        ON diagnostic_logs(session_id, category);
"#;

pub fn migrations() -> Vec<tauri_plugin_sql::Migration> {
    vec![tauri_plugin_sql::Migration {
        version: 1,
        description: "create_session_store",
        sql: SESSION_SCHEMA_SQL,
        kind: tauri_plugin_sql::MigrationKind::Up,
    }]
}
