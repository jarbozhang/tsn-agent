"""U2/U3：HTTP 端点（run/status/result）。mock _run_in_inet_env 避免真跑 opp_env。"""

import io
import subprocess
import tarfile
import threading
import time

import config
import pytest
import runner
from fastapi.testclient import TestClient

import app as app_module

client = TestClient(app_module.app)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RUN_BASE_DIR", str(tmp_path / "runs"))
    runner._jobs.clear()
    yield
    runner._jobs.clear()


def _tar(members: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, content in members.items():
            data = content.encode()
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _bundle() -> bytes:
    return _tar({"tsnagent/generated/network.ned": "n", "omnetpp.ini": "[General]\n", "manifest.json": "{}"})


def _mock_ok(monkeypatch, csv="module,name,vectime,vecvalue\n"):
    def fake(inner: str) -> subprocess.CompletedProcess:
        if "opp_scavetool" in inner:
            return subprocess.CompletedProcess([], 0, csv, "")
        return subprocess.CompletedProcess([], 0, "inet ran", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", fake)


def _post_run(tar_bytes: bytes):
    return client.post(
        "/sim/run",
        files={"bundle": ("bundle.tar", tar_bytes, "application/x-tar")},
        data={"scavetool_filter": "module=~clock"},
    )


def _poll_status(job_id: str, timeout=5.0) -> str:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = client.get(f"/sim/run/{job_id}/status").json()["status"]
        if last in ("done", "failed"):
            return last
        time.sleep(0.02)
    return last


def test_run_status_result_happy(monkeypatch):
    _mock_ok(monkeypatch)
    resp = _post_run(_bundle())
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    assert job_id.startswith("run-")
    assert _poll_status(job_id) == "done"
    result = client.get(f"/sim/run/{job_id}/result")
    assert result.status_code == 200
    body = result.json()
    assert body["exit_code"] == 0
    assert body["csv"] == "module,name,vectime,vecvalue\n"
    assert body["scavetool_failed"] is False


def test_bad_bundle_returns_400(monkeypatch):
    _mock_ok(monkeypatch)
    resp = _post_run(_tar({"../evil.txt": "x", "omnetpp.ini": "y"}))
    assert resp.status_code == 400


def test_busy_returns_409(monkeypatch):
    gate = threading.Event()

    def blocking(inner: str) -> subprocess.CompletedProcess:
        gate.wait(timeout=5)
        return subprocess.CompletedProcess([], 0, "ok", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", blocking)
    first = _post_run(_bundle())
    assert first.status_code == 202
    second = _post_run(_bundle())
    assert second.status_code == 409
    gate.set()
    _poll_status(first.json()["job_id"])


def test_status_unknown_404():
    assert client.get("/sim/run/run-nope/status").status_code == 404


def test_result_unknown_404():
    assert client.get("/sim/run/run-nope/result").status_code == 404


def test_result_before_done_409(monkeypatch):
    gate = threading.Event()

    def blocking(inner: str) -> subprocess.CompletedProcess:
        gate.wait(timeout=5)
        return subprocess.CompletedProcess([], 0, "ok", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", blocking)
    job_id = _post_run(_bundle()).json()["job_id"]
    early = client.get(f"/sim/run/{job_id}/result")
    assert early.status_code == 409
    gate.set()
    _poll_status(job_id)
