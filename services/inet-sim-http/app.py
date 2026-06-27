"""薄 HTTP 软仿服务（FastAPI）。

替代 app→宿主机的 SSH/scp 远程执行：收 bundle → 在本机以沉淀的 opp_env 指令跑
inet + scavetool → 回原始 CSV + exit + stderr。app 端 HttpRunner 内部 POST→轮询→取
result，映射成与 SSH 路径同样的 SimRunOutcome（plan KTD1/KTD4）。

端点（plan 高层设计）：
  GET  /sim/healthz                  前置验证（R11）
  POST /sim/run                      提交 bundle，返回 job_id（忙时 409）—— U2
  GET  /sim/run/{job_id}/status      查状态 —— U3
  GET  /sim/run/{job_id}/result      取结果（exit/csv/stderr）—— U3
"""

from __future__ import annotations

from fastapi import FastAPI

import preflight

app = FastAPI(title="inet-sim-http", version="0.1.0")


@app.get("/sim/healthz")
def healthz() -> dict:
    """前置验证：宿主机依赖齐不齐（nix/opp_env/python/run_dir）。"""
    return preflight.summary()
