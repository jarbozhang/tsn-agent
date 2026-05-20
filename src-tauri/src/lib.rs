#[tauri::command]
fn app_health() -> &'static str {
    "ok"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_health])
        .run(tauri::generate_context!())
        .expect("failed to run TSN Agent");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_health_returns_ok() {
        assert_eq!(app_health(), "ok");
    }
}
