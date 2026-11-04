# v0.8.1 P0 开发汇报（X20）

日期：2026-11-04  
分支：`v0.9`  
范围：仅 P0（P-01 至 P-04）；P1 未开始。

## 1. P0 门 X 表（开发自测）

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| X1 现有测试不改即通过 | 通过 | `run_cases` 26/26；V5 8,388,608 全过；V6 14/14；F2/F3/G/H/E 全过；`git diff v0.8.0 --name-status -- tests/cases` 仅新增 A23–A26 |
| X2 仿冒域名误报修复 | 通过 | A23 全 false；A24 8/8 true；`domain_similarity` 18/18 Python/Node 一致 |
| X3 制裁自动下载 | 通过 | A25 五场景：no-network、clear、同名命中、模拟下载成功、download-failed；`--no-update` 全程离线 |
| X4 分数条字符 | 通过 | A26 填充 0/1/2/3/9/10/10；Python/Node 一致；`git grep '▓|░|▒'` 无输出 |
| X12 词表合规 | 通过 | 禁用词 grep 无输出；技术词仅在 `card_template.md` 的“技术词→人话”对照表 |
| X13 评分不变 | 通过 | `risk_score.*`/`red_flags.*` 相对 v0.8.0 无 diff；红旗 23 |
| X14 隐私 | 通过 | 仓库与精简包 privacy clean；用例全虚构 |
| X16 文档和版本（P0） | 通过 | SKILL.md 0.8.1；CHANGELOG `[0.8.1]`；规划归档 docs/iteration_plan_v0.9.md |
| X17 历史和分支 | 通过 | v0.8.0 是祖先；P0 提交都在 v0.9；无强推/改写 |
| X20 开发汇报 | 本文件 | B20–B30、变更文件、行为变化、格式断言清单见下 |

P0 门结论（开发自测）：**通过**；等待独立审核 agent 复核。

## 2. B20–B30 自查

| 编号 | 自查 | 结果 |
| --- | --- | --- |
| B20 | 不生成 HTML/图片/需点开的卡片 | P0 未新增卡片文件，仅改模板文字 |
| B21 | 核实度/阶梯/结论句不改评分 | 本版未实现这些指标，风险文件无 diff |
| B22 | 制裁自动下载仅官方 OFAC，支持 --no-update，缓存不入库 | 已实现；只下载官方 CSV；`.cache/` 仍被忽略 |
| B23 | render_card 默认不联网/不写盘/不读时间 | P1 才实现 |
| B24 | 卡片无技术词、禁用词、完整手机号/邮箱 | 示例卡技术词已清理；禁用词 0 |
| B25 | 只收紧假阳性，不放真阳性 | A24 8 个真阳性全部仍为阳性 |
| B26 | registry 只返回公司层字段 | P2 未做 |
| B27 | 招标专项不新增红旗 | P2 未做；红旗仍 23 |
| B28 | 不引入新依赖；Node 版不进包 | 无新依赖；包仍 27 |
| B29 | 不改红旗/权重/公式/色带/覆盖率分母 | 风险文件无 diff |
| B30 | 不强推、不改历史、不改 main | 仅在 v0.9 提交并普通 push |

## 3. 变更文件

- 域名：`scripts/domain_similarity.py/.mjs`、`scripts/brands.json`、`tests/cases/A23.json`、`A24.json`、`tests/run_cases.mjs`、`tests/consistency_scripts.mjs`
- 制裁：`scripts/sanctions_check.py/.mjs`、`scripts/update_sanctions.py/.mjs`、`tests/cases/A25.json`、`tests/run_cases.mjs`
- 卡片：`card_template.md`、`SKILL.md`、`report_template.md`、`examples/sample-report.md`、`docs/iteration_plan.md`、`CHANGELOG.md`、`tests/consistency.mjs`、`tests/cases/A26.json`
- 发布：`SKILL.md`、`CHANGELOG.md`、`docs/development.md`、`docs/iteration_plan_v0.9.md`

## 4. 行为变化

1. 短品牌（≤5 字符）只在连字符词段或 `risk_words` 风险词搭配时判 affixed；`dhlgroup.com`、`fedexgroup.com` 不再单独判仿冒，长品牌与 A24 真阳性不变。
2. `sanctions_check` 无缓存或超过 7 天自动下载 OFAC SDN；`--no-update` 关闭；失败返回 `no-network` / `download-failed`。
3. 分数条统一 `■/□`，10 格，`floor(score/10+0.5)`；卡片人话化，技术词只进对照表/完整报告附录 C。
4. 风险分公式、23 条红旗、权重、色带、覆盖率分母均未改；精简包仍 27 文件。

## 5. 格式断言修改清单

| 文件 | 旧断言/字符 | 新断言/字符 | 理由 |
| --- | --- | --- | --- |
| `card_template.md` | `▓/░/▒` | `■/□`；`floor(分数/10+0.5)` | P-04 界面渲染花纹 |
| `SKILL.md` | 灰 `▒` | 灰 `□`、`■/□` | 同上 |
| `examples/sample-report.md` | `▓▓▓▓▓▓▓▓▓░` | `■■■■■■■■■□` | 同上 |
| `report_template.md` | 灰 `▒` | 灰 `□` | 同上 |
| `docs/iteration_plan.md`、`CHANGELOG.md` | 历史旧字符 | `■/□` 或 U+ 转义 | X4 全仓库 grep |
| `docs/iteration_plan_v0.9.md` | 规划中的旧字符 | `U+2593/U+2591/U+2592` | 避免归档文档自身触发 X4 |
| `tests/consistency.mjs` | 无字符断言 | 无旧字符、必须含 `■/□` | 防回归 |
| `tests/cases/A23/A24` | 无 | 10 假阳性 + 8 真阳性 | P-01 |
| `tests/cases/A25` | 无 | 5 个制裁场景 | P-02 |
| `tests/cases/A26` | 无 | 7 个分数值/双语言公式 | P-04 |

## 6. 提交

`d0f9d10`、`5ac00d3`、`0f100a4`、`2b7ce5d`、`fd17e1d`、`749655c`；均在 `v0.9`，未合并 main、未打 v0.8.1。