// INET 软仿 HTTP 服务配置的读写编排层（设置面板 → Tauri invoke）。
// 后端命令 get_inet_sim_http_config / set_inet_sim_http_config（inet_sim_http_config.rs）。
// 与硬件部署（hardware-api-config.ts）、软仿 SSH（inet-host-config.ts）三套解耦。
// 空 baseUrl = 未启用，软仿走 SSH 兜底；配了走 HTTP。

import { invoke } from "@tauri-apps/api/core";

export interface InetSimHttpConfig {
  /** 软仿 HTTP 服务根地址（如 http://100.104.38.106:19090）；空=未启用，走 SSH。 */
  baseUrl: string;
}

/** 读 UI 持久的软仿 HTTP 配置（无记录时后端回空串）。 */
export async function getInetSimHttpConfig(): Promise<InetSimHttpConfig> {
  return await invoke<InetSimHttpConfig>("get_inet_sim_http_config");
}

/** 写软仿 HTTP 配置（保存）。非空且非 http(s) 前缀时后端抛错（字符串）。 */
export async function setInetSimHttpConfig(config: InetSimHttpConfig): Promise<void> {
  await invoke("set_inet_sim_http_config", { config });
}
