"""薄 HTTP 软仿服务（FastAPI）。

替代 app→宿主机的 SSH/scp 远程执行：收 bundle → 在本机以沉淀的 opp_env 指令跑
inet + scavetool → 回原始 CSV + exit + stderr。app 端 HttpRunner 内部 POST→轮询→取
result，映射成与 SSH 路径同样的 SimRunOutcome（plan KTD1/KTD4）。

端点：
  GET  /sim/healthz                  前置验证（R11）
  POST /sim/run                      提交 bundle(tar)+filter，返回 job_id（忙时 409、坏包 400）
  GET  /sim/run/{job_id}/status      查状态（queued/running/done/failed）
  GET  /sim/run/{job_id}/result      取结果（exit_code/output_tail/csv/scavetool_failed）
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

import preflight
import runner


@asynccontextmanager
async def lifespan(_app: FastAPI):
    runner.gc()  # 启动时回收旧 run 目录
    yield


app = FastAPI(title="inet-sim-http", version="0.1.0", lifespan=lifespan)


@app.get("/sim/healthz")
def healthz() -> dict:
    """前置验证：宿主机依赖齐不齐（nix/opp_env/python/run_dir）。"""
    return preflight.summary()


@app.post("/sim/run")
async def run(bundle: UploadFile, scavetool_filter: str = Form(...)) -> JSONResponse:
    """提交软仿：收 bundle tar + scavetool filter，返回 job_id。单运行忙时 409、坏包 400。"""
    tar_bytes = await bundle.read()
    try:
        job_id = runner.submit(tar_bytes, scavetool_filter)
    except runner.Busy as err:
        raise HTTPException(status_code=409, detail=str(err)) from err
    except runner.BadBundle as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/sim/run/{job_id}/status")
def status(job_id: str) -> dict:
    job = runner.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="未知 job_id")
    return {"status": job.status}


@app.get("/sim/run/{job_id}/result")
def result(job_id: str) -> dict:
    """取结果：done 才回 {exit_code, output_tail, csv, scavetool_failed}；
    failed → 500 带原因；运行中 → 409；未知 → 404。"""
    job = runner.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="未知 job_id")
    if job.status == "failed":
        raise HTTPException(status_code=500, detail=job.error or "软仿执行失败")
    if job.status != "done" or job.result is None:
        raise HTTPException(status_code=409, detail="软仿尚未完成")
    return job.result
