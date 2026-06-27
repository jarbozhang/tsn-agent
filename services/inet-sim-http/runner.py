"""软仿执行器：在宿主机本地复刻 app 侧 SSH 路径（inet_remote.rs SshRunner）的命令，
区别只是去掉 ssh/scp、改本地解包 + 子进程。结果形状（exit_code/output_tail/csv/
scavetool_failed）与 SimRunOutcome 对齐，app 端 HttpRunner 直接映射（plan KTD1/R1）。

单运行（plan R6）：同一时刻只跑一个软仿，忙时 submit 抛 Busy（端点转 409）。
异步：submit 立即返回 job_id，真正执行在后台线程；app 轮询 status/result。
"""

from __future__ import annotations

import io
import os
import secrets
import shlex
import subprocess
import sys
import tarfile
import threading
import time
from dataclasses import dataclass, field

import config

_OUTPUT_TAIL_MAX = 2000


class Busy(Exception):
    """已有软仿在跑（单运行）。"""


class BadBundle(Exception):
    """bundle 解包失败 / 含路径穿越。"""


@dataclass
class Job:
    job_id: str
    status: str = "queued"  # queued | running | done | failed
    result: dict | None = None  # {exit_code, output_tail, csv, scavetool_failed}
    error: str | None = None  # status=failed 时的内部原因
    created_at: float = field(default_factory=time.time)
    run_dir: str | None = None


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def _gen_run_id() -> str:
    """run-<16 hex>，随机源（不用时钟，避碰撞 + 不可预测），仅 [a-z0-9-]（对齐 SSH 路径）。"""
    return "run-" + secrets.token_hex(8)


def _tail(text: str, limit: int = _OUTPUT_TAIL_MAX) -> str:
    if len(text) <= limit:
        return text
    return "…" + text[-limit:]


def _safe_extract(tar_bytes: bytes, dest_dir: str) -> None:
    """把 bundle tar 解包到 dest_dir，拒绝任何逃出 dest_dir 的成员（路径穿越防护，plan R9）。"""
    dest_abs = os.path.realpath(dest_dir)
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:*") as tar:
        for member in tar.getmembers():
            target = os.path.realpath(os.path.join(dest_dir, member.name))
            if target != dest_abs and not target.startswith(dest_abs + os.sep):
                raise BadBundle(f"bundle 含越界路径：{member.name}")
            if member.issym() or member.islnk():
                raise BadBundle(f"bundle 含链接（不允许）：{member.name}")
        # 手工校验已挡穿越；filter="data"（Py3.12+）再加一层 + 消弭弃用告警，旧 Py 回退。
        if sys.version_info >= (3, 12):
            tar.extractall(dest_dir, filter="data")
        else:
            tar.extractall(dest_dir)


def _run_in_inet_env(inner: str) -> subprocess.CompletedProcess:
    """以 `<INET_ENV_CMD> -c '<inner>'` 在 OMNeT++/INET 环境里跑 inner（bash 解释整条）。"""
    full = f"{config.INET_ENV_CMD} -c {shlex.quote(inner)}"
    return subprocess.run(
        ["bash", "-c", full],
        capture_output=True,
        text=True,
        timeout=config.CMD_TIMEOUT_S,
    )


def _execute_run(job: Job, scavetool_filter: str) -> None:
    """后台线程体：跑 inet → （exit 0 则）跑 scavetool 取 CSV → 落 result。
    解包已在 submit 同步完成（job.run_dir 就绪）。"""
    run_dir = job.run_dir
    try:
        # 跑 inet（与 inet_remote.rs remote_run_cmd 同形）。
        inet_inner = f"cd {shlex.quote(run_dir)} && inet -u Cmdenv -f omnetpp.ini -n ."
        inet = _run_in_inet_env(inet_inner)
        combined = (inet.stdout or "") + (inet.stderr or "")
        exit_code = inet.returncode

        if exit_code != 0:
            # inet 非 0 → load_failed：不取数，csv=None（app 端 classify 分型）。
            _set_result(job, exit_code, _tail(combined), None, False)
            return

        # 跑 scavetool（与 inet_remote.rs remote_scavetool_cmd 同形：导出 CSV-R 再 cat）。
        scave_inner = (
            f"cd {shlex.quote(run_dir)} && opp_scavetool export -f {shlex.quote(scavetool_filter)} "
            "-F CSV-R -o timechanged.csv results/*.vec >/dev/null 2>&1 && cat timechanged.csv"
        )
        scave = _run_in_inet_env(scave_inner)
        if scave.returncode == 0:
            out = scave.stdout or ""
            csv = out if out.strip() else None  # 跑成功但 0 行 → 真·结果为空
            _set_result(job, exit_code, _tail(combined), csv, False)
        else:
            # 非零退出/缺失 → 命令失败（区别于结果为空）。
            _set_result(job, exit_code, _tail(combined), None, True)
    except subprocess.TimeoutExpired:
        _set_failed(job, "命令超时")
    except OSError as err:
        _set_failed(job, f"执行出错：{err}")


def _set_result(job: Job, exit_code: int, output_tail: str, csv: str | None, scavetool_failed: bool) -> None:
    with _lock:
        job.result = {
            "exit_code": exit_code,
            "output_tail": output_tail,
            "csv": csv,
            "scavetool_failed": scavetool_failed,
        }
        job.status = "done"


def _set_failed(job: Job, reason: str) -> None:
    with _lock:
        job.error = reason
        job.status = "failed"


def _has_active_job() -> bool:
    return any(j.status in ("queued", "running") for j in _jobs.values())


def submit(tar_bytes: bytes, scavetool_filter: str) -> str:
    """单运行：有活跃任务则抛 Busy。同步解包（坏 bundle 立即抛 BadBundle→端点 400），
    再起后台线程跑慢的 inet+scavetool，立即返回 job_id。"""
    with _lock:
        if _has_active_job():
            raise Busy("已有软仿在运行")
        job = Job(job_id=_gen_run_id(), status="running")
        _jobs[job.job_id] = job
    run_dir = os.path.join(config.RUN_BASE_DIR, job.job_id)
    job.run_dir = run_dir
    try:
        os.makedirs(run_dir, exist_ok=True)
        _safe_extract(tar_bytes, run_dir)  # 同步：路径穿越/坏包立即失败
    except (BadBundle, OSError) as err:
        _set_failed(job, str(err))
        raise BadBundle(str(err)) from err
    thread = threading.Thread(
        target=_execute_run, args=(job, scavetool_filter), daemon=True
    )
    thread.start()
    return job.job_id


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def gc(retention: int | None = None) -> int:
    """回收旧 run 目录：保留 mtime 最新的 retention 个 run-* 目录，删其余。返回删除数。
    服务启动时调用。只动 run-* 目录（不碰 base_dir 下其它东西）。"""
    keep = config.RUN_RETENTION if retention is None else retention
    base = config.RUN_BASE_DIR
    try:
        entries = [
            os.path.join(base, n)
            for n in os.listdir(base)
            if n.startswith("run-") and os.path.isdir(os.path.join(base, n))
        ]
    except OSError:
        return 0
    entries.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    removed = 0
    for path in entries[keep:]:
        try:
            import shutil

            shutil.rmtree(path)
            removed += 1
        except OSError:
            pass
    return removed
