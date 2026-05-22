#!/usr/bin/env node
// validate-topology.js
// 校验 topology.json + topo_feature.json 是否符合规则
// 详细规则: docs/rules.md
//
// 用法:
//   作为库:  const { validate, validateFiles } = require('./validate-topology')
//   作为 CLI: node validate-topology.js <topology.json> <topo_feature.json>
//             --help                打印用法
//             stdout JSON: {ok, errors: [{path, reason, kind}]}
//             exit 0 = ok
//                  1 = schema/reference/consistency 错误 (拓扑非法)
//                  2 = io 错误 (文件不存在/JSON 语法错/用法错)

'use strict';

const fs = require('fs');
const path = require('path');
const builder = require('./topology-builder');

const { NODE_TYPES, SPEED_ENUM, CLASSPATH: CLASSPATH_BY_TYPE } = builder;

function err(errors, p, reason, kind = 'schema') {
  errors.push({ path: p, reason, kind });
}

// ---- 校验 topology.json 内部一致性 ----

function validateTopology(topology, errors) {
  if (!topology || typeof topology !== 'object') {
    err(errors, 'topology', '不是对象', 'schema');
    return null;
  }
  if (!topology.node || typeof topology.node !== 'object') {
    err(errors, 'topology.node', '缺失或非对象', 'schema');
    return null;
  }
  const { nodes, links } = topology.node;
  if (!Array.isArray(nodes)) {
    err(errors, 'topology.node.nodes', '不是数组', 'schema');
    return null;
  }
  if (!Array.isArray(links)) {
    err(errors, 'topology.node.links', '不是数组', 'schema');
    return null;
  }

  const imacSeen = new Set();
  const syncNameSeen = new Set();
  const nodeByImac = new Map();
  const nodeBySyncName = new Map();

  nodes.forEach((n, i) => {
    const p = `topology.node.nodes[${i}]`;
    for (const k of ['imac', 'sync_name', 'x', 'y', 'sync_type', 'node_type']) {
      if (!(k in n)) err(errors, `${p}.${k}`, '字段缺失', 'schema');
    }
    if (typeof n.imac !== 'number' || !Number.isInteger(n.imac))
      err(errors, `${p}.imac`, `必须是整数,实际: ${typeof n.imac}`, 'schema');
    if (typeof n.sync_name !== 'string')
      err(errors, `${p}.sync_name`, '必须是字符串', 'schema');
    if (typeof n.x !== 'number' || !Number.isInteger(n.x))
      err(errors, `${p}.x`, '必须是整数', 'schema');
    if (typeof n.y !== 'number' || !Number.isInteger(n.y))
      err(errors, `${p}.y`, '必须是整数', 'schema');
    if (!NODE_TYPES.has(n.node_type))
      err(errors, `${p}.node_type`, `非法值: ${n.node_type}`, 'schema');
    if (
      !n.sync_type ||
      typeof n.sync_type !== 'object' ||
      typeof n.sync_type._classPath !== 'string'
    ) {
      err(errors, `${p}.sync_type._classPath`, '缺失或非法', 'schema');
    } else {
      const expectedCp = CLASSPATH_BY_TYPE[n.node_type];
      if (expectedCp && n.sync_type._classPath !== expectedCp) {
        err(
          errors,
          `${p}.sync_type._classPath`,
          `与 node_type=${n.node_type} 不匹配,期望 ${expectedCp},实际 ${n.sync_type._classPath}`,
          'consistency'
        );
      }
    }

    if (imacSeen.has(n.imac))
      err(errors, `${p}.imac`, `重复值: ${n.imac}`, 'consistency');
    else {
      imacSeen.add(n.imac);
      nodeByImac.set(n.imac, n);
    }
    if (syncNameSeen.has(n.sync_name))
      err(errors, `${p}.sync_name`, `重复值: ${n.sync_name}`, 'consistency');
    else {
      syncNameSeen.add(n.sync_name);
      nodeBySyncName.set(n.sync_name, n);
    }
  });

  // 端口占用: (imac, port) -> link count
  // 用 parseInt 严格解析, 非数字字符串单独报错而不污染端口表
  const portUsage = new Map();

  links.forEach((l, i) => {
    const p = `topology.node.links[${i}]`;
    for (const k of ['name', 'styles', 'imac', 'addr']) {
      if (!(k in l)) err(errors, `${p}.${k}`, '字段缺失', 'schema');
    }
    if (typeof l.imac !== 'number' || !nodeByImac.has(l.imac))
      err(errors, `${p}.imac`, `引用不存在的节点 imac: ${l.imac}`, 'reference');
    if (typeof l.addr !== 'number' || !nodeByImac.has(l.addr))
      err(errors, `${p}.addr`, `引用不存在的节点 imac: ${l.addr}`, 'reference');
    if (l.imac === l.addr)
      err(errors, `${p}`, `link 不支持自环 (imac == addr == ${l.imac})`, 'consistency');

    const s = l.styles;
    if (!s || typeof s !== 'object') {
      err(errors, `${p}.styles`, '缺失或非对象', 'schema');
    } else {
      if (typeof s.leftLabel !== 'string')
        err(errors, `${p}.styles.leftLabel`, '必须是字符串', 'schema');
      if (typeof s.rightLabel !== 'string')
        err(errors, `${p}.styles.rightLabel`, '必须是字符串', 'schema');
      if (!SPEED_ENUM.has(s.speed))
        err(errors, `${p}.styles.speed`, `非法值: ${s.speed} (允许 ${[...SPEED_ENUM].join('|')})`, 'schema');

      // 端口唯一性 (严格 parseInt)
      const parsePort = (raw, label) => {
        if (typeof raw !== 'string') return NaN;
        const m = /^(\d+)$/.exec(raw);
        if (!m) {
          err(errors, `${p}.styles.${label}`, `端口必须是数字字符串,实际 ${JSON.stringify(raw)}`, 'schema');
          return NaN;
        }
        return parseInt(m[1], 10);
      };
      const srcPort = parsePort(s.leftLabel, 'leftLabel');
      const dstPort = parsePort(s.rightLabel, 'rightLabel');

      if (!Number.isNaN(srcPort) && typeof l.imac === 'number' && nodeByImac.has(l.imac)) {
        const key = `${l.imac}:${srcPort}`;
        portUsage.set(key, (portUsage.get(key) ?? 0) + 1);
      }
      if (!Number.isNaN(dstPort) && typeof l.addr === 'number' && nodeByImac.has(l.addr)) {
        const key = `${l.addr}:${dstPort}`;
        portUsage.set(key, (portUsage.get(key) ?? 0) + 1);
      }
    }

    // link.name 拼接校验
    if (typeof l.name === 'string' && nodeByImac.has(l.imac) && nodeByImac.has(l.addr)) {
      const srcN = nodeByImac.get(l.imac);
      const dstN = nodeByImac.get(l.addr);
      const expectedName = `${srcN.sync_name}:${l.styles?.leftLabel ?? ''}-${dstN.sync_name}:${l.styles?.rightLabel ?? ''}`;
      if (l.name !== expectedName)
        err(
          errors,
          `${p}.name`,
          `与端口/sync_name 不一致,期望 ${expectedName},实际 ${l.name}`,
          'consistency'
        );
    }
  });

  for (const [key, count] of portUsage) {
    if (count > 1) {
      err(errors, `topology.node.links`, `端口被多次占用: ${key} (${count} 次)`, 'consistency');
    }
  }

  return { nodeByImac, nodeBySyncName, links };
}

// ---- 校验 topo_feature.json ----

function validateTopoFeature(topoFeature, topoCtx, errors) {
  if (!Array.isArray(topoFeature)) {
    err(errors, 'topo_feature', '不是数组', 'schema');
    return;
  }

  const { nodeBySyncName, links: topoLinks, nodeByImac } = topoCtx || {};
  if (!nodeBySyncName) return;

  const isServerLink = (l) => {
    const sN = nodeByImac.get(l.imac);
    const dN = nodeByImac.get(l.addr);
    return sN?.node_type === 'server' || dN?.node_type === 'server';
  };
  const expectedFeatureCount = topoLinks.filter((l) => !isServerLink(l)).length * 2;
  if (topoFeature.length !== expectedFeatureCount) {
    err(
      errors,
      'topo_feature',
      `边数应为 ${expectedFeatureCount} (非 server topology 链路 × 2),实际 ${topoFeature.length}`,
      'consistency'
    );
  }

  const linkIdSeen = new Set();
  const validNodeIds = new Set([...nodeBySyncName.keys()].map(Number));
  const fingerprints = new Set();

  topoFeature.forEach((e, i) => {
    const p = `topo_feature[${i}]`;
    for (const k of ['link_id', 'src_node', 'src_port', 'dst_node', 'dst_port', 'speed', 'st_queues']) {
      if (!(k in e)) err(errors, `${p}.${k}`, '字段缺失', 'schema');
      else if (typeof e[k] !== 'number' || !Number.isInteger(e[k]))
        err(errors, `${p}.${k}`, `必须是整数,实际 ${typeof e[k]}`, 'schema');
    }

    if (linkIdSeen.has(e.link_id))
      err(errors, `${p}.link_id`, `重复: ${e.link_id}`, 'consistency');
    else linkIdSeen.add(e.link_id);

    if (!validNodeIds.has(e.src_node))
      err(errors, `${p}.src_node`, `引用不存在的 node_id: ${e.src_node}`, 'reference');
    if (!validNodeIds.has(e.dst_node))
      err(errors, `${p}.dst_node`, `引用不存在的 node_id: ${e.dst_node}`, 'reference');
    if (e.src_node === e.dst_node)
      err(errors, `${p}`, `自环 (src_node == dst_node == ${e.src_node})`, 'consistency');
    if (!SPEED_ENUM.has(e.speed))
      err(errors, `${p}.speed`, `非法值: ${e.speed}`, 'schema');
    if (e.st_queues !== 3)
      err(errors, `${p}.st_queues`, `首期固定为 3,实际 ${e.st_queues}`, 'schema');

    fingerprints.add(
      `${e.src_node}:${e.src_port}->${e.dst_node}:${e.dst_port}`
    );
  });

  topoFeature.forEach((e, i) => {
    const reverseFp = `${e.dst_node}:${e.dst_port}->${e.src_node}:${e.src_port}`;
    if (!fingerprints.has(reverseFp)) {
      err(
        errors,
        `topo_feature[${i}]`,
        `缺反向边: ${reverseFp}`,
        'consistency'
      );
    }
  });
}

// ---- 主入口 ----

function validate(topology, topoFeature) {
  const errors = [];
  const topoCtx = validateTopology(topology, errors);
  if (topoCtx) {
    validateTopoFeature(topoFeature, topoCtx, errors);
  }
  return { ok: errors.length === 0, errors };
}

function validateFiles(topologyPath, topoFeaturePath) {
  const errors = [];
  let topology = null;
  let topoFeature = null;
  let ioFailed = false;

  try {
    const txt = fs.readFileSync(topologyPath, 'utf-8');
    topology = JSON.parse(txt);
  } catch (e) {
    err(errors, `file:${topologyPath}`, `读取或解析失败: ${e.message}`, 'io');
    ioFailed = true;
  }

  try {
    const txt = fs.readFileSync(topoFeaturePath, 'utf-8');
    topoFeature = JSON.parse(txt);
  } catch (e) {
    err(errors, `file:${topoFeaturePath}`, `读取或解析失败: ${e.message}`, 'io');
    ioFailed = true;
  }

  if (ioFailed) return { ok: false, errors, _ioFailed: true };
  const res = validate(topology, topoFeature);
  return { ok: res.ok, errors: res.errors, _ioFailed: false };
}

module.exports = { validate, validateFiles };

// ---- CLI ----

function printHelp() {
  process.stdout.write(
    `validate-topology — 校验 topology.json + topo_feature.json\n\n` +
    `用法:\n` +
    `  node validate-topology.js <topology.json> <topo_feature.json>\n` +
    `  node validate-topology.js --help\n\n` +
    `输出 (stdout, JSON):\n` +
    `  {"ok": bool, "errors": [{"path": str, "reason": str, "kind": "io|schema|reference|consistency"}]}\n\n` +
    `退出码:\n` +
    `  0 = ok\n` +
    `  1 = 拓扑非法 (schema/reference/consistency)\n` +
    `  2 = io/用法错误 (文件不存在/JSON 语法错/参数不全)\n`
  );
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const [topoPath, featurePath] = args;
  if (!topoPath || !featurePath) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          errors: [
            { path: 'usage', reason: '需要 <topology.json> <topo_feature.json> 两个参数; --help 查看用法', kind: 'io' },
          ],
        },
        null,
        2
      ) + '\n'
    );
    process.exit(2);
  }
  const result = validateFiles(path.resolve(topoPath), path.resolve(featurePath));
  const ioFailed = result._ioFailed;
  delete result._ioFailed;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.ok) process.exit(0);
  process.exit(ioFailed ? 2 : 1);
}
