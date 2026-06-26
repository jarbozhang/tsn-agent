// U4：硬件部署 API 配置的读写编排层（设置面板 → Tauri invoke）。
// 后端命令 get_hardware_api_config / set_hardware_api_config 已就绪（hardware_api_config.rs）。
// 与软仿远端 SSH 配置（inet-host-config.ts）解耦。

import { invoke } from "@tauri-apps/api/core";

export interface HardwareApiConfig {
  /** tsn-sim 服务根地址（如 http://100.78.48.43:19080）。 */
  baseUrl: string;
}

/** 读 UI 持久的硬件 API 配置（无记录时后端回播种当前默认）。 */
export async function getHardwareApiConfig(): Promise<HardwareApiConfig> {
  return await invoke<HardwareApiConfig>("get_hardware_api_config");
}

/** 写硬件 API 配置（保存）。base_url 空或非 http(s) 前缀时后端抛错（字符串）。 */
export async function setHardwareApiConfig(config: HardwareApiConfig): Promise<void> {
  await invoke("set_hardware_api_config", { config });
}
