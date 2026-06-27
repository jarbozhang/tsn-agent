"""薄 HTTP 软仿服务的配置（沉淀指令 + 运行目录 + 端口），全部可由环境变量覆盖。

关键不变量：`INET_ENV_CMD` 必须与 app 侧 SSH 路径（src-tauri/src/inet_remote.rs 的
DEFAULT_INET_ENV_CMD）逐字一致——服务在宿主机本地以 `<INET_ENV_CMD> -c '<inner>'`
跑命令，结果才能与 SSH 路径对得上（plan R1）。
"""

import os

# 沉淀的 INET 环境命令前缀：把任意命令丢进 opp_env 的 OMNeT++/INET 环境里跑
# （inet 与 opp_scavetool 都在该环境 PATH 上）。以 `<INET_ENV_CMD> -c '<inner>'` 调用。
INET_ENV_CMD = os.environ.get(
    "INET_SIM_ENV_CMD",
    "source /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh && "
    "/home/zhang/.local/bin/opp_env run inet-4.6.0 "
    "-w /home/zhang/inet-workspace --build-modes=release",
)

# 每个软仿在 RUN_BASE_DIR 下建独立 run-<hex> 子目录（与 SSH 路径同基目录，互不影响）。
RUN_BASE_DIR = os.environ.get("INET_SIM_RUN_DIR", "/tmp/tsn-agent-runs")

# 服务监听端口（与硬件部署 19080 区分）。
PORT = int(os.environ.get("INET_SIM_PORT", "19090"))

# 前置验证用的轻量探针：只查存在性，不实跑 opp_env（首跑编译数分钟，不能塞进 healthz）。
NIX_PROFILE_SCRIPT = os.environ.get(
    "INET_SIM_NIX_PROFILE",
    "/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh",
)
OPP_ENV_BIN = os.environ.get("INET_SIM_OPP_ENV_BIN", "/home/zhang/.local/bin/opp_env")

# run 目录保留个数（GC 时保留最近 N 个，超出清理）。
RUN_RETENTION = int(os.environ.get("INET_SIM_RUN_RETENTION", "20"))

# 单条命令超时（秒）。opp_env 首跑编译慢，给足。
CMD_TIMEOUT_S = int(os.environ.get("INET_SIM_CMD_TIMEOUT", "600"))
