//! 硬件部署任务表（`task`）的访问函数（2026-06-26，U1）。
//!
//! 每会话多 task，task_id 由应用生成（见 hardware_command.rs / KTD4）。`type` 列区分
//! 任务类型（本期固定 `hardware`，将来 simulation/both）。「当前 task」= created_at 最新。

use sqlx::{Pool, Row, Sqlite};

/// `task` 表一行。`task_type` 映射列 `type`（`type` 是 Rust 关键字，故字段改名）。
#[derive(Debug, Clone, PartialEq)]
pub struct TaskRow {
    pub task_id: String,
    pub duration: i64,
    pub task_type: String,
    pub created_at: String,
}

/// 插入一条 task 行（created_at 用 `datetime('now')`）。撞 PK（同会话同 task_id）由
/// 调用方据 sqlx 错误处理（hardware_start 映射成中文错误，不静默）。
pub async fn insert_task(
    pool: &Pool<Sqlite>,
    session_id: &str,
    task_id: &str,
    duration: i64,
    task_type: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO task (session_id, task_id, duration, type, created_at) \
         VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .bind(session_id)
    .bind(task_id)
    .bind(duration)
    .bind(task_type)
    .execute(pool)
    .await?;
    Ok(())
}

/// 取会话最新创建的 task（created_at 最大；同秒平手用 rowid DESC 取最后插入的）。
/// 无记录返回 None。
pub async fn latest_task(
    pool: &Pool<Sqlite>,
    session_id: &str,
) -> Result<Option<TaskRow>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT task_id, duration, type, created_at FROM task \
         WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| TaskRow {
        task_id: r.get("task_id"),
        duration: r.get("duration"),
        task_type: r.get("type"),
        created_at: r.get("created_at"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// 内存 pool：开 FK（验 CASCADE）+ sessions 表 + task 表 + 一行 session。
    async fn test_pool() -> Pool<Sqlite> {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        crate::db::ensure_task_table(&pool).await.unwrap();
        sqlx::query("INSERT INTO sessions (id) VALUES ('s1')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn insert_then_latest_round_trip() {
        let pool = test_pool().await;
        insert_task(&pool, "s1", "hw-s1-1", 60, "hardware")
            .await
            .unwrap();
        let row = latest_task(&pool, "s1").await.unwrap().unwrap();
        assert_eq!(row.task_id, "hw-s1-1");
        assert_eq!(row.duration, 60);
        assert_eq!(row.task_type, "hardware");
    }

    #[tokio::test]
    async fn latest_returns_most_recent_created_at() {
        let pool = test_pool().await;
        // 显式 created_at 控制顺序（datetime('now') 同秒会平手）。
        sqlx::query(
            "INSERT INTO task (session_id, task_id, duration, type, created_at) \
             VALUES ('s1', 'hw-old', 60, 'hardware', '2026-06-26T10:00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO task (session_id, task_id, duration, type, created_at) \
             VALUES ('s1', 'hw-new', 30, 'hardware', '2026-06-26T11:00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let row = latest_task(&pool, "s1").await.unwrap().unwrap();
        assert_eq!(row.task_id, "hw-new");
    }

    #[tokio::test]
    async fn no_record_returns_none() {
        let pool = test_pool().await;
        assert!(latest_task(&pool, "s1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn cascade_delete_removes_task_rows() {
        let pool = test_pool().await;
        insert_task(&pool, "s1", "hw-1", 60, "hardware")
            .await
            .unwrap();
        sqlx::query("DELETE FROM sessions WHERE id = 's1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(latest_task(&pool, "s1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn ensure_task_table_idempotent() {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        // 重复跑幂等。
        crate::db::ensure_task_table(&pool).await.unwrap();
        crate::db::ensure_task_table(&pool).await.unwrap();
        sqlx::query("INSERT INTO sessions (id) VALUES ('s1')")
            .execute(&pool)
            .await
            .unwrap();
        insert_task(&pool, "s1", "hw-1", 60, "hardware")
            .await
            .unwrap();
        assert!(latest_task(&pool, "s1").await.unwrap().is_some());
    }
}
