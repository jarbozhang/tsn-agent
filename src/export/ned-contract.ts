export const NED_CONTRACT = {
  packageName: "tsnagent.generated",
  networkName: "TsnAgentNetwork",
  inetVersion: "INET 4.x",
  baseNetwork: "TsnNetworkBase",
  switchModule: "TsnSwitch",
  endSystemModule: "TsnDevice",
  connectionChannel: "EthernetLink",
  relativePath: "tsnagent/generated/network.ned",
  imports: [
    "inet.networks.base.TsnNetworkBase",
    "inet.node.ethernet.EthernetLink",
    "inet.node.tsn.TsnDevice",
    "inet.node.tsn.TsnSwitch",
  ],
} as const;
