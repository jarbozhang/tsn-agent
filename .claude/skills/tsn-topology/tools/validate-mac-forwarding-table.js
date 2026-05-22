#!/usr/bin/env node
// validate-mac-forwarding-table.js
// 校验 mac-forwarding-table.json 是否与 topology.json 一致
// 详细规则: docs/rules.md
//
// 用法:
//   作为库:  const { validate, validateFiles } = require('./validate-mac-forwarding-table')
//   作为 CLI: node validate-mac-forwarding-table.js <topology.json> <mac-forwarding-table.json>
//             --help                打印用法
//             stdout JSON: {ok, errors: [{path, reason, kind}]}
//             exit 0 = ok
//                  1 = schema/reference/consistency 错误 (转发表非法)
//                  2 = io 错误 (文件不存在/JSON 语法错/用法错)

'use strict';

const fs = require('fs');
const path = require('path');
const { deriveMac, MAX_PORT } = require('./topology-builder');

function err(errors, p, reason, kind = 'schema') {
  errors.push({ path: p, reason, kind });
}

function isInt(x) {
  return typeof x === 'number' && Number.isInteger(x);
}

function validateTopologyContext(topology, errors) {
  if (!topology || typeof topology !== 'object') {
    err(errors, 'topology', '不是对象', 'schema');
    return null;
  }
  if (!topology.node || typeof topology.node !== 'object') {
    err(errors, 'topology.node', '缺失或非对象', 'schema');
    return null;
  }
  const nodes = topology.node.nodes;
  const links = topology.node.links;
  if (!Array.isArray(nodes)) {
    err(errors, 'topology.node.nodes', '不是数组', 'schema');
    return null;
  }
  if (!Array.isArray(links)) {
    err(errors, 'topology.node.links', '不是数组', 'schema');
    return null;
  }

  const nodeBySync = new Map();
  const nodeByImac = new Map();
  nodes.forEach((n, i) => {
    const p = `topology.node.nodes[${i}]`;
    if (!isInt(n.imac)) err(errors, `${p}.imac`, '必须是整数', 'schema');
    if (typeof n.sync_name !== 'string' || !/^\d+$/.test(n.sync_name))
      err(errors, `${p}.sync_name`, '必须是非负整数数字字符串', 'schema');
    if (typeof n.node_type !== 'string')
      err(errors, `${p}.node_type`, '必须是字符串', 'schema');

    if (isInt(n.imac)) nodeByImac.set(n.imac, n);
    if (typeof n.sync_name === 'string' && /^\d+$/.test(n.sync_name))
      nodeBySync.set(Number(n.sync_name), n);
  });

  const switchPorts = new Map();
  nodes.forEach((n) => {
    if (n.node_type === 'switch' && typeof n.sync_name === 'string' && /^\d+$/.test(n.sync_name)) {
      switchPorts.set(Number(n.sync_name), new Set());
    }
  });

  links.forEach((l, i) => {
    const p = `topology.node.links[${i}]`;
    if (!l.styles || typeof l.styles !== 'object') {
      err(errors, `${p}.styles`, '缺失或非对象', 'schema');
      return;
    }
    const src = nodeByImac.get(l.imac);
    const dst = nodeByImac.get(l.addr);
    if (!src || !dst) return;
    const leftPort = parsePort(l.styles?.leftLabel);
    const rightPort = parsePort(l.styles?.rightLabel);
    if (leftPort === null || rightPort === null) return;

    if (src.node_type === 'switch') switchPorts.get(Number(src.sync_name))?.add(leftPort);
    if (dst.node_type === 'switch') switchPorts.get(Number(dst.sync_name))?.add(rightPort);
  });

  const adjacency = new Map([...nodeBySync.keys()].map((nodeId) => [nodeId, []]));
  links.forEach((l) => {
    const src = nodeByImac.get(l.imac);
    const dst = nodeByImac.get(l.addr);
    const leftPort = parsePort(l.styles?.leftLabel);
    const rightPort = parsePort(l.styles?.rightLabel);
    if (!src || !dst || leftPort === null || rightPort === null) return;

    const srcId = Number(src.sync_name);
    const dstId = Number(dst.sync_name);
    adjacency.get(srcId)?.push({ node_id: dstId, out_port: leftPort });
    adjacency.get(dstId)?.push({ node_id: srcId, out_port: rightPort });
  });
  for (const edges of adjacency.values()) {
    edges.sort((a, b) => {
      if (a.node_id !== b.node_id) return a.node_id - b.node_id;
      return a.out_port - b.out_port;
    });
  }

  return { nodeBySync, nodeByImac, switchPorts, adjacency };
}

function parsePort(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_PORT) return raw;
  if (typeof raw !== 'string') return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PORT) return null;
  return n;
}

function findFirstEgressPort(startNodeId, destinationNodeId, adjacency) {
  const seen = new Set([startNodeId]);
  const queue = [{ node_id: startNodeId, first_port: undefined }];

  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    for (const edge of adjacency.get(cur.node_id) || []) {
      if (seen.has(edge.node_id)) continue;
      const firstPort = cur.node_id === startNodeId ? edge.out_port : cur.first_port;
      if (edge.node_id === destinationNodeId) return firstPort;
      seen.add(edge.node_id);
      queue.push({ node_id: edge.node_id, first_port: firstPort });
    }
  }

  return undefined;
}

function expectedEntryMap(topoCtx) {
  const expected = new Map();
  const nodes = [...topoCtx.nodeBySync.entries()].sort((a, b) => a[0] - b[0]);
  const switches = nodes.filter(([, n]) => n.node_type === 'switch');

  for (const [switchNodeId] of switches) {
    for (const [destinationNodeId] of nodes) {
      if (destinationNodeId === switchNodeId) continue;
      const egressPort = findFirstEgressPort(switchNodeId, destinationNodeId, topoCtx.adjacency);
      if (egressPort === undefined) continue;
      expected.set(`${switchNodeId}->${destinationNodeId}`, egressPort);
    }
  }

  return expected;
}

function validateMacForwardingTable(macTable, topoCtx, errors) {
  if (!macTable || typeof macTable !== 'object' || Array.isArray(macTable)) {
    err(errors, 'mac_forwarding_table', '不是对象', 'schema');
    return;
  }
  if (macTable.version !== '1.0') {
    err(errors, 'mac_forwarding_table.version', `必须是 "1.0",实际 ${JSON.stringify(macTable.version)}`, 'schema');
  }
  if (!Array.isArray(macTable.entries)) {
    err(errors, 'mac_forwarding_table.entries', '不是数组', 'schema');
    return;
  }
  if (!topoCtx) return;

  const rowSeen = new Set();
  const expected = expectedEntryMap(topoCtx);
  macTable.entries.forEach((entry, i) => {
    const p = `mac_forwarding_table.entries[${i}]`;
    const required = [
      'switch_node',
      'switch_imac',
      'switch_name',
      'destination_node',
      'destination_imac',
      'destination_mac',
      'destination_name',
      'egress_port',
    ];
    for (const k of required) {
      if (!(k in entry)) err(errors, `${p}.${k}`, '字段缺失', 'schema');
    }

    for (const k of ['switch_node', 'switch_imac', 'destination_node', 'destination_imac', 'egress_port']) {
      if (k in entry && !isInt(entry[k])) {
        err(errors, `${p}.${k}`, `必须是整数,实际 ${typeof entry[k]}`, 'schema');
      }
    }
    for (const k of ['switch_name', 'destination_mac', 'destination_name']) {
      if (k in entry && typeof entry[k] !== 'string') {
        err(errors, `${p}.${k}`, `必须是字符串,实际 ${typeof entry[k]}`, 'schema');
      }
    }

    if (isInt(entry.egress_port) && (entry.egress_port < 0 || entry.egress_port > MAX_PORT)) {
      err(errors, `${p}.egress_port`, `越界 [0, ${MAX_PORT}]: ${entry.egress_port}`, 'schema');
    }

    const swNode = topoCtx.nodeBySync.get(entry.switch_node);
    if (!swNode) {
      err(errors, `${p}.switch_node`, `引用不存在的 switch node_id: ${entry.switch_node}`, 'reference');
    } else {
      if (swNode.node_type !== 'switch') {
        err(errors, `${p}.switch_node`, `引用的节点不是 switch: ${entry.switch_node}`, 'reference');
      }
      if (entry.switch_imac !== swNode.imac) {
        err(errors, `${p}.switch_imac`, `与 topology 不一致,期望 ${swNode.imac},实际 ${entry.switch_imac}`, 'consistency');
      }
    }

    const dstNode = topoCtx.nodeBySync.get(entry.destination_node);
    if (!dstNode) {
      err(errors, `${p}.destination_node`, `引用不存在的 destination node_id: ${entry.destination_node}`, 'reference');
    } else {
      if (entry.destination_imac !== dstNode.imac) {
        err(errors, `${p}.destination_imac`, `与 topology 不一致,期望 ${dstNode.imac},实际 ${entry.destination_imac}`, 'consistency');
      }
      const expectedMac = deriveMac(entry.destination_node);
      if (entry.destination_mac !== expectedMac) {
        err(errors, `${p}.destination_mac`, `与 node_id 派生不一致,期望 ${expectedMac},实际 ${entry.destination_mac}`, 'consistency');
      }
    }

    if (swNode && isInt(entry.egress_port)) {
      const ports = topoCtx.switchPorts.get(entry.switch_node);
      if (!ports || !ports.has(entry.egress_port)) {
        err(errors, `${p}.egress_port`, `不是 switch ${entry.switch_node} 的已连接出端口: ${entry.egress_port}`, 'consistency');
      }
    }

    if (isInt(entry.switch_node) && isInt(entry.destination_node)) {
      const fp = `${entry.switch_node}->${entry.destination_node}`;
      if (rowSeen.has(fp)) {
        err(errors, `${p}`, `重复转发表项: ${fp}`, 'consistency');
      } else {
        rowSeen.add(fp);
      }
      if (!expected.has(fp)) {
        err(errors, `${p}`, `非预期转发表项: ${fp}`, 'consistency');
      } else if (isInt(entry.egress_port) && entry.egress_port !== expected.get(fp)) {
        err(errors, `${p}.egress_port`, `与最短路径 first-hop 不一致,期望 ${expected.get(fp)},实际 ${entry.egress_port}`, 'consistency');
      }
    }
  });

  for (const fp of expected.keys()) {
    if (!rowSeen.has(fp)) {
      err(errors, 'mac_forwarding_table.entries', `缺少转发表项: ${fp}`, 'consistency');
    }
  }
}

function validate(topology, macTable) {
  const errors = [];
  const topoCtx = validateTopologyContext(topology, errors);
  validateMacForwardingTable(macTable, topoCtx, errors);
  return { ok: errors.length === 0, errors };
}

function validateFiles(topologyPath, macTablePath) {
  const errors = [];
  let topology = null;
  let macTable = null;
  let ioFailed = false;

  try {
    const txt = fs.readFileSync(topologyPath, 'utf-8');
    topology = JSON.parse(txt);
  } catch (e) {
    err(errors, `file:${topologyPath}`, `读取或解析失败: ${e.message}`, 'io');
    ioFailed = true;
  }

  try {
    const txt = fs.readFileSync(macTablePath, 'utf-8');
    macTable = JSON.parse(txt);
  } catch (e) {
    err(errors, `file:${macTablePath}`, `读取或解析失败: ${e.message}`, 'io');
    ioFailed = true;
  }

  if (ioFailed) return { ok: false, errors, _ioFailed: true };
  const res = validate(topology, macTable);
  return { ok: res.ok, errors: res.errors, _ioFailed: false };
}

module.exports = { validate, validateFiles };

function printHelp() {
  process.stdout.write(
    `validate-mac-forwarding-table — 校验 topology.json + mac-forwarding-table.json\n\n` +
    `用法:\n` +
    `  node validate-mac-forwarding-table.js <topology.json> <mac-forwarding-table.json>\n` +
    `  node validate-mac-forwarding-table.js --help\n\n` +
    `输出 (stdout, JSON):\n` +
    `  {"ok": bool, "errors": [{"path": str, "reason": str, "kind": "io|schema|reference|consistency"}]}\n\n` +
    `退出码:\n` +
    `  0 = ok\n` +
    `  1 = 转发表非法 (schema/reference/consistency)\n` +
    `  2 = io/用法错误 (文件不存在/JSON 语法错/参数不全)\n`
  );
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const [topoPath, macTablePath] = args;
  if (!topoPath || !macTablePath) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          errors: [
            {
              path: 'usage',
              reason: '需要 <topology.json> <mac-forwarding-table.json> 两个参数; --help 查看用法',
              kind: 'io',
            },
          ],
        },
        null,
        2
      ) + '\n'
    );
    process.exit(2);
  }

  const result = validateFiles(path.resolve(topoPath), path.resolve(macTablePath));
  const ioFailed = result._ioFailed;
  delete result._ioFailed;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.ok) process.exit(0);
  process.exit(ioFailed ? 2 : 1);
}
