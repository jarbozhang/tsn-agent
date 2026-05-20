export const NED_CONTRACT = {
  packageName: "tsnagent.generated",
  networkName: "TsnAgentNetwork",
  inetVersion: "INET 4.x",
  imports: [
    "inet.node.ethernet.EthernetSwitch",
    "inet.node.inet.StandardHost",
    "inet.linklayer.ethernet.EthernetLink",
  ],
} as const;
