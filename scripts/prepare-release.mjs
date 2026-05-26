#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  writeFileSync(join(rootDir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid semver version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function bumpVersion(version, bump) {
  if (bump === "major") {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }
  if (bump === "minor") {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }
  if (bump === "patch") {
    return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }
  return version;
}

function latestReleaseTag() {
  return tryGit([
    "tag",
    "--merged",
    "HEAD",
    "--list",
    "v[0-9]*.[0-9]*.[0-9]*",
    "--sort=-v:refname",
  ])
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function readJsonFromHead(relativePath) {
  const raw = tryGit(["show", `HEAD:${relativePath}`]);
  return raw ? JSON.parse(raw) : null;
}

function collectCommits(fromTag) {
  const range = fromTag ? `${fromTag}..HEAD` : "HEAD";
  const raw = tryGit(["log", range, "--format=%H%x1f%s%x1f%b%x1e"]);
  if (!raw) {
    return [];
  }

  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body = ""] = record.split("\x1f");
      const conventional = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<summary>.+)$/i.exec(
        subject,
      );
      return {
        hash,
        shortHash: hash.slice(0, 7),
        subject,
        body,
        type: conventional?.groups?.type?.toLowerCase() ?? "other",
        summary: conventional?.groups?.summary ?? subject,
        breaking:
          conventional?.groups?.breaking === "!" ||
          /(^|\n)BREAKING CHANGE:/i.test(body) ||
          /(^|\n)BREAKING-CHANGE:/i.test(body),
      };
    });
}

function decideBump(commits) {
  if (commits.some((commit) => commit.breaking)) {
    return "major";
  }
  if (commits.some((commit) => commit.type === "feat")) {
    return "minor";
  }
  if (commits.length > 0) {
    return "patch";
  }
  return "none";
}

const exactTranslations = new Map([
  ["integrate planner service workflow", "接入规划服务工作流"],
  ["handle crlf skill frontmatter", "处理 skill frontmatter 的 CRLF 兼容"],
  ["add production desktop build", "新增生产桌面端构建"],
  ["stabilize tsn skill production flow", "稳定 TSN skill 生产流程"],
  ["clean skill traces and topology edits", "清理 skill 运行痕迹和拓扑编辑"],
  ["use neutral topology empty state", "使用中性的拓扑空状态"],
  ["wire real tsn stage skills", "接入真实 TSN 阶段 skill"],
  ["initialize agent project context", "初始化 Agent 项目上下文"],
  ["add staged tsn planning workflow", "新增分阶段 TSN 规划工作流"],
  ["complete tsn agent desktop mvp", "完成 TSN Agent 桌面端 MVP"],
  ["scaffold tsn agent mvp", "初始化 TSN Agent MVP"],
]);

const wordReplacements = [
  [/\bintegrate\b/gi, "接入"],
  [/\badd\b/gi, "新增"],
  [/\bhandle\b/gi, "处理"],
  [/\bstabilize\b/gi, "稳定"],
  [/\bclean\b/gi, "清理"],
  [/\buse\b/gi, "使用"],
  [/\bwire\b/gi, "接入"],
  [/\binitialize\b/gi, "初始化"],
  [/\bcomplete\b/gi, "完成"],
  [/\bscaffold\b/gi, "初始化"],
  [/\bplanner service workflow\b/gi, "规划服务工作流"],
  [/\bproduction desktop build\b/gi, "生产桌面端构建"],
  [/\bstaged TSN planning workflow\b/gi, "分阶段 TSN 规划工作流"],
  [/\bdesktop MVP\b/gi, "桌面端 MVP"],
];

function chineseSummary(summary) {
  if (/[\u4e00-\u9fff]/.test(summary)) {
    return summary;
  }

  const exact = exactTranslations.get(summary.toLowerCase());
  if (exact) {
    return exact;
  }

  let translated = summary;
  for (const [pattern, replacement] of wordReplacements) {
    translated = translated.replace(pattern, replacement);
  }

  return /[\u4e00-\u9fff]/.test(translated) ? translated : `更新 ${summary}`;
}

function categoryFor(commit) {
  if (commit.breaking) {
    return "breaking";
  }
  if (commit.type === "feat") {
    return "features";
  }
  if (commit.type === "fix") {
    return "fixes";
  }
  if (commit.type === "perf") {
    return "performance";
  }
  if (commit.type === "docs") {
    return "docs";
  }
  if (commit.type === "test") {
    return "tests";
  }
  if (["build", "ci", "chore", "refactor"].includes(commit.type)) {
    return "engineering";
  }
  return "other";
}

const categoryTitles = [
  ["breaking", "破坏性变更"],
  ["features", "新功能"],
  ["fixes", "修复"],
  ["performance", "性能优化"],
  ["other", "其他"],
];

const internalCategoryTitles = [
  ["engineering", "工程与构建"],
  ["docs", "文档"],
  ["tests", "测试"],
];

function releaseDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function buildChangelogEntry(version, commits, previousTag) {
  const lines = [`## v${version} - ${releaseDate()}`, ""];

  if (commits.length === 0) {
    lines.push("- 无代码变更，仅重新构建发布产物。", "");
    return lines.join("\n");
  }

  const byCategory = new Map(categoryTitles.map(([key]) => [key, []]));
  for (const commit of commits) {
    const category = categoryFor(commit);
    if (byCategory.has(category)) {
      byCategory.get(category).push(commit);
    }
  }

  let visibleEntryCount = 0;
  for (const [key, title] of categoryTitles) {
    const entries = byCategory.get(key);
    if (!entries.length) {
      continue;
    }
    visibleEntryCount += entries.length;
    lines.push(`### ${title}`, "");
    for (const commit of entries) {
      lines.push(`- ${chineseSummary(commit.summary)}`);
    }
    lines.push("");
  }

  if (visibleEntryCount === 0) {
    lines.push("### 其他", "", "- 包含稳定性、兼容性和发布流程改进。", "");
  }

  return lines.join("\n");
}

function buildInternalReleaseDetails(commits) {
  const lines = [];

  if (commits.length === 0) {
    return lines.join("\n");
  }

  const byCategory = new Map(internalCategoryTitles.map(([key]) => [key, []]));
  for (const commit of commits) {
    const category = categoryFor(commit);
    if (byCategory.has(category)) {
      byCategory.get(category).push(commit);
    }
  }

  for (const [key, title] of internalCategoryTitles) {
    const entries = byCategory.get(key);
    if (!entries.length) {
      continue;
    }
    lines.push(`### ${title}`, "");
    for (const commit of entries) {
      lines.push(`- ${chineseSummary(commit.summary)}（${commit.shortHash}）`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function writeChangelog(version, entry) {
  const changelogPath = join(rootDir, "CHANGELOG.md");
  const current = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const title = "# 更新日志\n\n";
  const intro =
    "本文件用于在应用内展示客户可见的更新内容。技术名词、文件名和产品名保留原文。\n\n";
  const existingBody = current
    .replace(/^# 更新日志\s*/u, "")
    .replace(/^本文件由 `npm run release:prepare`[^\n]*\n+/u, "")
    .trim();
  const existingSections = existingBody
    .split(/(?=^## )/mu)
    .map((section) => section.trim())
    .filter(Boolean)
    .filter((section) => !section.startsWith(`## v${version} `));
  const suffix = existingSections.length ? `\n${existingSections.join("\n\n")}\n` : "";
  const next = `${title}${intro}${entry.trim()}\n${suffix}`;
  writeFileSync(changelogPath, next);
}

function writeReleaseNotes(version, entry, metadata, internalDetails) {
  const lines = [
    `# TSN Agent v${version}`,
    "",
    `升级类型：${metadata.bump}`,
    `提交数量：${metadata.commitCount}`,
    "",
    entry.trim(),
    "",
  ];

  if (metadata.previousTag) {
    lines.push(`基准版本：\`${metadata.previousTag}\``, "");
  }

  if (internalDetails) {
    lines.push("## 内部变更", "", internalDetails, "");
  }

  writeFileSync(join(rootDir, "release-notes.md"), lines.join("\n"));
}

function updateCargoTomlVersion(version) {
  const cargoTomlPath = join(rootDir, "src-tauri", "Cargo.toml");
  const lines = readFileSync(cargoTomlPath, "utf8").split("\n");
  let inPackage = false;
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\[package\]\s*$/.test(line)) {
      inPackage = true;
      return line;
    }
    if (/^\[.+\]\s*$/.test(line) && !/^\[package\]\s*$/.test(line)) {
      inPackage = false;
    }
    if (inPackage && !replaced && /^version\s*=/.test(line)) {
      replaced = true;
      return `version = "${version}"`;
    }
    return line;
  });
  writeFileSync(cargoTomlPath, next.join("\n"));
}

function updateCargoLockVersion(version) {
  const cargoLockPath = join(rootDir, "src-tauri", "Cargo.lock");
  if (!existsSync(cargoLockPath)) {
    return;
  }

  const lines = readFileSync(cargoLockPath, "utf8").split("\n");
  let inPackage = false;
  let isTsnAgent = false;
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\[\[package\]\]\s*$/.test(line)) {
      inPackage = true;
      isTsnAgent = false;
      return line;
    }
    if (inPackage && /^name\s*=\s*"tsn-agent"\s*$/.test(line)) {
      isTsnAgent = true;
      return line;
    }
    if (inPackage && isTsnAgent && !replaced && /^version\s*=/.test(line)) {
      replaced = true;
      return `version = "${version}"`;
    }
    return line;
  });
  writeFileSync(cargoLockPath, next.join("\n"));
}

function writeGitHubOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

const packageJson = readJson("package.json");
const tag = latestReleaseTag();
const headPackageJson = readJsonFromHead("package.json");
const baseVersion = parseVersion(tag ?? headPackageJson?.version ?? packageJson.version);
const commits = collectCommits(tag);
const bump = decideBump(commits);
const nextVersion = formatVersion(bumpVersion(baseVersion, bump));
const changelogEntry = buildChangelogEntry(nextVersion, commits, tag);
const internalDetails = buildInternalReleaseDetails(commits);
const metadata = {
  version: nextVersion,
  previousVersion: formatVersion(baseVersion),
  previousTag: tag ?? null,
  bump,
  commitCount: commits.length,
  generatedAt: new Date().toISOString(),
};

if (!dryRun) {
  packageJson.version = nextVersion;
  writeJson("package.json", packageJson);

  const packageLock = readJson("package-lock.json");
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
  writeJson("package-lock.json", packageLock);

  const tauriConfig = readJson("src-tauri/tauri.conf.json");
  tauriConfig.version = nextVersion;
  writeJson("src-tauri/tauri.conf.json", tauriConfig);

  updateCargoTomlVersion(nextVersion);
  updateCargoLockVersion(nextVersion);
  writeChangelog(nextVersion, changelogEntry);
  writeJson("release-metadata.json", metadata);
  writeReleaseNotes(nextVersion, changelogEntry, metadata, internalDetails);
  writeGitHubOutput(metadata);
}

console.log(`Release version: v${nextVersion}`);
console.log(`Bump: ${bump}`);
console.log(`Commits: ${commits.length}`);
if (tag) {
  console.log(`Previous tag: ${tag}`);
}
if (dryRun) {
  console.log("Dry run only; no files were changed.");
}
