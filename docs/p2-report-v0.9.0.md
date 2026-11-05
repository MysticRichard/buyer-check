# P2 开发自测汇报（v0.9.0）

- 日期：2026-11-05
- 分支：`v0.9`
- 功能 HEAD：`75445c2`（`feat(registry): add Norway Enhetsregisteret lookup`）
- 结论：**开发自测 P2 门通过；等待独立审核 agent 复核**。本文件不代替审核结论。
- 说明：本文件如为纯文档提交，不影响功能 HEAD 的代码、精简包与 CI 证据。

## 1. P2 门（X19 + P1 门回归）

| 编号 | 结果 | 证据摘要 |
| --- | --- | --- |
| **X19 注册库自动查** | 通过 | A40 六类：found / not-found / ambiguous / unavailable / offline / 注册地址国不一致（`country_mismatch:true`）；离线只给 `registry_url`；输出无董事/股东字段；只实现挪威 1 国；Py/Node 六例一致 |
| X1 现有测试不改 | 通过 | `node tests/run_cases.mjs` 41/41；`git diff v0.8.0 --name-status -- tests/cases` 只新增 A23–A41，A1–A22 无修改 |
| X2 仿冒域名 | 通过 | A23 10/10 `false`；A24 8/8 `true` 且类型正确 |
| X3 制裁下载 | 通过 | A25 五场景离线通过 |
| X4 分数条字符 | 通过 | A26 0/1/2/3/9/10/10；实际旧字符 grep 无输出 |
| X5 核实度 | 通过 | A27=90 高、A28=10 低；A29 边界通过 |
| X6 阶梯与结论句 | 通过 | A30/A31 各 768 组合，`violations=0`，Py/Node 一致 |
| X7 三卡快照 | 通过 | A32/A33/A34 均为 `card_file` 全文字节比对；43/40/32 行，首屏 10 |
| X8 校验与降级 | 通过 | A35 八类错误码；A36 旧包；A37 `score-mismatch` |
| X9 确定性与两端一致 | 通过 | A39 100 次一致 + Py/Node；`consistency_scripts` render_card 5/5 + 768 组合 |
| X10 卡片与报告一致 | 通过 | `report_template.md` 0.1.1 与样例报告 85/高/10 一致 |
| X11 intake 格式 | 通过 | A41 六类枚举，无完整手机/邮箱 |
| X12 词表 | 通过 | 产品文档禁用词 0；技术词只在对照表 |
| X13 评分不变 | 通过 | `risk_score.*`、`red_flags.*` 相对 v0.8.0 无 diff；红旗 23 |
| X14 隐私 | 通过 | 仓库 privacy 124 文件 clean；精简包 28 文件 clean |
| X15 精简包 | 通过 | 28 文件 / 474,196 bytes；含 `render_card.py`；包内 41/41；测试后仍 28 文件 |
| X16 文档与版本 | 通过 | `SKILL.md`/manifest 0.9.0；CHANGELOG `[0.9.0]` 含 registry；README 有版本行；`global.md` 注册库通道与 NLOD |
| X17 历史与分支 | 通过 | `v0.8.0` 是祖先；提交都在 `v0.9`；无强推/改写 |
| X18 CI | 通过 | 功能 HEAD `75445c2` 的 run `41950896686` 全部步骤 success（含 S2/S3） |
| X20 开发汇报 | 本文件 | 五要素见下 |

## 2. 官方条款与真实请求核对

- 官方文档：**Enhetsregisterets dokumentasjon for åpne data 2.0.0**（`https://data.brreg.no/enhetsregisteret/api/dokumentasjon/no/index.html`）。
- 许可：**NLOD 2.0**（`https://data.norge.no/nlod/no/2.0`）；条款允许复制、使用、提供信息，需署名贡献者并遵守条款；免责声明。文档页标注 License: NLOD 2.0。
- 真实请求（2026-11-05）：`Equinor ASA` → `found`，`legal_name=EQUINOR ASA`、`org_number=923609016`、`status_text=存续`、`incorporation_date=1995-03-12`、`address_country=NO`；Python 与 Node 输出一致（`retrieved_at` 为请求时刻）。
- API 返回字段核对：原始实体无董事/股东字段；实现只映射公司级白名单字段。

## 3. B20–B30 自查（重点项）

| 编号 | 自查结果 |
| --- | --- |
| B20 卡片只显示不落盘 | registry 不生成卡片/文件；结论卡仍由 `render_card` 输出 stdout |
| B21 只显示不改评分 | registry 不参与风险分、等级、置信度；评分文件零 diff |
| B22 制裁下载 | 未改；`--no-update` 仍生效 |
| B23 render_card 约束 | 未改；registry 不影响 render_card 的离线/确定性 |
| B24 卡片文字 | 未新增卡片文字；A35 仍覆盖 |
| B25 仿冒真阳性 | 未改；A23/A24 通过 |
| **B26 registry 隐私** | 只返回 `legal_name/org_number/status_text/incorporation_date/address_country/source_url/retrieved_at`；不返回董事/股东；联网只发送公司名和国家（NO）；A40 断言无 `dagligLeder/styre/aksjonærer` 等 |
| B27 招标专项 | 未新增红旗；仍 23 |
| **B28 依赖与包** | 无新依赖；`registry` 并入既有 `identity_check.py/.mjs`，不新增进包文件；包仍 28 |
| B29 评分不变 | 评分/红旗文件零 diff |
| B30 分支纪律 | 仅 `v0.9` 普通推送；未改 main、未强推、未改写历史 |

## 4. 变更文件

- 脚本：`scripts/identity_check.py`、`scripts/identity_check.mjs`（新增 `registry` 子命令）
- 测试：`tests/cases/A40.json`、`tests/run_cases.mjs`（新增 `registry` 运行器）
- 文档：`SKILL.md`、`README.md`、`data-sources/global.md`、`CHANGELOG.md`、`docs/development.md`
- 发布：`submission.manifest.json`（SKILL/README 重写规则同步）

## 5. 行为变化

1. `identity_check registry` 新增：默认离线只返回搜索链接；`--online` 查询挪威 Enhetsregisteret（NLOD 2.0）。
2. 只发送公司名和国家（NO），只返回公司级字段；不返回、不保存董事/股东个人信息。
3. 支持 found / not-found / ambiguous / unavailable / offline；注册地址国与自称国不一致时给 `country_mismatch`，供模型按既有 RF-CORP-001 线索判断，不新增红旗。
4. 其他国家维持链接 + 一次动作；不硬实现、不猜测。
5. 风险分公式、23 条红旗与权重、等级色带、覆盖率分母（8）、精简包 28 文件均未变。

## 6. 格式断言修改清单

无新增格式断言。A40 是新增功能用例；A1–A22 与 P1 的格式断言未改。

## 7. 验收命令摘要

```text
node tests/run_cases.mjs                → 41 passed, 0 failed
node tests/consistency.mjs              → consistency checks passed
node tests/consistency_scripts.mjs      → script consistency checks passed
node scripts/privacy_scan.mjs           → clean（124 文件）
node scripts/build_submission.mjs       → 28 files / 474,196 bytes
(cd dist/submission && node tests/run_cases.mjs) → 41 passed；测试后仍 28 文件
node scripts/privacy_scan.mjs dist/submission → clean（28 文件）
A40                                     → 六类场景全过；Py/Node 一致；无个人字段
真实请求 Equinor ASA（--online）         → found；Py/Node 字段一致
git diff v0.8.0 --stat -- risk_score.* red_flags.* → 无输出
git merge-base --is-ancestor v0.8.0 HEAD → 退出码 0
CI run 41950896686（功能 HEAD 75445c2） → success（29s）
```

## 8. 待办

- 交独立审核 agent 跑 P2 门（X19 + P1 门回归），由其给出“P2 门通过 / 不通过”。
- P2 门通过后，合并 `main`、打 `v0.9.0` 标签、上传市场需负责人确认。
- 若审核发现 `registry` 字段/隐私问题，先修再复核；不进入合并。