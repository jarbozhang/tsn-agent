export const PLANNER_NODE_PARAMETER_DEFAULTS = {
  system_clock: "125",
  rc_threshold: "8",
  hpriority_policing_threshold: "16",
  lpriority_policing_threshold: "32",
  qbv_or_qch: "0",
  qci_enable: "0",
  ptp_threshold: "0",
  vlan_cfg: "0",
  vlan_id: "0",
} as const;

export const PLANNER_LINK_DEFAULTS = {
  st_queues: 3,
  macrotick: 0.032,
} as const;

export const PLANNER_PATH_DEFAULTS = {
  redundant: 0,
  fl_api_flag: 0,
  delay_para: 100,
  ip_protocol: 17,
  fivetuple_mask: 0,
} as const;
