"""U2/U3：runner（执行 + 单运行 + 路径穿越防护 + GC）。mock _run_in_inet_env 避免真跑 opp_env。"""

import io
import os
import subprocess
import tarfile
import threading
import time

import config
import pytest
import runner


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RUN_BASE_DIR", str(tmp_path / "runs"))
    runner._jobs.clear()
    yield
    runner._jobs.clear()


def _make_tar(members: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, content in members.items():
            data = content.encode()
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _bundle() -> bytes:
    return _make_tar(
        {
            "tsnagent/generated/network.ned": "network Net {}",
            "omnetpp.ini": "[General]\n",
            "manifest.json": "{}",
        }
    )


def _fake_inet_env(inet_rc=0, inet_out="inet ran", scave_rc=0, scave_out="csv-data"):
    def fake(inner: str) -> subprocess.CompletedProcess:
        if "opp_scavetool" in inner:
            return subprocess.CompletedProcess([], scave_rc, scave_out, "")
        return subprocess.CompletedProcess([], inet_rc, inet_out, "")

    return fake


def _wait_done(job_id: str, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = runner.get_job(job_id)
        if job and job.status in ("done", "failed"):
            return job
        time.sleep(0.02)
    raise AssertionError("job 未在超时内完成")


def test_happy_path_returns_csv(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env(scave_out="module,name,vectime,vecvalue\n"))
    job_id = runner.submit(_bundle(), "filt")
    job = _wait_done(job_id)
    assert job.status == "done"
    assert job.result["exit_code"] == 0
    assert job.result["csv"] == "module,name,vectime,vecvalue\n"
    assert job.result["scavetool_failed"] is False
    # bundle 解包到位
    assert os.path.isfile(os.path.join(job.run_dir, "omnetpp.ini"))
    assert os.path.isfile(os.path.join(job.run_dir, "tsnagent/generated/network.ned"))


def test_inet_nonzero_exit_skips_scavetool(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env(inet_rc=1, inet_out="boom"))
    job = _wait_done(runner.submit(_bundle(), "filt"))
    assert job.result["exit_code"] == 1
    assert job.result["csv"] is None
    assert job.result["scavetool_failed"] is False


def test_scavetool_empty_is_not_failure(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env(scave_out="   \n"))
    job = _wait_done(runner.submit(_bundle(), "filt"))
    assert job.result["csv"] is None
    assert job.result["scavetool_failed"] is False  # 跑成功但 0 行 → 结果为空，非失败


def test_scavetool_nonzero_is_failure(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env(scave_rc=2, scave_out=""))
    job = _wait_done(runner.submit(_bundle(), "filt"))
    assert job.result["csv"] is None
    assert job.result["scavetool_failed"] is True


def test_path_traversal_rejected(monkeypatch):
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env())
    evil = _make_tar({"../evil.txt": "pwned", "omnetpp.ini": "x"})
    with pytest.raises(runner.BadBundle):
        runner.submit(evil, "filt")
    # 没写到 run 目录外
    assert not os.path.exists(os.path.join(os.path.dirname(config.RUN_BASE_DIR), "evil.txt"))


def test_single_run_rejects_second(monkeypatch):
    gate = threading.Event()

    def blocking(inner: str) -> subprocess.CompletedProcess:
        gate.wait(timeout=5)
        return subprocess.CompletedProcess([], 0, "ok", "")

    monkeypatch.setattr(runner, "_run_in_inet_env", blocking)
    first = runner.submit(_bundle(), "filt")  # 卡在 inet 上
    with pytest.raises(runner.Busy):
        runner.submit(_bundle(), "filt")
    gate.set()
    _wait_done(first)
    # 第一个完成后可再提交
    monkeypatch.setattr(runner, "_run_in_inet_env", _fake_inet_env())
    second = runner.submit(_bundle(), "filt")
    assert second != first


def test_gc_keeps_recent_n(monkeypatch):
    base = config.RUN_BASE_DIR
    os.makedirs(base, exist_ok=True)
    for i in range(5):
        d = os.path.join(base, f"run-{i:02d}")
        os.makedirs(d)
        # 错开 mtime
        os.utime(d, (i, i))
    other = os.path.join(base, "not-a-run")
    os.makedirs(other)
    removed = runner.gc(retention=2)
    assert removed == 3
    remaining = sorted(n for n in os.listdir(base) if n.startswith("run-"))
    assert remaining == ["run-03", "run-04"]  # mtime 最新两个
    assert os.path.isdir(other)  # 非 run-* 不动
