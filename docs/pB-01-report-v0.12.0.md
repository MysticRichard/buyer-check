# B-01 开发自测汇报（v0.12.0）

- 日期：2026-11-23
- 任务：付款方、收货方、最终用途、买家类型（P1）
- 结论：**可选字段与固定提示已实现；不计分、不加卡片行；A231–A236 通过。**

## 1. 实现

- `intake` 新增可选 `end_use`、`end_user`、`payer`、`consignee`、`buyer_type`。
- `buyer_type` 枚举：distributor / wholesaler_retailer / oem_manufacturer / contractor_epc / end_user / trading_intermediary / unknown；非枚举回退 unknown 并计数。
- 自然人姓名用 `mask_person_name` 脱敏（2–4 个字母词且无法人后缀）；与买家完全同名时不脱敏。
- 付款方/收货方与买家不同时输出固定提示「付款方/收货方与买家不同：请书面确认关系与授权」，只进报告/`--json`，不计分、不加红旗、不改卡片字节。

## 2. 验证

- A231 付款方不同 → prompt；A232 相同 → 无 prompt；A233 自然人名脱敏；A234 旧卡字节；A235 非法 buyer_type；A236 Py/Node 一致。
- 全量 243/243。

## 3. 遗留

- 自然人姓名识别是启发式（2–4 个字母词 + 无法人后缀），缩写/公司名可能误判；真实使用需人工复核。
- 付款方国别不同只在报告列事实，不升级红旗（Q3 默认 A）。