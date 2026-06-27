"""U1：前置验证 + healthz。"""

import config
import preflight
from fastapi.testclient import TestClient

import app as app_module


def _seed_ok_deps(tmp_path, monkeypatch):
    nix = tmp_path / "nix-daemon.sh"
    nix.write_text("# stub")
    opp = tmp_path / "opp_env"
    opp.write_text("#!/bin/sh")
    opp.chmod(0o755)
    monkeypatch.setattr(config, "NIX_PROFILE_SCRIPT", str(nix))
    monkeypatch.setattr(config, "OPP_ENV_BIN", str(opp))
    monkeypatch.setattr(config, "RUN_BASE_DIR", str(tmp_path / "runs"))


def test_all_checks_pass(tmp_path, monkeypatch):
    _seed_ok_deps(tmp_path, monkeypatch)
    s = preflight.summary()
    assert s["ok"] is True
    assert all(c["ok"] for c in s["checks"].values())
    assert set(s["checks"]) == {"nix", "opp_env", "python", "run_dir"}


def test_missing_opp_env_reports_not_ok(tmp_path, monkeypatch):
    _seed_ok_deps(tmp_path, monkeypatch)
    monkeypatch.setattr(config, "OPP_ENV_BIN", str(tmp_path / "does-not-exist"))
    s = preflight.summary()
    assert s["ok"] is False
    assert s["checks"]["opp_env"]["ok"] is False
    assert "does-not-exist" in s["checks"]["opp_env"]["detail"]


def test_missing_nix_profile_reports_not_ok(tmp_path, monkeypatch):
    _seed_ok_deps(tmp_path, monkeypatch)
    monkeypatch.setattr(config, "NIX_PROFILE_SCRIPT", str(tmp_path / "no-nix.sh"))
    s = preflight.summary()
    assert s["ok"] is False
    assert s["checks"]["nix"]["ok"] is False


def test_run_dir_unwritable_reports_not_ok(tmp_path, monkeypatch):
    _seed_ok_deps(tmp_path, monkeypatch)
    # 把 RUN_BASE_DIR 指到一个「父级是文件」的路径 → makedirs 必失败（NotADirectoryError）。
    blocker = tmp_path / "blocker"
    blocker.write_text("i am a file, not a dir")
    monkeypatch.setattr(config, "RUN_BASE_DIR", str(blocker / "runs"))
    s = preflight.summary()
    assert s["ok"] is False
    assert s["checks"]["run_dir"]["ok"] is False


def test_healthz_responds_even_when_deps_missing(tmp_path, monkeypatch):
    # 依赖缺失时 healthz 仍须 200 + 结构化，不能 500（plan U1 验收）。
    monkeypatch.setattr(config, "OPP_ENV_BIN", str(tmp_path / "nope"))
    monkeypatch.setattr(config, "NIX_PROFILE_SCRIPT", str(tmp_path / "nope.sh"))
    monkeypatch.setattr(config, "RUN_BASE_DIR", str(tmp_path / "runs"))
    client = TestClient(app_module.app)
    resp = client.get("/sim/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert "ok" in body and "checks" in body
    assert body["ok"] is False  # opp_env/nix 缺
