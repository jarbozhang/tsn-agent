#!/usr/bin/env node
// 把当前平台的 Claude Code native binary 复制到 src-node/dist/claude-runtime/，
// 供 tauri 打进 release bundle（resources）。SDK 默认从 node_modules 的平台包
// (@anthropic-ai/claude-agent-sdk-{platform}-{arch}) 找 claude，bundle 后不存在，
// 故打包态由 worker 显式 pathToClaudeCodeExecutable 指向这个复制出来的副本。
// 本地 + CI 的 build:worker 都跑此脚本，保证 tauri resources 引用的目录始终存在。

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = process.platform === "win32" ? "claude.exe" : "claude";
const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
const src = join(root, "node_modules", "@anthropic-ai", pkg, exe);
const destDir = join(root, "src-node", "dist", "claude-runtime");
const dest = join(destDir, exe);

if (!existsSync(src)) {
  console.error(
    `copy-claude-binary: 找不到平台 binary ${src}\n` +
      `  平台包 @anthropic-ai/${pkg} 可能未安装（optionalDependencies 按平台装）。`,
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

// binary ~208MB，已存在且大小一致就跳过，避免每次 build 重复复制。
if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
  console.log(`copy-claude-binary: ${exe} 已是最新，跳过`);
} else {
  copyFileSync(src, dest);
  if (process.platform !== "win32") {
    chmodSync(dest, 0o755);
  }
  const mb = (statSync(dest).size / 1024 / 1024).toFixed(0);
  console.log(`copy-claude-binary: 复制 ${pkg}/${exe} (${mb}MB) → src-node/dist/claude-runtime/`);
}
