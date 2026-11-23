# S-01 开发自测汇报（v0.12.0）

- 日期：2026-11-23
- 基线：`8ab0c76`（v0.11.0）
- 任务：OFAC 姓名列核验与修复（P0，先做）
- 结论：**疑似缺陷成立：v0.11.0 读的是类型列，真实 SDN 姓名在列 1；已修复并加列语义校验。**

## 1. 真实文件取证

2026-11-23 重新下载 `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV`：

- **200**，**5,845,409 bytes**，非空行 **19,600**（19,599 行 12 列，1 行空/1 列），**无表头**。
- 列 0 = 编号；**列 1 = 名称**；**列 2 = 类型**；列 3 = program；4–11 为其他字段。
- 类型分布：`-0-` 10,122；`individual` 7,565；`vessel` 1,570；`aircraft` 342。
- v0.11.0 的 `name_column=2` 实际读类型列；真实查询会全部落空。用真实文件验证：查询 `AEROCARIBBEAN AIRLINES` 修复后命中，查询 `individual` 不命中；Py/Node 一致。

## 2. 修复

- `sanctions_check.py/.mjs`：OFAC 名称列改为 **1**。
- `update_sanctions.py/.mjs`：`validate_sdn` 增加类型列语义校验（≥90% 的第 2 列属于 `-0-`/`individual`/`entity`/`vessel`/`aircraft`），失败返回 `bad-type-column` → `invalid-content`，不覆盖旧缓存。
- 夹具改为真实 12 列格式：`tests/consistency_scripts.mjs`、A25、A163、`sanctions_update` 的 15,000 行合成 CSV。
- `docs/validation.md` 新增 5.2，区分“下载与格式校验通过”与“姓名匹配通过”。

## 3. 用例

A179 命中；A180 类型词不命中；A181 Py/Node 一致；A182 类型列异常 → invalid-content；A183 旧 3 列夹具 → invalid-content；A184 个人名「姓, 名」命中。全量 210/210，`consistency_scripts` 通过。

## 4. 遗留

- 真实 OFAC 文件只用于本地 `.cache/s01`，未进仓库/包。
- 旧 v0.11.0 的“已查 OFAC”说法在 CHANGELOG/发布说明中需 D 系列如实说明影响（Q7 默认：是）。