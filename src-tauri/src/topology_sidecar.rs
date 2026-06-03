//! Plan v3 U3：axum 本地 sidecar + per-launch Bearer token。
//!
//! 启动顺序（Tauri `setup()` 同步调用）：
//!   1. mint per-launch token (`OsRng` 32 字节 → base64url)
//!   2. bind 127.0.0.1:<random port>（IPv4 literal，避免 Windows IPv6 优先问题）
//!   3. spawn axum task on `tauri::async_runtime`，持 `CancellationToken`
//!   4. 应用 state 持 `SidecarHandle { url, token, cancel, port }`
//!
//! token 仅在 Rust 内存中流转（`SecretToken` 自定义 `Debug` 输出 `[REDACTED]`），
//! UI 永远不接触；worker spawn 时通过 env 注入到 MCP child。
//! Bearer 校验走自定义 `from_fn` middleware + `subtle::ConstantTimeEq`（**不用** tower-http
//! builtin `ValidateRequestHeaderLayer::bearer`，后者按字符串 `==` 非常量时间）。
//!
//! U4a 接 sqlx handler；当前 8 route 占位返回 501。

use std::fmt;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::topology_sidecar_routes;

/// per-launch capability token。`Debug` impl 输出 `[REDACTED]`，
/// 进程结束自动 zeroize（`String` 的 buffer 在 Drop 时清零写不保证；
/// 但本 token 进程内只持一次、不持久化、`Debug` 与 panic backtrace 均不泄露字面值，
/// 满足 plan v3 KTD 的 immutability + non-leak invariant）。
#[derive(Clone)]
pub struct SecretToken(Arc<String>);

impl SecretToken {
    fn new(raw: String) -> Self {
        Self(Arc::new(raw))
    }

    /// 暴露字面值。仅在 worker spawn env 注入、HTTP Authorization 字符串比较时使用。
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for SecretToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretToken([REDACTED])")
    }
}

impl Drop for SecretToken {
    fn drop(&mut self) {
        // Arc 引用计数到 0 时 String 被 drop。受 Rust 语义限制无法真正 zeroize 已 alloc 的 String，
        // 但本 token 不会被序列化 / 不持久化 / Debug 不泄漏，对 plan v3 威胁模型足够。
    }
}

/// Tauri State：sidecar 生命周期句柄。`run_claude_agent` 从此处取 `url + token` 注入 worker。
pub struct SidecarHandle {
    pub url: String,
    pub token: SecretToken,
    pub port: u16,
    cancel: CancellationToken,
}

impl SidecarHandle {
    /// Tauri 退出时调用。
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}

impl fmt::Debug for SidecarHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SidecarHandle")
            .field("url", &self.url)
            .field("token", &self.token)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

/// 生成 32 字节 OsRng → base64url-no-pad → 43 字符 token。
fn mint_token() -> SecretToken {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    SecretToken::new(URL_SAFE_NO_PAD.encode(bytes))
}

/// Bind 127.0.0.1:0 拿 ephemeral port。绑定失败直接 panic（plan v3 fail-closed）。
async fn bind_loopback() -> Result<(TcpListener, u16), String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|error| format!("拓扑 sidecar 服务启动失败：{error}；建议检查 127.0.0.1 占用或重启应用"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("拓扑 sidecar 端口解析失败：{error}"))?
        .port();
    Ok((listener, port))
}

/// 自定义 from_fn Bearer middleware：取 `Authorization: Bearer <token>`，
/// 用 `subtle::ConstantTimeEq` 与 state 中持有的 token 比较。
async fn bearer_auth_middleware(
    State(token): State<Arc<SecretToken>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let headers: &HeaderMap = req.headers();
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|hv| hv.to_str().ok())
        .and_then(|raw| raw.strip_prefix("Bearer "));
    let Some(presented) = presented else {
        return unauthorized_response();
    };
    let expected = token.expose();
    if presented.as_bytes().ct_eq(expected.as_bytes()).into() {
        next.run(req).await
    } else {
        unauthorized_response()
    }
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        r#"{"error":"unauthorized","message":"missing or invalid bearer token"}"#,
    )
        .into_response()
}

/// 构建 8 route 占位 router（U4a 接 sqlx 实际 handler）+ Bearer middleware。
pub fn build_router(token: SecretToken) -> Router {
    let state = Arc::new(token);
    Router::new()
        .route("/healthz", get(topology_sidecar_routes::healthz))
        .route(
            "/db/topology/describe_templates",
            post(topology_sidecar_routes::describe_templates),
        )
        .route(
            "/db/topology/describe_artifacts",
            post(topology_sidecar_routes::describe_artifacts),
        )
        .route(
            "/db/topology/initialize",
            post(topology_sidecar_routes::initialize),
        )
        .route(
            "/db/topology/inspect",
            post(topology_sidecar_routes::inspect),
        )
        .route(
            "/db/topology/validate",
            post(topology_sidecar_routes::validate),
        )
        .route(
            "/db/topology/build_artifacts",
            post(topology_sidecar_routes::build_artifacts),
        )
        .route(
            "/db/topology/validate_artifacts",
            post(topology_sidecar_routes::validate_artifacts),
        )
        .route(
            "/db/topology/apply_operations",
            post(topology_sidecar_routes::apply_operations),
        )
        .route_layer(middleware::from_fn_with_state(
            state,
            bearer_auth_middleware,
        ))
}

/// 启动 sidecar：bind + token + spawn axum task。返回 `SidecarHandle`。
/// 失败 panic：plan v3 显式 fail-closed，不再有 fallback flag。
pub async fn launch() -> SidecarHandle {
    let token = mint_token();
    let (listener, port) = bind_loopback()
        .await
        .unwrap_or_else(|msg| panic!("{msg}"));
    let url = format!("http://127.0.0.1:{port}");
    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    let router = build_router(token.clone());

    tauri::async_runtime::spawn(async move {
        let serve = axum::serve(listener, router.into_make_service())
            .with_graceful_shutdown(async move {
                cancel_for_task.cancelled().await;
            });
        if let Err(error) = serve.await {
            // shutdown 之后 axum 正常返回 Ok；只有 unexpected error 走这里。
            eprintln!("拓扑 sidecar 终止：{error}");
        }
    });

    SidecarHandle {
        url,
        token,
        port,
        cancel,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn mint_token_returns_43_char_base64url_no_pad() {
        let t = mint_token();
        let exposed = t.expose();
        assert_eq!(exposed.len(), 43); // 32 bytes base64url-no-pad = ceil(32 * 4 / 3) - 1 = 43
        assert!(exposed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }

    #[test]
    fn mint_token_two_calls_produce_distinct_tokens() {
        let a = mint_token();
        let b = mint_token();
        assert_ne!(a.expose(), b.expose());
    }

    #[test]
    fn debug_secret_token_redacts() {
        let t = mint_token();
        let formatted = format!("{:?}", t);
        assert!(!formatted.contains(t.expose()));
        assert!(formatted.contains("REDACTED"));
    }

    #[test]
    fn router_rejects_missing_bearer_with_401() {
        tauri::async_runtime::block_on(async {
            let token = mint_token();
            let router = build_router(token.clone());
            let resp = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri("/healthz")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        });
    }

    #[test]
    fn router_rejects_wrong_bearer_with_401() {
        tauri::async_runtime::block_on(async {
            let token = mint_token();
            let router = build_router(token);
            let resp = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri("/healthz")
                        .header("Authorization", "Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxx")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        });
    }

    #[test]
    fn router_accepts_correct_bearer_and_returns_200_on_healthz() {
        tauri::async_runtime::block_on(async {
            let token = mint_token();
            let token_str = token.expose().to_string();
            let router = build_router(token);
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri("/healthz")
                        .header("Authorization", format!("Bearer {token_str}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let body = to_bytes(resp.into_body(), 1024).await.unwrap();
            assert!(body.starts_with(b"{\"status\":\"ok\""));
        });
    }

    #[test]
    fn router_returns_501_on_unimplemented_topology_route() {
        tauri::async_runtime::block_on(async {
            let token = mint_token();
            let token_str = token.expose().to_string();
            let router = build_router(token);
            let resp = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/db/topology/initialize")
                        .header("Authorization", format!("Bearer {token_str}"))
                        .header("Content-Type", "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
        });
    }

    #[test]
    fn launch_binds_and_serves_then_shuts_down() {
        tauri::async_runtime::block_on(async {
            let handle = launch().await;
            assert!(handle.port > 0);
            assert_eq!(handle.url, format!("http://127.0.0.1:{}", handle.port));

            // sidecar 在 background task 中运行；通过 reqwest 真实 round-trip 验证 listener 可达。
            let token_str = handle.token.expose().to_string();
            let url = format!("{}/healthz", handle.url);
            let client = reqwest::Client::new();
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {token_str}"))
                .send()
                .await
                .expect("healthz reachable");
            assert_eq!(resp.status(), 200);

            handle.shutdown();
            // 短暂等待 task 退出；不阻塞测试，仅作 sanity。
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        });
    }
}
