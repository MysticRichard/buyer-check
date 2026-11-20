# N-06 开发自测汇报（v0.11.0）

- 日期：2026-11-20
- 分支：工作区（基线 `main` 43e4194 / v0.10.1；本版尚未提交）
- 任务：收货信息与目的地提示（P1）
- 结论：**A165–A167 通过；三类判断均不计分；不改变卡片字节。**

## 1. 做了什么

- 新增可选 `intake.ship_to`：`country`（ISO2）、`consignee_name`、`forwarder_name`、`incoterm`。
- `render_card.py/.mjs` 输出 `ship_to`：收货国、买家国、`country_mismatch`、`risk_background`。
- `scripts/country_capabilities.json` 每个国家条目增加 `risk_background`（未核实为 `null`）；仅利比亚（LY）经官方页面核对后填写：
  - programs：`OFAC Libya Sanctions`、`UN Security Council Resolution 1970 (2011) concerning Libya`
  - source_url：`https://ofac.treasury.gov/sanctions-programs-and-country-information/libya-sanctions`（200）
  - verified_at：`2026-11-20`
- `report_template.md` 新增“出口合规自查提示”（目的国、最终用户、用途、是否管制物项；固定声明“不判定是否适用，不构成法律意见”）。
- 收货国与买家国不同只作线索；指定货代沿用 RF-PAY-002 的既有判定；`risk_background=null` 不输出提示。

## 2. 改动文件

- `scripts/render_card.py`、`scripts/render_card.mjs`
- `scripts/country_capabilities.json`
- `report_template.md`
- `tests/cases/A165`–`A167`

## 3. 验证

- A165 收货国 MY vs 买家 SG → `country_mismatch=true`；风险分/等级/置信度不变；卡片字节不变。
- A166 LY → `risk_background` 含两个项目名、来源与日期；卡片字节不变。
- A167 缺失 `ship_to`、AE（`null`）、空国家 → 不输出提示；卡片字节不变。
- 全量仓库 178/178；包内通过。
- LY 页面实测：OFAC `libya-sanctions` 200；`libya-sanctions-regulations` 404（已弃用路径）。

## 4. 遗留

- 只核对了利比亚一个国家的官方项目页面；其余 19 国保持 `null`，不猜。
- 出口合规只给“需自查”，不判定两用物项或出口管制适用性。