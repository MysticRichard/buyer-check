# V-02 开发自测汇报（v0.12.0）

- 日期：2026-11-23
- 任务：证据字段 `observed_at` / `entity_match_basis` / `inferred`（P1）
- 结论：**字段模板与 `inferred` 最低等级已实现；A227–A230 通过。**

## 1. 实现

- `evidence[]` 可选 `observed_at`（来源页面日期）与 `entity_match_basis[]`（`name_exact registry_id domain_match address_match phone_match person_link alias_official alias_inferred`）。
- 新增 `source_grade: "inferred"`：`GRADE_LABEL` 显示“推断”，`GRADE_RANK` 为最低级；不能进入“已核实”，不加分、不加覆盖；`derive_flags` 的 effective grade 也按 inferred 处理。
- `card_template.md` 与 `report_template.md` 增加字段说明；卡片本身不新增行。

## 2. 验证

- A227 模板含三字段与枚举。
- A228 旧证据包字节一致。
- A229 inferred 证据被移入“没查到”，不出现 🟢 已核实。
- A230 inferred 不改变核实度（与 card_harbor 同为 90/高）。
- 全量 243/243。

## 3. 遗留

- `observed_at` 与 `entity_match_basis` 的完整性由模型/报告模板保证，脚本不强制每个证据都带。
- `inferred` 位置采用最低一级，作为默认映射；未新增覆盖或加分。