# P1 开发自测汇报（v0.9.0）

- 日期：2026-11-05
- 分支：`v0.9`
- 提交范围：`c66b06f`（P1-a）→ `5103911`（P1-b）→ `e1c0670`（P1-c）→ `e14d893`、`87497c0`、`d65ae7e`、`4f716f4`、`4dabdc3`（自测与 CI 修复）
- 结论：**开发自测 P1 门通过；等待独立审核 agent 复核**。本文件不代替审核结论。

## 1. X 表（P1 门）

| 编号 | 结果 | 证据摘要 |
| --- | --- | --- |
| X1 现有测试不改 | 通过 | `node tests/run_cases.mjs` 40/40；`git diff v0.8.0 --name-status -- tests/cases` 只新增 A23–A41，A1–A22 无修改 |
| X2 仿冒域名误报已修复 | 通过 | A23 全部 `is_lookalike:false`（10 个域名）；A24 8/8 `true`，类型符合 |
| X3 制裁自动下载 | 通过 | A25 五场景：`no-network`、`clear`、同名命中、模拟下载成功、`download-failed`；全程 `--no-update` 离线 |
| X4 分数条字符 | 通过 | A26 填充 0/1/2/3/9/10/10；实际旧字符 `git grep` 无输出 |
| X5 核实度 | 通过 | A27 Harbor=90（高）、A28 NORDIC=10（低）；A29 矛盾记 0、人物高 +0.1、缺层记 0 |
| X6 阶梯与结论句 | 通过 | A30/A31 各 768 组合，`violations=0`，Python/Node 一致 |
| X7 快照与行数 | 通过 | A32 43 行、A33 40 行、A34 32 行；第一屏均 10 行；人工读卡符合 5.1/5.7/5.8 |
| X8 校验与降级 | 通过 | A35 八类错误码；A36 旧证据包可渲染；A37 返回 `score-mismatch` |
| X9 确定性与两端一致 | 通过 | A39 100 次字节一致 + Python/Node；`consistency_scripts` 5 张卡 + 768 组合一致 |
| X10 卡片与报告一致 | 通过 | `report_template.md` 0.1.1 与 `examples/sample-report.md` 同步核实度 10、阶梯、六维；与卡片 85/高/10 一致 |
| X11 一句话入口格式 | 通过 | A41 六类 `inquiry_type` 均在枚举内，无完整手机/完整邮箱 |
| X12 词表合规 | 通过 | 禁用词 grep 无输出；技术词只在 `card_template.md` 的“技术词→人话”对照表 |
| X13 评分不变 | 通过 | `git diff v0.8.0 --stat -- risk_score.py risk_score.mjs red_flags.json red_flags.md` 无输出；红旗 23 |
| X14 隐私 | 通过 | 仓库 privacy 121 文件 clean；精简包 28 文件 clean |
| X15 精简包 | 通过 | 28 文件、456,997 bytes；包内 `run_cases` 40/40；测试后仍 28 文件 |
| X16 文档与版本 | 通过 | `SKILL.md`、`submission.manifest.json` 为 0.9.0；CHANGELOG `[0.9.0]`；`docs/development.md` 已加 v0.9.0 |
| X17 历史与分支 | 通过 | `git merge-base --is-ancestor v0.8.0 HEAD` 退出码 0；提交都在 `v0.9`；无强推/无改写 |
| X18 CI | 通过 | run `41947059544` 全部步骤 success（含 S2/S3） |
| X20 开发汇报 | 本文件 | 五要素见下 |

## 2. B20–B30 自查

| 编号 | 自查结果 |
| --- | --- |
| B20 卡片只显示不落盘 | `render_card` 只写 stdout，不生成 HTML/图片/文件 |
| B21 只显示不改评分 | 核实度、六维、阶梯、结论句均不参与风险分、等级、置信度；A27/A30 覆盖 |
| B22 制裁自动下载 | 仅下载 OFAC 官方 CSV；`--no-update` 可用；缓存不入库 |
| B23 render_card 约束 | 不联网、不写盘、不读系统时间、无第三方依赖 |
| B24 卡片文字 | 技术词、禁用词、完整手机/邮箱由 A35 校验 |
| B25 仿冒真阳性 | A23/A24 通过；P0 门已由独立审核确认 |
| B26 registry 隐私 | P2 未做 |
| B27 招标专项 | 只选检查与话术，未新增红旗；仍 23 条 |
| B28 依赖与包 | 无新依赖；`render_card.mjs` 不进包 |
| B29 评分不变 | 评分文件相对 v0.8.0 无 diff |
| B30 分支纪律 | 仅 `v0.9` 普通推送；未改 main、未强推、未改写历史 |

## 3. 变更文件

- 模板：`card_template.md`、`report_template.md`、`examples/sample-report.md`
- 脚本：`scripts/render_card.py`、`scripts/render_card.mjs`、`scripts/build_submission.mjs`
- 测试：`tests/run_cases.mjs`、`tests/consistency.mjs`、`tests/consistency_scripts.mjs`、`tests/cases/A27–A39`、`tests/cases/A41`、`tests/fixtures/card_harbor.json`、`card_nordic.json`、`card_manual.json`、`legacy_card.json`、`score_mismatch.json`、`card_harbor.expected.txt`、`card_nordic.expected.txt`
- 发布与文档：`SKILL.md`、`README.md`、`CHANGELOG.md`、`docs/development.md`、`docs/p0-report-v0.8.1.md`、`submission.manifest.json`、`.github/workflows/ci.yml`、`data-sources/global.md`、`data-sources/collection_checklists.md`

## 4. 行为变化

1. 结论卡改为脚本渲染：核实度、六维表、四级动作阶梯、三栏风险点、一次动作；模型只填 `display` 文字字段。
2. `SKILL.md` 新增第 0 步：一句话/一段询盘直接开始，抽取 `intake`，判六类询盘；招标走 T1–T4；支持“快查”。
3. 精简包 27 → 28，新增 `scripts/render_card.py`；`render_card.mjs` 仅仓库内做一致性对照。
4. 报告开头加 0.1.1 核实度/阶梯/六维表；附录 C 记录被排除的误报；样例报告同步。
5. 修复 Node 20 下大输出被 `process.exit` 截断：改为设置 `process.exitCode`，让标准输出自然刷新。
6. 风险分公式、23 条红旗与权重、等级色带、覆盖率分母（8）均未改。

## 5. 格式断言修改清单

| 文件 | 旧断言 | 新断言 | 理由 |
| --- | --- | --- | --- |
| `tests/consistency.mjs` | `card_template.md` 必须含 `'三层｜'` | 必须含 `'核实度'、'动作阶梯'、'六维'、'需要注意'、'没查到不代表没问题'、'一次动作'` | 模板删除三层行，改为六维表与三栏风险点 |
| `tests/consistency.mjs` | `report_template.md` 无核实度断言 | 新增 `'核实度'、'动作阶梯'、'六维表'` | 报告开头同步 v0.9 版式 |

其他测试为新增用例，未修改 A1–A22 的期望值。A35 的禁用词测试值用 JSON `\u9a97\u5b50` 转义，解析后仍为“骗子”，测试语义不变。

## 6. 验收命令摘要

```text
node tests/run_cases.mjs                → 40 passed, 0 failed
node tests/consistency.mjs              → consistency checks passed
node tests/consistency_scripts.mjs      → script consistency checks passed
node tests/account_check_cases.mjs      → passed
node tests/check_sources_cases.mjs      → passed
node tests/ip_check_cases.mjs           → passed
node tests/phone_check_enrich_cases.mjs → passed（1 skipped）
node tests/eval/score_eval.mjs --self   → self-check passed
node scripts/privacy_scan.mjs           → clean（121 文件）
node scripts/build_submission.mjs       → 28 files / 456,997 bytes
(cd dist/submission && node tests/run_cases.mjs) → 40 passed；测试后仍 28 文件
node scripts/privacy_scan.mjs dist/submission → clean（28 文件）
git diff v0.8.0 --stat -- risk_score.* red_flags.* → 无输出
git merge-base --is-ancestor v0.8.0 HEAD → 退出码 0
CI run 41947059544                     → success（38s）
```

## 7. 待办

- 交独立审核 agent 跑 P1 门，由其给出“P1 门通过 / 不通过”。
- P1 门通过后再做 P2（`identity_check registry` + A40）；若未通过则按规划放弃 P1/P2。
- 合并 `main`、打 `v0.9.0` 标签需负责人确认。