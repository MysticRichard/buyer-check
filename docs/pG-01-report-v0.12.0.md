# G-01 开发自测汇报（v0.12.0）

- 日期：2026-11-23
- 任务：免费登记与筛查来源清单（P1）
- 结论：**global.md 第十五节已加入 5 个来源与 verified_at/terms_checked；本版只给链接，不加脚本。**

## 1. 内容

| 来源 | 用途 | 本版处理 |
| --- | --- | --- |
| GLEIF | 全球 LEI 查询 | 链接 + 查什么；只覆盖有 LEI 主体，查不到不扣分 |
| EU VIES | 欧盟 VAT 号有效性 | 链接；号码有效 ≠ 正在经营 ≠ 与询盘人有关 |
| SEC EDGAR | 美国上市公司 | 链接；记录 User-Agent 与频率要求 |
| trade.gov CSL | 美国多部门限制名单汇总 | 链接；API key/下载方式待核实 |
| UK Companies House | 英国公司登记 | 链接；API key 待核实，默认不自动查询 |

- 每条含 `verified_at` 与 `terms_checked`；无法核实的条款写“待核实”。
- 不加 `--online` 脚本；不改变风险分/等级/置信度/覆盖分母。

## 2. 验证

- A237 global.md 含 5 个来源与字段。
- A238 本版只给链接、保留 check_sources 字段。
- 全量 243/243。

## 3. 遗留

- 各来源的自动化条款/API key 未逐条完成法务级核对；本版只用链接。
- 后续若要加自动查询，需先确认 `automation_allowed` 与条款。