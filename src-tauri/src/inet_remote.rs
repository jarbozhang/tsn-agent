//! 软仿执行抽象 + 共享类型。
//!
//! 历史上这里是 SSH/scp 远程执行器；软仿改走宿主机薄 HTTP 服务后（单路径），SSH 执行已移除，
//! 本模块只保留执行器抽象（`RemoteRunner`）与跨实现共享的数据类型（bundle / 结果 / 错误）。
//! 真实现是 `inet_sim_http::HttpRunner`；测试注入 Mock。

/// 执行器消费的 bundle 形状（三段文本）。由 bundle 生成器（inet_sim_bundle）产出。
#[derive(Debug, Clone)]
pub struct InetBundle {
    pub network_ned: String,
    pub omnetpp_ini: String,
    pub manifest_json: String,
}

/// 执行失败分类——驱动「连不上」分文案（HTTP 不可达 / 服务端失败）。
#[derive(Debug)]
pub enum RemoteError {
    /// 连不上 / 服务端执行失败 —— 环境问题，非拓扑错。
    Unreachable(String),
}

/// 软仿运行 + 结果取回产物。
/// `exit_code` 非 0 → inet 没跑成（caller 判 load_failed）、`csv` 为 None；
/// `exit_code`=0 但 `csv` 空/None → 结果为空（caller 判「结果为空」，不渲染收敛）。
#[derive(Debug, Clone)]
pub struct SimRunOutcome {
    pub exit_code: Option<i32>,
    pub output_tail: String,
    /// scavetool 导出的 timeChanged CSV 原文（成功且非空才 Some）。
    pub csv: Option<String>,
    /// scavetool 命令本身失败（非零退出/缺失）——区别于「跑成功但导出 0 行」。
    pub scavetool_failed: bool,
}

pub trait RemoteRunner {
    /// 软仿：送 bundle → 跑 inet → 跑 opp_scavetool 导出 timeChanged CSV → 回传。
    /// `scavetool_filter` 是 `opp_scavetool export -f` 的过滤表达式（由调用方构造）。
    fn run_sim_fetch_csv(
        &self,
        bundle: &InetBundle,
        scavetool_filter: &str,
    ) -> Result<SimRunOutcome, RemoteError>;
}
