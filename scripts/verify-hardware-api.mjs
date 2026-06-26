#!/usr/bin/env node

// U9：tsn-sim 硬件部署服务的连通性 + 版本回归 e2e 校验脚本。
//
// 打 healthz / version / task_check，断言返回结构与字段；任一失败非零退出。
// 服务在线时打印当前版本（供版本回归比对）；网络不可达时给清晰提示（区别于服务异常）。
//
// 用法：node scripts/verify-hardware-api.mjs
// 服务地址：env TSN_AGENT_HARDWARE_API_URL，默认 http://100.78.48.43:19080
//
// 注意：本脚本打的是真实远端服务（需在 Tailscale 网络内可达），不是单元测试——作 e2e 用例。

const BASE_URL = (process.env.TSN_AGENT_HARDWARE_API_URL ?? "http://100.78.48.43:19080").replace(
  /\/$/,
  "",
);
const TIMEOUT_MS = 10_000;

let failures = 0;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  failures += 1;
}

function assert(cond, msg) {
  if (cond) pass(msg);
  else fail(msg);
}

async function call(method, path, body) {
  const url = `${BASE_URL}/sim/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`tsn-sim 硬件 API 校验 @ ${BASE_URL}\n`);

  // 1) GET /sim/healthz
  console.log("GET /sim/healthz");
  const health = await call("GET", "healthz");
  assert(health.ok, `HTTP ${health.status}`);
  assert(
    health.json?.status === "ok" || health.json?.status === "degraded",
    `status 合法（ok/degraded），实际：${JSON.stringify(health.json?.status)}`,
  );
  assert(
    typeof health.json?.queue_depth === "number" && typeof health.json?.queue_capacity === "number",
    "queue_depth / queue_capacity 为数字",
  );

  // 2) GET /sim/version（记录版本供回归比对）
  console.log("GET /sim/version");
  const version = await call("GET", "version");
  assert(version.ok, `HTTP ${version.status}`);
  assert(typeof version.json?.tsn_sim_version === "string", "tsn_sim_version 存在");
  assert(typeof version.json?.api_version === "string", "api_version 存在");
  if (version.json?.tsn_sim_version) {
    console.log(
      `  → 版本：tsn_sim=${version.json.tsn_sim_version} api=${version.json.api_version}`,
    );
  }

  // 3) POST /sim/task_check（环境检查，只断言结构含 hardware.available）
  console.log("POST /sim/task_check");
  const check = await call("POST", "task_check", {});
  assert(check.ok, `HTTP ${check.status}`);
  assert(typeof check.json?.hardware?.available === "boolean", "hardware.available 为布尔");
  if (check.json?.hardware) {
    console.log(
      `  → 硬件可用：${check.json.hardware.available}${
        check.json.hardware.reason ? `（${check.json.hardware.reason}）` : ""
      }`,
    );
  }

  console.log("");
  if (failures > 0) {
    console.error(`✗ ${failures} 项断言失败。`);
    process.exit(1);
  }
  console.log("✓ 全部通过。");
}

main().catch((err) => {
  if (err?.name === "AbortError") {
    console.error(
      `\n✗ 请求超时（${TIMEOUT_MS}ms）：服务可能未启动或网络不可达（确认在 Tailscale 网络内）。`,
    );
  } else {
    console.error(`\n✗ 无法连接 ${BASE_URL}：${err?.message ?? err}`);
    console.error("  提示：确认服务已启动、地址正确、且本机在 Tailscale 网络内。");
  }
  process.exit(1);
});
