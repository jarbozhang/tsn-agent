//! Plan v3 U4a-2：Rust 端 IntermediateTopology DTO + 排序 / 派生工具，
//! 1:1 镜像 `src/topology/intermediate.ts`。
//!
//! 这些类型只承担 sidecar 入口反序列化与 compute 模块共享类型职责；
//! 不与 P0 SQLite 表绑定（U4a-1 walker 已经把 canonical 落到 topology_nodes/_links）。
//!
//! MCP 工具调用 `build_artifacts` / `inspect` / `validate` 时 agent 在 args 里传
//! topology，MCP handler 透传到 sidecar。sidecar 内反序列化为这些类型后跑算法。
//! initialize 则只接受 `(templateId, params)` 在 sidecar 端原地生成 topology。

use serde::{Deserialize, Serialize};

pub const INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION: &str = "tsn-agent.topology.intermediate.v0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediatePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediatePort {
    pub id: String,
    pub name: String,
    pub index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateNode {
    pub id: String,
    pub numeric_id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: IntermediateNodeType,
    pub ports: Vec<IntermediatePort>,
    pub position: IntermediatePosition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntermediateNodeType {
    Switch,
    EndSystem,
    Server,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateLinkEndpoint {
    pub node_id: String,
    pub port_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateLink {
    pub id: String,
    pub numeric_id: i64,
    pub source: IntermediateLinkEndpoint,
    pub target: IntermediateLinkEndpoint,
    pub medium: IntermediateLinkMedium,
    pub data_rate_mbps: i64,
    /// 平面归属（"A"/"B"），dual-plane 生成端写入；其余模板与旧数据为 None（R6）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plane: Option<String>,
    /// 链路角色（"access"/"backbone"），与 plane 同生命周期。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntermediateLinkMedium {
    Ethernet,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateTopologyMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyDiagnostic {
    pub code: String,
    pub message: String,
    pub severity: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateTopology {
    pub schema_version: String,
    #[serde(default)]
    pub metadata: IntermediateTopologyMetadata,
    pub nodes: Vec<IntermediateNode>,
    pub links: Vec<IntermediateLink>,
    #[serde(default)]
    pub diagnostics: Vec<TopologyDiagnostic>,
}

impl IntermediateTopology {
    pub fn switch_count(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| n.node_type == IntermediateNodeType::Switch)
            .count()
    }
    pub fn end_system_count(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| n.node_type == IntermediateNodeType::EndSystem)
            .count()
    }
    pub fn server_count(&self) -> usize {
        self.nodes
            .iter()
            .filter(|n| n.node_type == IntermediateNodeType::Server)
            .count()
    }
}

/// 与 TS `sortNodesByNumericId` 完全一致：先按 numericId 升序，再按 id 字典序。
pub fn sort_nodes_by_numeric_id(nodes: &[IntermediateNode]) -> Vec<IntermediateNode> {
    let mut sorted: Vec<IntermediateNode> = nodes.to_vec();
    sorted.sort_by(|a, b| match a.numeric_id.cmp(&b.numeric_id) {
        std::cmp::Ordering::Equal => a.id.cmp(&b.id),
        other => other,
    });
    sorted
}

pub fn sort_links_by_numeric_id(links: &[IntermediateLink]) -> Vec<IntermediateLink> {
    let mut sorted: Vec<IntermediateLink> = links.to_vec();
    sorted.sort_by(|a, b| match a.numeric_id.cmp(&b.numeric_id) {
        std::cmp::Ordering::Equal => a.id.cmp(&b.id),
        other => other,
    });
    sorted
}

pub fn create_ports(count: usize) -> Vec<IntermediatePort> {
    (0..count)
        .map(|i| IntermediatePort {
            // 端口 id 对齐规范 P0 起编（R5）；存量数据保持 p1 起编不迁移。
            id: format!("P{i}"),
            name: format!("eth{i}"),
            index: i as i64,
        })
        .collect()
}

pub fn derive_mac_address(ordinal: i64) -> String {
    format!("00:1B:44:11:3A:{:02X}", ordinal & 0xff)
}

/// U3：确定性 MAC 分配器。`02:` 是 locally-administered 单播前缀，
/// 后 3 字节为 ordinal（节点序号）低 24 位十六进制。session 内按 ordinal 唯一不重复。
pub fn assign_mac(ordinal: i64) -> String {
    let v = (ordinal & 0xff_ffff) as u32;
    format!(
        "02:00:00:{:02X}:{:02X}:{:02X}",
        (v >> 16) & 0xff,
        (v >> 8) & 0xff,
        v & 0xff
    )
}

/// U3：确定性 IP 分配器。`10.<b>.<c>.<d>`（10.0.0.0/8 私网），由 ordinal 映射。
/// host 位 d 取 1..=254（避开 0/255），溢出进位到 c、b。session 内按 ordinal 唯一不重复。
pub fn assign_ip(ordinal: i64) -> String {
    let n = ordinal.max(0) as u64;
    let d = (n % 254) + 1; // 1..=254
    let c = (n / 254) % 256;
    let b = (n / 254 / 256) % 256;
    format!("10.{b}.{c}.{d}")
}

pub fn derive_legacy_mac(numeric_id: i64) -> String {
    let high = (numeric_id >> 8) & 0xff;
    let low = numeric_id & 0xff;
    format!("00:00:23:00:{high:02X}:{low:02X}")
}

pub fn derive_legacy_ip(numeric_id: i64) -> String {
    let high = (numeric_id >> 8) & 0xff;
    let low = numeric_id & 0xff;
    format!("192.168.{high}.{low}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_basic_topology_json() {
        let raw = serde_json::json!({
            "schemaVersion": "tsn-agent.topology.intermediate.v0",
            "metadata": { "templateId": "hop-linear", "layout": "line", "source": "template" },
            "nodes": [{
                "id": "sw1", "numericId": 0, "name": "SW-1", "type": "switch",
                "ports": [{ "id": "p1", "name": "eth0", "index": 0 }],
                "position": { "x": 1.0, "y": 2.0 }
            }],
            "links": [],
            "diagnostics": []
        });
        let topo: IntermediateTopology = serde_json::from_value(raw).unwrap();
        assert_eq!(topo.schema_version, INTERMEDIATE_TOPOLOGY_SCHEMA_VERSION);
        assert_eq!(topo.nodes.len(), 1);
        assert_eq!(topo.nodes[0].id, "sw1");
        assert_eq!(topo.nodes[0].node_type, IntermediateNodeType::Switch);
    }

    #[test]
    fn sort_nodes_by_numeric_id_breaks_ties_with_id() {
        let nodes = vec![
            IntermediateNode {
                id: "b".into(),
                numeric_id: 1,
                name: "B".into(),
                node_type: IntermediateNodeType::Switch,
                ports: vec![],
                position: IntermediatePosition { x: 0.0, y: 0.0 },
                mac_address: None,
                ip_address: None,
            },
            IntermediateNode {
                id: "a".into(),
                numeric_id: 1,
                name: "A".into(),
                node_type: IntermediateNodeType::Switch,
                ports: vec![],
                position: IntermediatePosition { x: 0.0, y: 0.0 },
                mac_address: None,
                ip_address: None,
            },
        ];
        let sorted = sort_nodes_by_numeric_id(&nodes);
        assert_eq!(sorted[0].id, "a");
        assert_eq!(sorted[1].id, "b");
    }

    #[test]
    fn create_ports_yields_p_prefixed_zero_indexed() {
        let p = create_ports(3);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].id, "P0");
        assert_eq!(p[0].name, "eth0");
        assert_eq!(p[0].index, 0);
        assert_eq!(p[2].id, "P2");
        assert_eq!(p[2].index, 2);
    }

    #[test]
    fn derive_legacy_mac_and_ip_match_ts() {
        assert_eq!(derive_legacy_mac(0), "00:00:23:00:00:00");
        assert_eq!(derive_legacy_mac(258), "00:00:23:00:01:02");
        assert_eq!(derive_legacy_ip(258), "192.168.1.2");
    }

    #[test]
    fn assign_mac_is_locally_administered_format() {
        assert_eq!(assign_mac(1), "02:00:00:00:00:01");
        assert_eq!(assign_mac(0), "02:00:00:00:00:00");
        assert_eq!(assign_mac(258), "02:00:00:00:01:02");
        // 合法 `02:` 前缀 + 6 段两位十六进制
        for ord in 0..1000 {
            let m = assign_mac(ord);
            assert!(m.starts_with("02:"), "mac {m} 缺 02: 前缀");
            let segs: Vec<&str> = m.split(':').collect();
            assert_eq!(segs.len(), 6);
            for s in segs {
                assert_eq!(s.len(), 2);
                assert!(u8::from_str_radix(s, 16).is_ok(), "段 {s} 非十六进制");
            }
        }
    }

    #[test]
    fn assign_ip_in_10_subnet_with_valid_host() {
        assert_eq!(assign_ip(0), "10.0.0.1");
        assert_eq!(assign_ip(1), "10.0.0.2");
        assert_eq!(assign_ip(253), "10.0.0.254");
        assert_eq!(assign_ip(254), "10.0.1.1");
        for ord in 0..2000 {
            let ip = assign_ip(ord);
            let octets: Vec<u32> = ip.split('.').map(|s| s.parse().unwrap()).collect();
            assert_eq!(octets.len(), 4);
            assert_eq!(octets[0], 10, "ip {ip} 不在 10.0.0.0/8");
            assert!(octets[1] < 256 && octets[2] < 256);
            // 主机位非 0/255
            assert!(
                octets[3] >= 1 && octets[3] <= 254,
                "ip {ip} 主机位 {} 越界",
                octets[3]
            );
        }
    }

    #[test]
    fn assign_mac_ip_deterministic_and_unique() {
        let ordinals: Vec<i64> = vec![0, 1, 2, 5, 10, 100, 253, 254, 255, 1000];
        // 确定性可复现
        for &ord in &ordinals {
            assert_eq!(assign_mac(ord), assign_mac(ord));
            assert_eq!(assign_ip(ord), assign_ip(ord));
        }
        // 两两不重复
        let mut macs = std::collections::HashSet::new();
        let mut ips = std::collections::HashSet::new();
        for ord in 0..5000i64 {
            assert!(macs.insert(assign_mac(ord)), "mac 在 ordinal {ord} 重复");
            assert!(ips.insert(assign_ip(ord)), "ip 在 ordinal {ord} 重复");
        }
    }
}
