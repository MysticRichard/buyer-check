# BuyerCheck 迭代规划 v0.11.0（第六版）：询盘有效性与来源画像

> 面向开发 agent 与审核 agent 的执行文档。基线：`main` 提交 `c6c1a54`，版本 v0.10.1。
> 起草日期：2026-11-18（同日追加 N-08 使用引导）。状态：**草案，待负责人确认第 10 节的问题后开工**。
> 本文的基线事实来自对仓库文件的阅读；起草时**没有运行测试**，所以“现有测试全部通过”需要开发 agent 在开工前自己确认。

---

## 0. 给 agent 的使用说明

1. 先读本文第 1–3 节，再读 `SKILL.md`、`red_flags.md`、`card_template.md`、`submission.manifest.json`，最后读你负责的任务。
2. **一个任务一个分支**，分支名 `feat/v0.11-<任务编号>`；提交信息用英文 Conventional Commits，scope 用模块名（如 `feat(card): add lead_class line`）。
3. 不得改写 git 历史，不得强推 `main`。
4. 遇到本文第 10 节的问题，**先停下问负责人**，不要自己选；负责人未答复时，按“推荐默认”实现且不合并。
5. 精简包放不下（超过 28 个文件，或需要新增进包文件）时，**先问负责人再取舍**，不要自行删文件。
6. 查不到的信息写 `null`，不猜测；本文没有核实过的网址、阈值、名单，都标了“待核实”，agent 必须自己打开官方页面核对后才能写进仓库。
7. 每个任务完成后写 `docs/p<任务编号>-report-v0.11.0.md`（格式参照 `docs/p1-report-v0.9.0.md`）：做了什么、改了哪些文件、新增哪些用例、遗留问题。
8. 如果代码行为与文档矛盾，**不要改代码去迁就文档**，先记入报告并问负责人。

---

## 1. 基线（已核实的事实）

| 项目 | 现状 | 依据 |
| --- | --- | --- |
| 版本 | 0.10.1 | `SKILL.md` frontmatter、`submission.manifest.json` |
| 红旗 | 31 条（23 条在红旗总表，8 条在文末 v0.10.0 小节） | `red_flags.md` |
| 国家矩阵 | 20 国：ae bh cn id in kh kw lb ly mx my om ph qa sa sg th us vn za | `scripts/country_capabilities.json` |
| 验收用例 | A1–A140，`tests/cases/*.json` | 仓库 |
| 评测集 | 45 条合成询盘（13 条正常），`tests/eval/inquiries.jsonl`，字段 `id/text/expected_flags/note/source` | 仓库 |
| 精简包 | `submission.manifest.json` 里 26 个复制文件 + 2 个合并产物 = **28，已满额** | `submission.manifest.json` |
| 不进精简包的脚本 | `ip_check`、`update_sanctions`、`check_sources`、`privacy_scan`、`build_submission`、`render_card.mjs`、`identity_check.mjs` 等；进包的 Node 脚本只有 `risk_score.mjs`、`domain_similarity.mjs`、`whois_lookup.mjs` | 同上 |
| 制裁名单 | 只配置 OFAC SDN；`sanctions_check.py` 的 `LIST_FILES` 里 EU/UN/UK 只有文件名占位，没有下载地址 | `scripts/sanctions_check.py`、`data-sources/global.md` 第四节 |
| 使用引导 | `README.md` 有一个“快速开始”示例；`SKILL.md` 没有求助词触发，缺关键信息时只“问一次”；卡片末尾的补充建议只在查完后出现 | grep `使用指南/怎么用/帮助/help` 无命中 |
| `intake` 字段 | `company person email domain phone country city product quantity amount inquiry_text inquiry_type best_next`；**没有渠道、没有表单元数据、没有收货信息** | `card_template.md` 2.1、`SKILL.md` 第 0 步 |
| `inquiry_type` | 六类风险场景：`tender sample large_first_order account_change pre_order general`，**没有“询盘是否有效”的分类** | 同上 |
| 渠道起手线索 | 只存在于 `docs/iteration_plan.md` 的“按询盘来源的起手线索”表，没有进入 `SKILL.md`、卡片、报告、`data-sources/` | grep 核对 |
| 测试覆盖（11 条评测零覆盖红旗） | 其中 10 条在 `tests/cases` 或夹具里有引用；**`RF-SAN-001` 在用例和夹具里都没有引用** | 本次 grep |
| 文档不一致 | 红旗总表标题写 31 条但只列 23 条；8 条新红旗没有“判定细则”；`RF-ID-004/005` 编号文件里写着待负责人决定；`docs/development.md` 路线图仍指向 v0.8；仓库里没有 v0.10 的迭代方案文档 | `red_flags.md`、`docs/` |

**两个会让开发 agent 踩坑的构建细节**

- `submission.manifest.json` 的 `rewrites` 里写死了整段原文（含 `A1–A140`、`45 条合成询盘`、`16 国` 等）。只要 `SKILL.md` 或 `README.md` 里对应句子改了，`from` 就匹配不上，精简包会带着旧口径或构建失败。**改 `SKILL.md`/`README.md` 的任何数字，必须同步改 `rewrites`。**
- `render_card.py` 约定“不联网、不写盘、不读系统时间”，并有一批“旧证据包字节一致”的快照用例。新增字段必须保持这个约定。

---

## 2. 版本目标与边界

### 2.1 目标

用户最初的问题是“如何判断这是一条有效的询盘”。v0.10.1 回答的是“风险有多高”，没回答“值不值得回”。本版补四件事：

- **G1 询盘有效性**：把询盘分成目标客户、分销商、疑似同行、供应商推销、钓鱼型、个人调研、自动提交、信息不足，给出对应的建议动作。
- **G2 来源画像**：把询盘来源渠道和官网表单的提交信息纳入输入，只作线索，不计分。
- **G3 可信度**：补评测、补制裁名单、补收货信息提示、补独立渠道验证动作，并清理文档欠账。
- **G4 上手门槛**：用户装完 Skill 不知道该给什么信息、去哪里找、结果怎么看。补一份使用指南：告诉用户要提供哪些信息、这些信息去哪里拿、给可直接复制的示例，并在用户求助或输入为空时自动出示。

### 2.2 本版不做

- **不新增红旗，不改任何权重**。分类和表单信号先只做线索与建议，等评测数据足够后再提案。
- 不做 HTML 卡片，不引入付费数据源、无头浏览器、人脸识别。
- 不使用按邮箱或用户名枚举账号的工具（Sherlock/Maigret/Holehe/Epieos/Gravatar 一类），不查邮箱泄露库。
- 不做深度伪造检测；视频核验只作为“增加冒充成本”的话术，不当证据。
- 不做成交后持续监控、本地历史去重（见第 9 节候选清单）。
- 不做“安装时主动弹出提示”：Skill 只在用户发话后才运行，安装那一刻无法向用户推送消息。使用引导改为 README 上手段 + 求助/空输入时的指南卡（见 N-08）。
- 不判定出口管制、两用物项是否适用；只给“需自查”的提示，不构成法律意见。

---

## 3. 不变量（任何任务不得违反）

| 编号 | 不变量 |
| --- | --- |
| INV-01 | 风险分公式、分档（0–29/30–59/60–100）、31 条红旗编号与权重、覆盖分母 8、置信度规则 R1–R5 不变 |
| INV-02 | 所有新增字段**可选**；旧证据包（不含新字段）渲染结果与 v0.10.1 **字节一致** |
| INV-03 | 新增分类、信号、表单元数据**不得改变**风险分、等级、置信度、覆盖分子分母（用遍历用例证明） |
| INV-04 | 查不到只降置信度，不加风险分；只有积极矛盾才计分 |
| INV-05 | “模型填文字，脚本算结果”：`lead_class` 由脚本按信号表算出，模型只能填**枚举信号**，不能直接填类别 |
| INV-06 | 不下定性结论：卡片与报告里的类别文字全部来自脚本里的固定模板，不使用“骗子、诈骗犯、竞争对手”等字眼指称具体公司或个人 |
| INV-07 | 个人姓名、邮箱、电话继续脱敏；**完整 IP 不写入证据包、卡片、报告**，只保留 IPv4 /24、IPv6 /48 |
| INV-08 | 精简包仍 ≤28 个文件、≤40MB，无新增必需第三方依赖；新增逻辑并入既有文件 |
| INV-09 | Python 为准，Node 对照实现保持一致（`tests/consistency_scripts.mjs`） |
| INV-10 | 不绕过登录、验证码、付费墙；不批量抓取；注册库只给链接；不保存头像或其哈希 |
| INV-11 | 卡片行数预算不变：深查 ≤50 行，快查 ≤30 行，第一屏 ≤14 行；使用指南不是结论卡，有自己的行数预算（见 N-08），也不得往结论卡里加行 |
| INV-12 | 话术：英文为主，附一句中文含义；语气委婉含蓄，不让客户察觉真实意图（负责人已确认的偏好） |

---

## 4. 任务总表

| 编号 | 任务 | 优先级 | 主要改动文件 | 新增用例 |
| --- | --- | --- | --- | --- |
| N-04 | 评测补洞与指标（先做，建基线） | P0 | `tests/eval/*`、`tests/cases/`、`docs/validation.md` | A161–A162、E046–E085 |
| N-01 | 询盘有效性分类 `lead_class` | P0 | `render_card.py/.mjs`、`card_template.md`、`report_template.md`、`SKILL.md` | A141–A152 |
| N-02 | 来源渠道 `intake.channel` | P0 | `SKILL.md`、`data-sources/global.md`、`report_template.md` | A153–A155 |
| N-03 | 官网表单元数据 `form_meta` | P0 | `render_card.py/.mjs`、`card_template.md`、`privacy_scan.mjs` | A156–A160、A170 |
| N-08 | 使用指南与首次上手引导 | P0 | `render_card.py/.mjs`（`--guide`）、`card_template.md`、`SKILL.md`、`README.md` | A171–A178 |
| N-05 | 制裁名单扩展 EU/UN/UK | P1（需 Q3） | `sanctions_check.py/.mjs`、`data-sources/global.md` | A163–A164 |
| N-06 | 收货信息与目的地提示 | P1 | `render_card.py/.mjs`、`country_capabilities.json`、`report_template.md` | A165–A167 |
| N-07 | 独立渠道验证动作与视频核验话术 | P1 | `data-sources/global.md`、`render_card.py/.mjs`、`card_template.md` | A168–A169 |
| D-01…D-07 | 文档对账 | P0 | 见第 8 节 | 沿用 `consistency.mjs` |

**建议执行顺序**：N-04（先跑基线）→ N-01 → N-03 → N-02 → N-08 → N-07 → N-06 → N-05 → D 系列 → 发布。N-01 与 N-03 共用信号表，必须按此顺序合并；N-08 的指南内容要引用 N-01/N-02/N-03 的字段与示例，所以排在它们之后。

---

## 5. 任务规格

### N-04 评测补洞与指标（P0，先做）

**目的**：让后面的分类和线索有可度量的基线，并补上唯一没有任何用例引用的红旗。

**N-04a 红旗用例补洞**
1. 开工前先运行 `grep -l "<红旗编号>" tests/cases/*.json tests/fixtures/*`，对 11 条评测零覆盖红旗逐条核对，把结果写进任务报告。
2. `RF-SAN-001` 目前没有用例：新增 A161（制裁命中且人工**未**排除 → 计 5 分，等级为高）和 A162（同名但国家或主体明显不同，人工排除 → 不计分；脚本只输出 `requires_manual_review`，不自动计分）。
3. 其余 10 条已有引用的，只需在报告里确认正反例都存在；缺反例的补一条。

**N-04b 评测语料扩充（`tests/eval/inquiries.jsonl`，E046–E085，共 40 条）**

| 类型 | 数量 | 说明 |
| --- | --- | --- |
| 非目标类 | 15 | 供应商推销 4、疑似同行 4、钓鱼型 3、个人调研 2、自动提交 2 |
| 目标类 | 6 | 终端用户项目 3、分销/安装商 3 |
| 新兴市场真实小买家（反例） | 12 | 免费邮箱、无官网、WhatsApp 起手、非英语（阿拉伯语、越南语、印尼语、葡语各至少 1 条）；`expected_flags: []`，且类别不得落入非目标类 |
| 既有红旗的近似但不应命中的样例 | 7 | 例：合法的新注册域名、经回拨确认的账户变更通知、合理的买方指定货代 |

- 新增字段：`expected_lead_signals`（枚举数组）、`expected_lead_class`、`lang`。旧 45 条不改，缺新字段视为未标注。
- 全部合成：公司名虚构，域名用 `.example`，电话用保留号段，不含真实客户信息。
- 非英语样本必须是自然表达，不要逐字机翻英文。

**N-04c 评分器**：`tests/eval/score_eval.mjs` 增加类别级精确率、召回率和混淆矩阵；`--self` 自检保留。有预测文件时才算模型表现，**不作为 CI 门槛**，只作为报告目标：真实小买家被误分到非目标类的比例 ≤5%。

**N-04d**：`docs/validation.md` 增加 v0.11 小节：每条红旗与每个类别的样本数、精确率、召回率、已知局限。

**验收**：A161–A162 通过；`node tests/eval/score_eval.mjs --self` 通过；`SKILL.md`、`README.md`、`manifest.rewrites` 里的“45 条”统一改为“85 条”。

---

### N-01 询盘有效性分类 `lead_class`（P0）

**机制（沿用“模型填枚举、脚本算结果”）**

模型从询盘原文里勾选可观察的信号，写入 `intake.lead_signals[]`（最多 8 个）；`render_card` 按下面的优先级表算出 `lead_class`。模型不能直接写类别；如果证据包里出现 `intake.lead_class`，脚本忽略它并在 `--json` 里标 `lead_class_source: "signals"`。

**信号枚举（初版，agent 可提出补充但不得删减）**

| 信号 | 含义 |
| --- | --- |
| `names_product_model` | 提到具体型号或规格 |
| `states_quantity` | 给出数量 |
| `states_end_use_project` | 说明自用或项目用途 |
| `states_target_market` | 说明目标市场或交货地 |
| `asks_certifications` | 询问认证 |
| `mentions_resale_or_distribution` | 提到转售、分销、安装、集成 |
| `mentions_own_brand_oem` | 提到自有品牌或 OEM |
| `generic_no_product` | 没有任何具体产品信息的泛泛询盘 |
| `asks_full_price_list_only` | 只要全部价格表，不提数量 |
| `asks_catalog_only` | 只要目录 |
| `asks_factory_cost_structure` | 询问成本构成、底价、工艺细节 |
| `asks_customer_or_supplier_list` | 询问客户名单或上游供应商名单 |
| `offers_seo_web_marketing` | 推销 SEO、建站、推广 |
| `offers_inspection_audit_service` | 推销验厂、认证、质检服务 |
| `offers_freight_or_platform_service` | 推销货代、平台、付费广告 |
| `offers_sourcing_or_supply` | 对方想向你销售商品或代采 |
| `contains_login_or_download_link` | 要求登录、下载、扫码、打开共享文档链接 |
| `contains_attachment_risky_ext` | 附件扩展名在风险表内（见下） |
| `student_or_research_purpose` | 学生、调研、论文 |
| `personal_use_small_qty` | 个人自用的小量购买 |

**风险附件扩展名表（常量写进 `render_card.py`）**：`exe scr js jar iso img html htm hta lnk vbs msi bat cmd`，以及双扩展名（如 `.pdf.exe`）。`pdf docx xlsx jpg png zip rar` 本身**不算**风险（真实买家常发规格书和图纸）。

**类别与优先级（从上到下，第一条命中即停）**

| 顺序 | 类别 id | 中文标签 | 命中条件 | 目标客户 |
| --- | --- | --- | --- | --- |
| 0 | `automated_submission` | 自动提交 | `form_meta.honeypot_triggered == true`（见 N-03） | 否 |
| 1 | `phishing_like` | 含需登录或下载内容 | 含 `contains_login_or_download_link` 或 `contains_attachment_risky_ext` | 否 |
| 2 | `vendor_solicitation` | 供应商推销 | 含任一 `offers_*` | 否 |
| 3 | `competitor_probe` | 更像同行了解行情 | 含 `asks_customer_or_supplier_list`；或「弱信号」≥2 且无任何「具体信号」 | 否 |
| 4 | `individual_research` | 个人或调研 | 含 `student_or_research_purpose` 或 `personal_use_small_qty` | 低优先 |
| 5 | `target_end_user` | 终端用户或项目 | 含 `states_end_use_project` 且（含 `names_product_model` 或 `states_quantity`） | 是 |
| 6 | `reseller` | 分销商、安装商或贸易商 | 含 `mentions_resale_or_distribution` 或 `mentions_own_brand_oem`，且（含 `names_product_model` 或 `states_quantity` 或 `states_target_market`） | 是 |
| 7 | `unclear` | 信息不足 | 其余情况（默认值，不输出建议） | — |

- 「弱信号」= `generic_no_product`、`asks_full_price_list_only`、`asks_catalog_only`、`asks_factory_cost_structure`。
- 「具体信号」= `names_product_model`、`states_quantity`、`states_end_use_project`、`states_target_market`。
- 单个弱信号 → `unclear`，不分到非目标类（避免误伤真实小买家）。

**显示规则**

- **不新增行**。结论行 `客户：名称（国家/城市）· 询盘类型` 末尾追加 `· 类别：<中文标签>`；`unclear` 不追加。
- 结论句优先级：**L=高的原有结论句 > 本表的固定结论句 > 原有模板**。风险最高时先说风险。

| 类别 | 固定结论句（脚本常量，模型不得改写） |
| --- | --- |
| `automated_submission` | 这条提交像自动程序发出的，先不回复。 |
| `phishing_like` | 询盘里有需登录或下载的内容：先不要打开，用官网公示的渠道确认后再处理。 |
| `vendor_solicitation` | 这更像向你推销服务，不是采购询盘：可以归档。 |
| `competitor_probe` | 这条更像了解行情：只发标准目录和公开价，不发底价和客户信息。 |
| `individual_research` | 看起来是个人或调研需求：低优先级，按标准资料回复即可。 |

- 目标类（`target_end_user`、`reseller`）和 `unclear` 不改结论句。
- 类别不改变动作阶梯的四行逻辑（INV-03）。

**报告**：`report_template.md` 新增 `1.4 询盘有效性判断`：信号清单（每条带询盘原文引用，已脱敏）→ 类别 → 建议。附一句固定声明：“类别由固定规则按所列信号得出，只用于安排跟进优先级，不是对对方的定性。”

**硬性约束新增（写入 `SKILL.md`）**：背调过程中**不打开对方发来的链接和附件**；只比对链接域名与附件扩展名，需要查看时由用户在隔离环境自行处理。

**Schema**：`intake.lead_signals[]`（可选）；`render_card --json` 新增 `computed.lead_class`、`computed.lead_class_label`、`computed.lead_class_basis[]`、`computed.lead_signals_ignored`（未知信号个数，未知信号被忽略、不报错）。

**验收（A141–A152）**

| 编号 | 内容 |
| --- | --- |
| A141 | 8 个类别各 ≥2 个子用例的信号→类别映射 |
| A142 | 优先级：同时含自动提交、钓鱼、推销、同行信号时按表中顺序取第一条 |
| A143 | 单个弱信号 → `unclear`；弱信号 ≥2 且无具体信号 → `competitor_probe`；含 `asks_customer_or_supplier_list` → `competitor_probe` |
| A144 | 真实买家附 PDF/DOCX/ZIP 规格书且无登录链接 → 不触发 `phishing_like` |
| A145 | 未知信号被忽略并计数，卡片照常渲染 |
| A146 | 不含 `lead_signals` 的旧证据包渲染与 v0.10.1 字节一致（复用现有快照） |
| A147 | 遍历：同一证据包搭配不同信号组合，`risk_score`、等级、置信度、覆盖分子分母不变 |
| A148 | L=高时结论句仍是“先不要投入…”，类别标签仍显示 |
| A149 | 5 个非目标类的固定结论句渲染正确；深查 ≤50 行、快查 ≤30 行、第一屏 ≤14 行 |
| A150 | 卡片与报告不出现“骗子、诈骗、同行、竞争对手”等字眼（固定结论句里“了解行情”除外） |
| A151 | Python 与 Node 的 `computed.lead_class` 一致 |
| A152 | `report_template.md` 含 1.4 小节且类别与卡片一致（并入 `tests/consistency.mjs` 模板回归） |

---

### N-02 来源渠道 `intake.channel`（P0）

**枚举**：`alibaba`、`facebook`、`whatsapp`、`website_form`、`email`、`linkedin`、`trade_show`、`other`、`unknown`（缺省 `unknown`）。

**改动**
1. `SKILL.md` 第 0 步的抽取表加 `channel`：用户说了就填，没说就 `unknown`，**不追问**。
2. `data-sources/global.md` 新增第十四节“按来源渠道的起手核实”。先读 `docs/iteration_plan.md` 里已有的四行表，再补 `email`、`linkedin`、`trade_show`。内容草案如下，agent 可按现行脚本能力润色，但不得删减项目：

| 渠道 | 优先核实 |
| --- | --- |
| `alibaba` | 平台资料卡（认证、注册年限、询盘记录）与对话是否一致；是否诱导离开平台（RF-BEH-001） |
| `facebook` | 主页创建时间、管理员所在国家、头像是否盗图、是否商业主页 |
| `whatsapp` | 号码国别与自称是否一致；商业资料里的网站和邮箱；头像 |
| `website_form` | 邮箱域与填写的公司名是否对应；表单元数据（见 N-03） |
| `email` | 邮件头（`email_header_check`）、Reply-To、发件域 DMARC/SPF |
| `linkedin` | 对方主页现任职公司与自称是否一致、主页创建时间、是否模板化群发私信 |
| `trade_show` | 参展商名录里是否有该公司；名片上的公司名、域名、电话是否一致 |

3. `report_template.md` 的 `1.2` 增加一行“询盘来源：<渠道>”；`unknown` 写“未提供”。

**行为约束**：渠道**只影响检索起手顺序和报告 1.2，不改卡片任何字节**。这条用 A153 证明。

**验收**

| 编号 | 内容 |
| --- | --- |
| A153 | 同一证据包，`channel` 取每个枚举值，卡片字节与不带 `channel` 完全相同；非法枚举值被忽略并计数 |
| A154 | 缺失 `channel` → 报告 1.2 显示“未提供” |
| A155 | `global.md` 第十四节覆盖 7 个渠道（模板回归，并入 `consistency.mjs`） |

---

### N-03 官网表单元数据 `form_meta`（P0）

**背景**：来自自己官网表单的询盘，表单后台通常带有提交 IP、来源页、提交时间等信息。这些是比对方自述更难伪造的线索。本 Skill **只接收用户粘贴，不采集、不植入追踪**。

**字段（全部可选，写入 `intake.form_meta`）**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `submit_ip_masked` | string | 只存脱敏网段：IPv4 /24（如 `203.0.113.0/24`）、IPv6 /48。完整 IP 出现在证据包里 → `invalid-input` |
| `referrer_domain` | string | 来源页域名，不含路径与参数 |
| `utm_source` | string | 广告或渠道标记 |
| `landing_page_path` | string | 落地页路径 |
| `pages_viewed_before_submit` | int | 提交前浏览页数 |
| `seconds_to_submit` | int | 打开表单到提交的秒数 |
| `honeypot_triggered` | bool | 蜜罐字段是否被填 |
| `captcha_passed` | bool | 人机验证是否通过 |
| `ip_origin` | object | 与 `checks[].ip_origin` 同结构，由仓库内 `ip_check --online` 得出后粘贴；精简包没有 `ip_check`，缺省 `not-covered` |

**行为**
- 脱敏函数写成纯函数放进 `render_card.py`（不联网、不写盘），不依赖 `ip_check`。
- 计算 `form_meta.anomalies[]`（**只作线索，不计分**）：

| 标记 | 条件（初始阈值，待用 ≥50 条脱敏真实数据校准，见 Q2） |
| --- | --- |
| `honeypot` | `honeypot_triggered == true` |
| `fast-submit` | `seconds_to_submit` < 5 |
| `direct-no-browse` | `pages_viewed_before_submit == 0` 且 `referrer_domain` 缺失 |

- 只有 `honeypot` 会触发 `automated_submission` 类别；`fast-submit`、`direct-no-browse` 只进报告和“需要注意”的线索候选（`kind: clue`，是否上卡由模型按 3 条名额取舍）。
- `privacy_scan.mjs` 增加完整 IPv4/IPv6 检测，白名单只放文档保留网段（`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`、`2001:db8::/32`）。

**验收**

| 编号 | 内容 |
| --- | --- |
| A156 | IPv4 脱敏到 /24、IPv6 脱敏到 /48 |
| A157 | 证据包含完整 IP → `invalid-input`，不渲染 |
| A158 | 三个异常标记各有正例与反例，阈值边界（4/5 秒）正确 |
| A159 | 遍历：`form_meta` 任意取值，风险分、等级、置信度不变 |
| A160 | `honeypot_triggered: true` → `automated_submission` 且结论句正确；仅 `fast-submit` → 不触发该类别 |
| A170 | `privacy_scan` 在仓库与精简包里对完整 IP 失败、对文档保留网段通过 |

---

### N-08 使用指南与首次上手引导（P0）

**问题**：用户装完 Skill 后不知道该给什么信息、信息去哪里找、结果怎么看，给的信息也未必有用。核对现状：`README.md` 只有一个“快速开始”示例；`SKILL.md` 没有任何“怎么用/使用指南/帮助”的触发，缺关键信息时只是“问一次”，卡片末尾的补充建议只在查完之后才出现。

**做不到的事**：Skill 只在用户发话后运行，装完那一刻没法主动弹提示，也没有“首次使用”的持久状态可读。所以引导分三层，都不依赖安装时推送：

| 层 | 位置 | 触发 |
| --- | --- | --- |
| ① 上手段 | `README.md` 新增“30 秒上手”（放在“解决什么问题”之前）；`SKILL.md` frontmatter 的 `description` 末尾追加一句“不知道给什么信息？说「使用指南」查看示例” | 用户在市场页或安装前后读到 |
| ② 完整指南 | 用户说求助词时，输出完整指南 | 求助词见下 |
| ③ 短版提示 | 输入里没有任何可用线索（只说“背调”“帮我查个客户”“buyer-check”，或只有一个人名），输出短版提示，**不连环追问** | 空输入 |

**求助词（写入 `SKILL.md` 第 0 步之前新增的“0.0 求助与空输入”）**
- 中文：使用指南、怎么用、如何使用、帮助、示例、有什么功能、能做什么、我该给你什么信息
- 英文：help、guide、how to use、usage、examples、what can you do
- 可用线索 = 公司名、域名、邮箱、带 `+` 国家区号的电话、社媒链接、含具体内容的询盘原文（至少一句）。只有其中**任一项**就直接开始查，不出指南。

**实现：`render_card.py --guide short|full [--lang zh|en]`**
- 输出固定文本（常量写进脚本，Node 对照同步），不读证据包、不联网、不写盘、不读系统时间；默认 `--lang zh`。
- 模型把输出**原样贴出**，不改写、不加评论（与结论卡同一纪律）。用户使用其他语言时，模型按英文版忠实翻译，示例里的虚构公司名、域名、号码保持原样（见 Q9）。
- 现有 `main()` 的证据包位置参数可能是必填，`--guide` 必须能免证据包运行；agent 先确认再改。
- 文本源头放在 `card_template.md` 新增小节“七、使用指南（`--guide` 的固定文本）”，脚本常量与该小节必须一致（A176）。

**行数预算**：短版非空行 ≤12；完整版非空行 ≤40。这不占结论卡的行数预算，也**不得往结论卡里加行或加字**（INV-02、INV-11）：灰色卡等现有卡片的字节保持不变。

**短版文本（中文，agent 按此实现，英文版忠实翻译）**

```text
**BuyerCheck 使用提示**：给我下面任意一项就能开始，信息越多结果越准。
▸ 公司名 + 国家　▸ 邮箱　▸ 带 + 国家区号的电话　▸ 官网域名　▸ 询盘原文或聊天记录
示例：`帮我背调：NORDIC IMPORT AB，瑞典，邮箱 info@nordic-import.example`
示例：`客户 Anna，WhatsApp +44 7700 900123，想订 500 个接线端子`
（示例里的公司、域名、号码都是虚构的，请换成你自己的。）
说「使用指南」可查看完整用法和更多示例。
```

**完整版文本（中文，agent 按此实现，可微调措辞但不得删减小节与示例类型）**

```text
## BuyerCheck 使用指南
**一句话**：把询盘里零散的公司名、邮箱、电话和聊天记录，变成一张带来源的风险判断卡。只做风险信号筛查，不判定对方是不是骗子。

**1. 给我什么信息**（任意一项就能开始，越多越准）
| 档位 | 提供 | 能多查出什么 |
| --- | --- | --- |
| 最少 | 公司名、邮箱、带 + 国家区号的电话、官网域名、聊天记录，任一项 | 对方有没有公开痕迹 |
| 推荐 | 公司名 + 国家 + 邮箱 + 询盘原文 | 邮箱和官网是否对得上、话术是否常见于骗局 |
| 加分 | 询盘来源、官网表单里的提交信息、邮件原始头、收货地址 | 来源与发件是否一致、收货国是否对得上 |
| 订单前 | 营业执照编号、收款账户（IBAN/BIC） | 收款账户所在国与买家国是否一致 |

**2. 这些信息去哪里找**
- 电话：写成 + 开头的完整格式，如 +44…；不带区号我不会猜国家
- 询盘来源：阿里国际站、Facebook、WhatsApp、官网表单、邮件、领英、展会，说一个就行
- 邮件原始头：在邮箱里找「显示原始邮件」或「查看邮件标头」，整段复制给我（菜单名称因邮箱而异）
- 官网表单信息：表单后台那条记录里的提交 IP、来源页、提交耗时；IP 我只保留网段

**3. 示例**（虚构数据，请换成你自己的）
1. 一句话：`帮我背调：NORDIC IMPORT AB，瑞典，邮箱 info@nordic-import.example`
2. 名称加电话：`客户 Anna，WhatsApp +44 7700 900123，想订 500 个接线端子`
3. 贴询盘：`阿里国际站的询盘：We would like to order 2000 pcs, please pay the factory audit fee first.`
4. 快查：`快查：ACME TRADING LTD，acme-trading.example`
5. 批量：`批量快筛：`后面粘贴 2–10 封询盘，用空行隔开
6. 订单前：`订单前复核：客户要求把货款汇到新账户 GB82 WEST 1234 5698 7654 32，买家自称在英国`

**4. 怎么看结果**
- 风险分（0–100）看“有没有危险信号”，核实度看“查到了多少”，两件事分开看
- 「风险 待核实」是信息太少，不是没问题
- “没查到”下面的一行动作：登录一次或过一次验证码，把看到的回传给我，我会更新结果
- 动作阶梯告诉你现在可以做到哪一步：报价、寄样、备货、收款

**5. 隐私与边界**
- 姓名、邮箱、电话默认打码；银行账号只用于本次分析，不写入文件
- 只查商业身份相关的公开信息，不查住址、家庭、私人账号
```

**写作要求**
- 示例里的公司名、域名、号码**全部虚构**：域名用 `.example`；电话用保留号段（`+44 7700 900xxx` 是英国监管机构为影视剧预留的号段，**agent 需核对后再用**，核不了就换成 `privacy_scan` 白名单里已有的号段）；IBAN 沿用 `account_check` 现有测试里的公开样例，不得新增看起来像真实账号的号码。
- “邮件原始头”的菜单名称各邮箱不同，**agent 不得凭记忆写具体菜单路径**；核对过再写，核不了就保持上面的泛指写法。
- 示例 3 的询盘句要体现“可以直接贴原文”，但不要写成真实公司的话术。
- 语气：给业务员看的，短句、不用技术词（遵守 `card_template.md` 的“技术词 → 人话”对照表），不出现 RDAP、DMARC、HS 编码等词。

**README“30 秒上手”**：三步（复制一个示例 → 换成你的信息 → 看结论卡）+ 三个示例（与指南 1–3 号示例**逐字相同**）+ 一句“不知道给什么？说「使用指南」”。不新增文件（INV-08）。

**验收（A171–A178）**

| 编号 | 内容 |
| --- | --- |
| A171 | `--guide short`（zh/en）：非空行 ≤12，含 ≥2 个示例、含“使用指南/guide”提示 |
| A172 | `--guide full`（zh/en）：非空行 ≤40，含五个小节标题与四档信息表 |
| A173 | 示例自检：从指南取出示例电话，`phone_check` 解析出英国；示例 IBAN 通过 `account_check` 的 mod-97；所有示例域名以 `.example` 结尾 |
| A174 | 指南文本无禁用词、无技术词、无真实数据；`privacy_scan` 通过（示例号码与 IBAN 在白名单内） |
| A175 | Python 与 Node 的 `--guide` 输出逐字节一致（含 `--lang`） |
| A176 | `card_template.md` 的指南文本与 `--guide` 输出一致；README“30 秒上手”的 3 个示例与指南 1–3 号示例逐字相同（并入 `tests/consistency.mjs` 模板回归） |
| A177 | `SKILL.md` 含求助词表、空输入规则（不连环追问）、“指南原样输出”规则（模板回归）；`description` 总长 ≤1024 字符且保留原有触发词 |
| A178 | `--guide` 不读证据包、不联网、不写盘；结论卡与旧证据包渲染字节不变（INV-02 快照） |

**人工走查（写进 `docs/p08-report-v0.11.0.md`，不进 CI）**：审核 agent 用下面 6 个“小白输入”各走一遍，记录实际输出。期望：前 3 个出现指南且不连环追问；后 3 个直接开始查。

| 输入 | 期望 |
| --- | --- |
| `背调` | 短版提示 |
| `帮我查一下这个客户` | 短版提示 |
| `怎么用` | 完整指南 |
| `Anna，+44 7700 900123` | 直接开始查（名称+电话起手流程），不出指南 |
| `info@nordic-import.example` | 直接开始查 |
| `help` | 英文完整指南 |

---

### N-07 独立渠道验证动作与视频核验话术（P1）

**问题**：现在“用官网公示的电话或邮箱确认此人”只是一句建议，没有对应的卡片动作；回拨话术只在订单前出现。

**改动**
1. `coverage.uncovered[].reason` 新增 `unverified-contact`：官网已找到，官网公示的电话或邮箱与对方提供的不同，且“买家与公司的关联”维度未核实时由模型写入。
2. `data-sources/global.md` 第十一节“一次动作链接模板”加一行：

| 原因 | 卡片项目 | 链接 | 做什么、回传什么 |
| --- | --- | --- | --- |
| `unverified-contact` | 独立确认 | 官网联系页链接 | 用官网公示的电话或邮箱（不是对方给的）联系一次，确认此人在职、询盘出自他；回传：对方是否确认 |

3. `render_card.py` 接受新 reason；一次动作排序：地图、注册库、**独立确认**、领英和 Facebook；仍 ≤4 行。
4. 话术库新增一条（仅在 `inquiry_type` 为 `large_first_order`/`pre_order`，或等级 ≥中时出现）：
   - EN: `Would a short video call with our sales team work for you? It would help us prepare the right quotation for your project.`
   - ZH: `能否安排一次简短的视频沟通？这样我们可以为您的项目准备更合适的报价。`
5. 完整报告新增“视频核验建议”小节（不上卡片）：请对方从官网公示邮箱发会议邀请；请对方在镜头前展示办公场所或门牌；问一个只有内部人才知道的业务细节。**必须写明：视频不是身份证据，只是增加冒充成本；本 Skill 不做深度伪造检测。**

**验收**

| 编号 | 内容 |
| --- | --- |
| A168 | `unverified-contact` 的行格式、排序、≤4 行，旧证据包字节不变 |
| A169 | 视频话术英文+中文齐全、无禁用词、只在指定条件下出现 |

---

### N-06 收货信息与目的地提示（P1）

**新增 `intake.ship_to`（可选）**：`country`（ISO2）、`consignee_name`、`forwarder_name`、`incoterm`。询盘里没有就 `null`，不追问。

**脚本只做三类判断，都不计分**
1. 收货国 ≠ 买家自称国 → 线索“收货国与买家国不同”（项目采购、转口都可能，需要问用途）。
2. `forwarder_name` 为对方指定 → 沿用 RF-PAY-002 的既有判定，不新增逻辑，只在报告里列出。
3. `ship_to.country` 命中 `country_capabilities.json` 的 `risk_background`（见下）→ 背景提示：“目的国存在制裁或禁运项目，发货前请先做出口合规自查”。

**`risk_background` 数据**
- 在 `scripts/country_capabilities.json` 每个国家条目下加可选字段 `risk_background`：`{ "programs": [...], "source_url": "...", "verified_at": "YYYY-MM-DD" }`，未核实一律 `null`，**`null` 时不输出任何提示**。
- 数据来源只能是官方制裁项目页面（如 OFAC 制裁项目列表、欧盟与联合国的禁运页面）；**agent 必须打开页面核对后再填，本文不提供未核实的国家名单**。
- 这是 `CR-GEO-001`（背景风险提示）的落地：只作提示，不计分，不使用“高风险国家”这类整体性标签，只写具体项目名称。

**报告**：新增“出口合规自查提示”小节，列出：目的国、最终用户、用途、产品是否属于管制物项，并固定声明“以中国及目的国主管部门规定为准；本 Skill 不判定是否适用，不构成法律意见”。

**验收**

| 编号 | 内容 |
| --- | --- |
| A165 | 收货国与买家国不同 → 线索，风险分不变 |
| A166 | `ship_to.country` 命中 `risk_background` 时显示背景提示，写明项目名与来源 |
| A167 | `risk_background` 为 `null` 或缺失 → 不输出任何提示；旧证据包字节不变 |

---

### N-05 制裁名单扩展 EU/UN/UK（P1，需 Q3 确认）

**现状**：`sanctions_check.py` 只有 OFAC 下载地址，EU/UN/UK 只有文件名占位。

**要求**
1. 开发 agent **自己打开**欧盟综合制裁名单、联合国安理会综合名单、英国 OFSI 综合名单的官方发布页，记录：官方页面网址、下载格式（CSV 或 XML）、是否免登录、是否有访问令牌、更新频率、体积、使用许可。**记录写进 `docs/validation.md` 新增的“制裁源实测”小节，格式参照该文件第 5 节（OFAC 实测）。**
2. 逐个源判断是否可配置：免登录、官方发布、许可允许缓存使用，才配置；否则保持 `not_configured` 并写明原因，**不要为了凑数硬上**。
3. 只用标准库解析（XML 用 `xml.etree`），不引入第三方依赖；沿用现有下载纪律：每个源 20 秒超时、行数或节点数下限校验、`invalid-content` 保留旧缓存、`all-urls-failed` 不崩溃。
4. 匹配沿用现有规则：同名一律 `requires_manual_review`。
5. 卡片的“已查”表述随配置源变化（如“已查 OFAC、UN”）；`data_as_of` 按源分别记录，超过 7 天的源写入 `checks_incomplete` 的 `stale`。覆盖分母仍为 8。
6. 本地缓存目录 `.cache/sanctions/` 继续被 `.gitignore` 忽略。

**验收**

| 编号 | 内容 |
| --- | --- |
| A163 | 每个已配置的源有一份离线夹具，命中与未命中各一例；未配置的源返回 `not_configured`，不抛异常 |
| A164 | 下载失败、内容非法、全部地址失败三种情形与 OFAC 现有行为一致（保留旧缓存） |

---

## 6. 精简包预算（INV-08）

`submission.manifest.json` 当前 26 + 2 = 28，满额。本版**不新增任何进包文件**，改动落点如下：

| 内容 | 落点（均为既有文件） |
| --- | --- |
| `lead_class`、信号表、固定结论句、`form_meta` 脱敏与异常标记 | `scripts/render_card.py`（Node 对照 `render_card.mjs` 在仓库内） |
| 类别规则、schema、版式说明 | `card_template.md`、`SKILL.md`、`report_template.md` |
| 渠道起手表、独立确认链接模板 | `data-sources/global.md`（进包时合并入 `data_sources.md`） |
| 制裁多源 | `scripts/sanctions_check.py` |
| `risk_background` | `scripts/country_capabilities.json` |
| 评测语料 | `tests/eval/inquiries.jsonl` |
| 使用指南文本与 `--guide` | `scripts/render_card.py`（Node 对照在仓库内）、`card_template.md` 新增第七节、`SKILL.md` 新增“0.0 求助与空输入”、`README.md` 新增“30 秒上手” |
| 新验收用例 | `tests/cases/A141–A178.json`（构建时合并为 `tests/cases.json`） |

- `ip_check` 仍只在仓库内；精简包用户通过 `form_meta.ip_origin` 手动粘贴结果。
- `render_card.py` 已经很长，**本版不重构**，只追加；如果追加后可读性明显下降，在报告里记录，留给下一版。
- 构建后必须检查：文件数 ≤28、体积 ≤40MB、`node scripts/build_submission.mjs` 与精简包内测试通过。

---

## 7. 测试与验收总览

**统计**：新增验收用例 A141–A178（共 38 个；A141–A152 属 N-01，A153–A155 属 N-02，A156–A160/A170 属 N-03，A161–A162 属 N-04，A163–A164 属 N-05，A165–A167 属 N-06，A168–A169 属 N-07，A171–A178 属 N-08）；评测语料 E046–E085（40 条）。验收用例总数 A1–A178，评测语料总数 85 条。

**必跑命令**（全部通过才可合并）

```bash
node tests/run_cases.mjs
node tests/consistency.mjs
node tests/consistency_scripts.mjs
node tests/ip_check_cases.mjs
node tests/phone_check_enrich_cases.mjs
node tests/account_check_cases.mjs
node tests/check_sources_cases.mjs
node tests/eval/score_eval.mjs --self
node scripts/privacy_scan.mjs
node scripts/build_submission.mjs
(cd dist/submission && node tests/run_cases.mjs)
node scripts/privacy_scan.mjs dist/submission
```

**全局回归（每个任务都要验证）**
1. 旧证据包快照字节一致（INV-02）。
2. 风险分、等级、置信度不变（INV-01、INV-03；`tests/consistency.mjs` 现有的分数区间遍历或抽样继续通过，agent 先确认它现在遍历的范围，再决定新增用例的遍历方式）。
3. Python/Node 输出一致（INV-09）。
4. 卡片行数预算（INV-11）。
5. 隐私扫描通过，且新增合成数据里没有真实客户信息。

---

## 8. 文档对账（D 系列，随版本一起做）

| 编号 | 内容 | 注意 |
| --- | --- | --- |
| D-01 | `red_flags.md`：把 v0.10.0 的 8 条红旗并入总表（31 行），并在“三、判定细则”补齐它们的 命中/不命中/证据要求 | 以 `render_card.py` 的实际派生条件和 A68–A135 为准：匹配门通过、官方来源、主体为公司、角色为 `accused`/`regulator_action`、时间窗内、`evidence_ids` 真实。**与代码矛盾时不改代码，先问负责人** |
| D-02 | `RF-ID-004/005` 编号：按 Q5 的答复统一文档，删去“若发布前负责人决定…”的悬置句 | 推荐保持现编号 |
| D-03 | 新增 `docs/iteration_plan_v0.10.md`，**只复述** CHANGELOG 0.10.0/0.10.1 与代码里能核实的事实，文首注明“根据 CHANGELOG 与代码事后整理”，**不得编造当时的决策** | |
| D-04 | `CHANGELOG.md` 顶部迭代方案链接补上 v0.10、v0.11；`docs/development.md` 第八节路线图改为指向本文 | |
| D-05 | `docs/validation.md` 升到 v0.11，补 v0.10 场景摘要（A68–A140）与 N-04d 的指标 | |
| D-06 | 同步数字：`README.md`、`SKILL.md`（frontmatter、文件清单、测试范围）里的版本号 0.11.0、用例范围 A1–A178、评测条数 85；`tests/consistency.mjs` 里与文档数字相关的断言同步 | |
| D-07 | `submission.manifest.json`：`version` 改 0.11.0，`rewrites` 里含 `A1–A140`、`45 条合成询盘` 等整段文字的 `from`/`to` 同步更新 | **不改会导致精简包口径错误**，见第 1 节 |

---

## 9. 候选清单（不在 v0.11.0，写入 CHANGELOG 的“计划中”）

| 编号 | 内容 | 前置条件 |
| --- | --- | --- |
| N-09 | 本地历史去重：只存邮箱域、电话、话术指纹的加盐哈希，默认关闭，存在用户本机，可一键清空；命中只提示“此前出现过”，不计分 | 需要先和“不收集用户数据”的边界对齐（Q4）；写盘不能放进 `render_card.py`，应放在 `identity_check.py` 的子命令 |
| N-10 | 发货前一致性清单：收货人、收货地址、货代、付款账户与买方主体比对；`stage: pre-shipment`；复用 `--diff` | 依赖 N-06 的 `ship_to` |
| N-11 | 询盘中链接域名接入 `domain_similarity`/`whois_lookup`（只比对域名，不访问）；短链展开清单 | 依赖 N-01 的 `contains_login_or_download_link` |
| N-12 | 国家扩展：英国、土耳其、埃及、尼日利亚、巴基斯坦（优先中东与东南亚试点之外的高频询盘国） | 每国都要打开官方页面核对，核不了就 `secondary-source`/`unverified`，不猜 |
| N-13 | 商业可行性：可选的卖方设置（起订量、最低订单额），与询盘数量对比，只作线索 | 需要先定义设置的存放位置与隐私边界 |

---

## 10. 待负责人确认的问题

| 编号 | 问题 | 推荐默认 |
| --- | --- | --- |
| Q1 | `lead_class` 是否放在结论行显示（不新增行）？类别标签用文中的中文还是更口语的叫法？ | 放在结论行；用文中标签 |
| Q2 | `fast-submit`（<5 秒）、`direct-no-browse` 阈值是否先作为初始值上线，等有 ≥50 条脱敏真实数据后再校准？ | 是；只有 `honeypot` 触发类别 |
| Q3 | 是否允许下载 EU/UN/UK 官方名单（涉及许可、体积、令牌）？核对后不满足的源是否接受保持 `not_configured`？ | 允许；不满足就不配置 |
| Q4 | 本地历史去重（N-09）是否做、何时做？ | 本版不做，v0.12 再议 |
| Q5 | `RF-ID-004/005` 编号是否保持现状？ | 保持，文档对齐代码 |
| Q6 | 比赛提交截止日（11-16）已过；v0.11 是否仍需进入 28 文件精简包，主办方是否允许更新提交？ | 先按 28 文件做，是否提交以主办方回复为准（我没有这部分依据） |
| Q7 | `phishing_like` 的固定结论句不出现“钓鱼”字样，只说“先不要打开”，是否接受？ | 接受（减少对真实买家的冒犯） |
| Q8 | 第 9 节候选的优先顺序是否需要调整？ | 保持现状 |
| Q9 | 使用指南只做中文和英文两版，其他语言由模型按英文版忠实翻译、示例保持原样，是否接受？你的用户主要使用哪些语言？ | 接受；先中英两版，按实际用户语言再补 |
| Q10 | `SKILL.md` 的 `description` 末尾追加一句使用提示，是否接受？（描述是市场页上用户最先看到的文字；总长需 ≤1024 字符，agent 开工前确认目标平台的限制） | 接受 |

---

## 11. 审核 agent 验收清单

**范围与不变量**
- [ ] 红旗仍为 31 条，编号与权重未变；`scripts/red_flags.json` 与 `red_flags.md` 一致
- [ ] 风险分公式、分档、覆盖分母 8、R1–R5 未改动
- [ ] 所有新增字段可选；旧证据包渲染字节一致
- [ ] 新增分类、信号、表单元数据、渠道、收货信息均未改变风险分、等级、置信度

**功能**
- [ ] 模型只填枚举信号，类别与结论句由脚本固定模板生成
- [ ] 单个弱信号不会把真实小买家分到非目标类
- [ ] 真实买家常见附件（PDF/DOCX/ZIP）不触发“需登录或下载内容”
- [ ] `channel` 不改变卡片任何字节
- [ ] 完整 IP 不出现在证据包、卡片、报告、测试数据里（保留网段除外）
- [ ] 制裁源只配置了经官方页面核对的源；未配置的源如实标 `not_configured`
- [ ] `risk_background` 未核实时为 `null` 且不输出提示

**边界**
- [ ] 没有使用账号枚举、邮箱泄露库、人脸识别、追踪链接
- [ ] 没有自动登录、绕验证码、批量抓取
- [ ] 卡片与报告没有“骗子、诈骗犯、竞争对手”等定性字眼
- [ ] 视频核验被写成“增加冒充成本”，没有声称能检测深度伪造
- [ ] 使用指南：短版 ≤12 行、完整版 ≤40 行；示例全部虚构（`.example` 域名、保留号段、已有测试里的公开 IBAN 样例）
- [ ] 求助词和空输入能触发指南且不连环追问；有任一可用线索时直接开始查，不出指南
- [ ] 结论卡与旧证据包字节不变，没有往卡片里加行或加字；指南文本、`card_template.md`、README 示例三处一致
- [ ] 6 个“小白输入”人工走查已记录在 `docs/p08-report-v0.11.0.md`
- [ ] 出口合规部分只给“需自查”，没有判定适用性

**工程**
- [ ] 精简包 ≤28 文件、≤40MB，无新增必需依赖
- [ ] `manifest.rewrites` 与 `SKILL.md`/`README.md` 的文字同步，构建无警告
- [ ] 第 7 节全部命令通过，包内测试与包内隐私扫描通过
- [ ] 每个任务有 `docs/p<编号>-report-v0.11.0.md`
- [ ] D-01…D-07 完成，文档数字（版本、用例范围、评测条数、红旗数）一致
- [ ] 没有改写 git 历史、没有强推

---

## 12. 风险与已知局限

- **信号抽取由模型完成，不是确定性的**：确定的只是“信号→类别”的映射。为降低波动，信号是枚举、每个信号要在报告里附原文引用，并用 N-04 的评测衡量。
- **分类可能误伤真实买家**：真实买家也会发简短询盘、发链接。对策是“单个弱信号不分类”“措辞只做建议、不下结论”，以及 N-04 里的真实小买家反例。误判后果被限制为“只发标准目录”或“先确认再打开”，代价低。
- **指南只能“被动出现”**：Skill 无法在安装时主动提示，也没有“首次使用”的状态。用户如果既不读 README 也不说求助词，仍可能一头雾水，所以才有“空输入自动出短版”这一层；它不能覆盖“给了线索但线索没用”的情况，那部分仍靠卡片里的“补充建议”。
- **指南会过时**：新增字段（渠道、表单信息、收货地址）后，指南、`card_template.md`、README 三处要同步，A176 就是为防漂移准备的。
- **表单阈值是初始值**：见 Q2，没有真实数据支撑前不要据此扣分或拦截。
- **制裁名单覆盖不完整不等于没风险**：只配置部分源时，卡片要如实写“已查哪些”，不能写成“已排除制裁风险”。
- **本文没有核实的内容**：EU/UN/UK 名单的下载地址与许可、各国制裁项目名称、任何出口管制规定，都需要 agent 打开官方页面核对后再写入；核对不了就留 `null`。
