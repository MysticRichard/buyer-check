# N-02 开发自测汇报（v0.11.0）

- 日期：2026-11-20
- 分支：工作区（基线 `main` 43e4194 / v0.10.1；本版尚未提交）
- 任务：来源渠道 `intake.channel`（P0）
- 结论：**A153–A155 通过；channel 不改变卡片任何字节；不代替独立审核。**

## 1. 做了什么

- 枚举：`alibaba`、`facebook`、`whatsapp`、`website_form`、`email`、`linkedin`、`trade_show`、`other`、`unknown`（缺省 `unknown`）。
- `render_card` 输出 `channel` 与 `channel_ignored`；非法值忽略并计数，不报错、不写卡片。
- `SKILL.md` 第 0 步抽取表加 `channel`：用户说了就填，没说 `unknown`，不追问。
- `data-sources/global.md` 新增第十四节“按来源渠道的起手核实”，覆盖 7 个渠道；`report_template.md` 1.2 增加“询盘来源”，`unknown` 写“未提供”。

## 2. 改动文件

- `scripts/render_card.py`、`scripts/render_card.mjs`
- `SKILL.md`、`data-sources/global.md`、`report_template.md`
- `tests/cases/A153`–`A155`

## 3. 验证

- A153 9 个枚举 + 1 个非法值，卡片字节与不带 `channel` 完全相同；非法值计数 1。
- A154 缺失/空值 → `channel=unknown`，卡片字节不变。
- A155 `global.md` 第十四节覆盖 7 渠道。
- 全量仓库 178/178；包内 A153/A154 通过，A155 因 `global.md` 不进包跳过（预期）。

## 4. 遗留

- 渠道只决定检索起手顺序；不参与风险分、等级、置信度、覆盖分母。
- 报告 1.2 的“未提供”由模板固定，不依赖脚本渲染报告。