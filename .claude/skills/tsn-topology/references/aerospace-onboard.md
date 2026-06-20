<!-- 消费方式：按场景注入（scenarioConfigId = aerospace-onboard 时随主索引注入）。 -->

# 箭载/舰载 TSN 场景指引

面向宇航验收（《TSN 典型组网测试方案》）：双平面冗余（A 主路径、B 冗余路径，物理隔离）、五跳线性级联、环形冗余。用户提到规范图号或典型组网名（如「双平面双跳」「5 跳线性」「4SW_4NIC」）时，优先照下方 preset 表填参数。

## 参数默认值

用户没指定时，显式传给 `topology_initialize`（它不替你补默认）：

- `dataRateMbps`：缺省 `1000`
- 双平面场景按 preset 表的完整参数包来填；自由描述时 `switchCount` 缺省 `4`、`endSystemsPerSwitch` 缺省 `2`

合法范围以 `describe_templates` 为准，这里只给推荐值。

## 选哪个模板

- **`dual-plane-redundant`**：用户要 A/B 双平面、端系统双归属冗余时。单跳（1 个 switchGroup）和双跳（2 个 group + 平面内级联 backbone）都用这个模板表达。
- **`generic-line` + `endSystemPlacement:"ends-only"`**：五跳线性（端系统只挂链路两端各 1 台，`endSystemsPerSwitch` 必须是 1）；`switchCount ≥ 5` 时画布自动蛇形折叠，对齐规范图 5-1。
- **`generic-ring`**：环形冗余 / 双环冗余 / 交换机环网。
- 用户描述不带宇航味（普通线型、规模化挂载）时，按通用场景的 `generic-line` 处理。

## 规范图 preset 表

| 规范图/别名 | `templateId` | 参数 JSON | 布局说明 |
|---|---|---|---|
| 图 4-1 双平面单跳（6E+2SW） | `dual-plane-redundant` | `{"dataRateMbps":1000,"planes":[{"id":"A"},{"id":"B"}],"switches":[{"id":"sw1","plane":"A","groupId":"g1"},{"id":"sw2","plane":"B","groupId":"g1"}],"switchGroups":[{"id":"g1","planeSwitches":{"A":"sw1","B":"sw2"}}],"endSystems":[{"id":"e1","groupId":"g1","attachment":{"primary":{"switchId":"sw1","plane":"A"},"backup":{"switchId":"sw2","plane":"B"}}},{"id":"e2","groupId":"g1","attachment":{"primary":{"switchId":"sw1","plane":"A"},"backup":{"switchId":"sw2","plane":"B"}}},{"id":"e3","groupId":"g1","attachment":{"primary":{"switchId":"sw1","plane":"A"},"backup":{"switchId":"sw2","plane":"B"}}},{"id":"e4","groupId":"g1","attachment":{"primary":{"switchId":"sw1","plane":"A"},"backup":{"switchId":"sw2","plane":"B"}}},{"id":"e5","groupId":"g1","attachment":{"primary":{"switchId":"sw1","plane":"A"},"backup":{"switchId":"sw2","plane":"B"}}},{"id":"e6","groupId":"g1","attachment":{"primary":{"switchId":"sw1","plane":"A"},"backup":{"switchId":"sw2","plane":"B"}}}],"backbone":{"mode":"line","withinPlane":true},"crossPlaneLinks":{"mode":"none"}}` | 三明治：SW 同行居中，ES 上下两行夹住 |
| 图 4-5 双平面双跳（4E+4SW） | `dual-plane-redundant` | `{"dataRateMbps":1000,"planes":[{"id":"A"},{"id":"B"}],"switches":[{"id":"sw1","plane":"A","groupId":"g1"},{"id":"sw2","plane":"B","groupId":"g1"},{"id":"sw3","plane":"A","groupId":"g2"},{"id":"sw4","plane":"B","groupId":"g2"}],"switchGroups":[{"id":"g1","planeSwitches":{"A":"sw1","B":"sw2"}},{"id":"g2","planeSwitches":{"A":"sw3","B":"sw4"}}],"endSystems":[{"id":"e1","groupId":"g1","attachment":{"primary":{"switchId":"sw1","plane":"A"},"backup":{"switchId":"sw2","plane":"B"}}},{"id":"e2","groupId":"g1","attachment":{"primary":{"switchId":"sw1","plane":"A"},"backup":{"switchId":"sw2","plane":"B"}}},{"id":"e3","groupId":"g2","attachment":{"primary":{"switchId":"sw3","plane":"A"},"backup":{"switchId":"sw4","plane":"B"}}},{"id":"e4","groupId":"g2","attachment":{"primary":{"switchId":"sw3","plane":"A"},"backup":{"switchId":"sw4","plane":"B"}}}],"backbone":{"mode":"line","withinPlane":true},"crossPlaneLinks":{"mode":"none"}}` | 双平面行（B 上 A 下），同组 ES 纵向成列挂左右外端 |
| 图 5-1 五跳线性（2E+5SW） | `generic-line` | `{"switchCount":5,"endSystemsPerSwitch":1,"dataRateMbps":1000,"endSystemPlacement":"ends-only"}` | 两行蛇形折叠（行 1 自左向右、行 2 反向），E1/E2 沿行外伸 |
| 环形冗余 / 双环冗余 | `generic-ring` | `{"switchCount":4,"endSystemsPerSwitch":2,"dataRateMbps":1000}` | 线型布局 + 首尾闭环链路；规模按用户描述调整 |

preset 参数为推荐组合；字段合法域仍以 `describe_templates` 为准，用户显式给出的值覆盖表中对应字段。
