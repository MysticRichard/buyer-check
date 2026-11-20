# N-01 开发自测汇报（v0.11.0）

- 日期：2026-11-20
- 分支：工作区（基线 `main` 43e4194 / v0.10.1；本版尚未提交）
- 任务：询盘有效性分类 `lead_class`（P0）
- 结论：**A141–A152 通过；旧证据包字节不变；Python/Node 一致；不代替独立审核。**

## 1. 做了什么

- 新增 20 个枚举信号、8 个类别与固定优先级表；类别、标签、结论句全部由 `render_card` 计算，模型不能直接写 `lead_class`。
- 风险附件扩展名表：`exe scr js jar iso img html htm hta lnk vbs msi bat cmd` 及双扩展名算风险；`pdf docx xlsx jpg png zip rar` 不算。
- 结论行末尾追加 `· 类别：<中文标签>`；`unclear` 不追加；不新增卡片行。
- 结论句优先级：L=高原有句 > 非目标类固定句 > 原模板。非目标类用中性表述（“更像在了解行情”），不使用“同行/竞争对手”等字眼。
- `--json` 新增 `computed.lead_class`、`lead_class_label`、`lead_class_basis[]`、`lead_signals[]`、`lead_signals_ignored`、`lead_class_source`。
- `SKILL.md` 增加 `lead_signals` 抽取规则与“不打开对方链接/附件”的硬性约束；`card_template.md` 新增 2.2；`report_template.md` 新增 1.4。

## 2. 改动文件

- `scripts/render_card.py`、`scripts/render_card.mjs`
- `card_template.md`、`report_template.md`、`SKILL.md`
- `tests/run_cases.mjs`（新增 `lead_matrix`、`render_card_parity` runner）
- `tests/cases/A141`–`A152`

## 3. 验证

- A141 8 类各 ≥2 子用例；A142 优先级；A143 弱信号边界；A144 PDF/DOCX/ZIP 不触发；A145 未知信号计数；A146 旧包快照；A147 遍历不变；A148 L=高结论优先；A149 固定句与行数；A150 禁用词；A151 双语言一致；A152 模板回归。
- 全量：仓库 178/178；包内 172 passed / 0 failed / 6 skipped（A151 因包内无 Node 渲染器跳过，属预期）。
- `card_harbor.expected.txt` 字节比对通过，旧包无 `lead_signals` 时输出不变。

## 4. 遗留

- 信号抽取由模型完成，不是确定性；`lead_class` 只影响建议，不改变风险分、等级、置信度与覆盖分母。
- `render_card.py` 继续变长，未重构；留给下一版。