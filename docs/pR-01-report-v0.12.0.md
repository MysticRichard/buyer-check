# R-01 开发自测汇报（v0.12.0）

- 日期：2026-11-23
- 任务：同名多实体消歧与身份状态（P1）
- 结论：**identity.status 已实现；卡片不新增行；A219–A224 通过。**

## 1. 实现

- `intake.identity.candidates[]`（最多 5）：`name`、`country`、`registry_id`、`url`、`match_keys[]`、`strength`。
- 脚本计算 `identity.status`：
  - `resolved`：仅 1 个 strong，且无其他 ≥ medium；
  - `probable`：仅 1 个 medium；
  - `ambiguous`：≥2 个不同实体并列最高强度且 ≥ medium；
  - `unresolved`：无候选达到 medium；无候选也是 unresolved。
- `ambiguous` 时在已有公司维度备注追加 `N 个同名候选需确认`；`open_questions` 追加固定问法「请提供注册号或国家」，≤3。
- `identity.status` 不改变风险分、等级、置信度、覆盖分子分母。

## 2. 验证

- A219 单一 strong → resolved，旧卡字节不变。
- A220 单一 medium → probable，旧卡字节不变。
- A221 两个同国不同登记号 strong → ambiguous，卡片含“同名候选需确认”。
- A222 无候选 → unresolved，无加分。
- A223 旧证据包无 identity → 字节一致。
- A224 Python/Node 的 identity_status 与卡片一致。
- 全量 243/243。

## 3. 遗留

- 候选提取仍由 `identity_check company_candidates`/模型提供；同名同国不同登记号的真实消歧需真实数据校准。
- 完整报告候选区分表由 report_template 约束，脚本只输出 `identity` 字段。