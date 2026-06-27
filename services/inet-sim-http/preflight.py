"""前置验证（plan R11）：服务启动 + healthz 端点都用它校验宿主机依赖。

只做轻量存在性/可写性检查，不实跑 opp_env（首跑编译数分钟）。缺任一项 → ok=false +
缺失原因，让 app 端能展示「缺哪项」，而不是接了软仿任务才在中途跑挂。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import config


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


def _run_dir_writable() -> tuple[bool, str]:
    try:
        os.makedirs(config.RUN_BASE_DIR, exist_ok=True)
        probe = os.path.join(config.RUN_BASE_DIR, ".preflight-probe")
        with open(probe, "w") as fh:
            fh.write("ok")
        os.remove(probe)
        return True, config.RUN_BASE_DIR
    except OSError as err:
        return False, f"{config.RUN_BASE_DIR} 不可写：{err}"


def run_checks() -> list[Check]:
    checks: list[Check] = []

    nix_ok = os.path.isfile(config.NIX_PROFILE_SCRIPT)
    checks.append(
        Check(
            "nix",
            nix_ok,
            config.NIX_PROFILE_SCRIPT if nix_ok else f"缺 {config.NIX_PROFILE_SCRIPT}",
        )
    )

    opp_ok = os.path.isfile(config.OPP_ENV_BIN) and os.access(config.OPP_ENV_BIN, os.X_OK)
    checks.append(
        Check(
            "opp_env",
            opp_ok,
            config.OPP_ENV_BIN if opp_ok else f"缺可执行 {config.OPP_ENV_BIN}",
        )
    )

    try:
        import fastapi  # noqa: F401

        python_ok, python_detail = True, "fastapi 就绪"
    except ImportError as err:
        python_ok, python_detail = False, f"fastapi 缺失：{err}"
    checks.append(Check("python", python_ok, python_detail))

    run_ok, run_detail = _run_dir_writable()
    checks.append(Check("run_dir", run_ok, run_detail))

    return checks


def summary() -> dict:
    """healthz 响应体：{ok, checks:{name:{ok,detail}}}。"""
    checks = run_checks()
    return {
        "ok": all(c.ok for c in checks),
        "checks": {c.name: {"ok": c.ok, "detail": c.detail} for c in checks},
    }
