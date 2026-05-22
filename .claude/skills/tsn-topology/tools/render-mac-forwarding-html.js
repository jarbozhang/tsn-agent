#!/usr/bin/env node
// render-mac-forwarding-html.js
// mac-forwarding-table.json -> mac-forwarding-table.html
//
// 用法:
//   作为库:  const { renderHtml } = require('./render-mac-forwarding-html')
//   作为 CLI: node render-mac-forwarding-html.js <mac-forwarding-table.json>
//             stdout: HTML
//             stderr JSON (失败时): {ok:false, stage:'render', error:{type,message}}
//             exit 0 = ok
//                  2 = io/用法错误

'use strict';

const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRows(entries) {
  if (entries.length === 0) {
    return '        <tr><td colspan="4" class="empty">No MAC forwarding entries</td></tr>';
  }

  return entries.map((entry) => (
    `        <tr>` +
    `<td>${escapeHtml(entry.switch_name)}</td>` +
    `<td>${escapeHtml(entry.destination_mac)}</td>` +
    `<td>${escapeHtml(entry.destination_name)}</td>` +
    `<td>${escapeHtml(entry.egress_port)}</td>` +
    `</tr>`
  )).join('\n');
}

function renderHtml(macTable) {
  const entries = Array.isArray(macTable?.entries) ? macTable.entries : [];
  const generatedAt = 'static';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>MAC Forwarding Table</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #1f2933; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    table { border-collapse: collapse; width: 100%; max-width: 1080px; }
    th, td { border: 1px solid #d9e2ec; padding: 8px 10px; text-align: left; font-size: 13px; }
    th { background: #f0f4f8; font-weight: 600; }
    tbody tr:nth-child(even) { background: #f7f9fb; }
    .meta { margin: 0 0 16px; color: #52606d; font-size: 12px; }
    .empty { text-align: center; color: #7b8794; }
  </style>
</head>
<body>
  <h1>MAC Forwarding Table</h1>
  <p class="meta">version=${escapeHtml(macTable?.version ?? '')}; generated=${generatedAt}</p>
  <table>
    <thead>
      <tr>
        <th>Switch</th>
        <th>Destination MAC</th>
        <th>Destination</th>
        <th>端口号</th>
      </tr>
    </thead>
    <tbody>
${renderRows(entries)}
    </tbody>
  </table>
</body>
</html>
`;
}

function printHelp() {
  process.stdout.write(
    `render-mac-forwarding-html — mac-forwarding-table.json → HTML\n\n` +
    `用法:\n` +
    `  node render-mac-forwarding-html.js <mac-forwarding-table.json>\n` +
    `  node render-mac-forwarding-html.js --help\n\n` +
    `输出:\n` +
    `  stdout = HTML\n\n` +
    `退出码:\n` +
    `  0 = 成功\n` +
    `  2 = io/用法错误\n`
  );
}

module.exports = { escapeHtml, renderHtml };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const [macTablePath] = args;
  if (!macTablePath) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        stage: 'render',
        error: { type: 'UsageError', message: '需要 <mac-forwarding-table.json> 参数; --help 查看用法' },
      })}\n`
    );
    process.exit(2);
  }

  try {
    const txt = fs.readFileSync(path.resolve(macTablePath), 'utf-8');
    const macTable = JSON.parse(txt);
    process.stdout.write(renderHtml(macTable));
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        stage: 'render',
        error: { type: err.name || 'Error', message: err.message },
      })}\n`
    );
    process.exit(2);
  }
}
