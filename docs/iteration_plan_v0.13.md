# BuyerCheck 迭代规划 v0.13.0（第八版）：跟进分级与实战手法对齐

> 面向开发 agent 与审核 agent 的执行文档。基线：`origin/main` 提交 `8ec0941`，版本 v0.12.0。
> 起草日期：2026-11-23。状态：**部分完成（P0/P1 已实现并通过 A1–A299；K-08 真实名单实测已完成；两轮真实询盘验收已完成（均 ⚪ 需人工核实、0 红旗）；K-09 阈值校准与 p08 走查仍需 ≥50 条真实询盘与真实业务员，`render_card.py` 分区整理已完成；K-10 已核对 CSL 与 Made-in-China 标识名，其余条款页 404/403 保持待核实）**；第 10 节 Q4–Q7 按“推荐默认”实现，待负责人确认；合并/打标签待负责人授权。
> 本版来源：负责人提供的《外贸买家背调实战指南》（Gemini 对话截图 PDF，下称“实战指南”）与 v0.12.0 仓库的逐项对照，加上 v0.12.0 各任务报告里的遗留项。
> 起草时我在最新代码上运行了 `node tests/run_cases.mjs`（243/243 通过）、`node tests/consistency.mjs`（通过）、`node tests/eval/score_eval.mjs --self`（通过）。其余结论来自读代码和 grep。
> 实战指南是 AI 生成的经验文，其中有几处我认为不准确或与本仓库边界冲突，已在第 2.2 节列为“不采纳”，开发 agent 不要照搬。

---

## 0. 给 agent 的使用说明

1. 先读本文第 1–3 节，再读 `SKILL.md`、`red_flags.md`、`card_template.md`、`report_template.md`、`submission.manifest.json`，最后读你负责的任务。
2. **一个任务一个分支**，分支名 `feat/v0.13-<任务编号>`（修缺陷用 `fix/v0.13-<任务编号>`）；提交信息用英文 Conventional Commits，scope 用模块名。
3. 不得改写 git 历史，不得强推 `main`。
4. 遇到第 10 节的问题，**先停下问负责人**，不要自己选；未答复时按“推荐默认”实现且不合并。
5. 精简包放不下（超过 28 个文件，或需要新增进包文件）时，**先问负责人再取舍**。
6. 查不到的信息写 `null`，不猜测。本文没有核实过的网址、地区习惯、字段名、阈值，都标了“**待核实**”，必须自己打开官方页面核对后才能写进仓库，并把核对结果写进 `docs/validation.md`。
7. 每个任务完成后写 `docs/<任务编号>-report-v0.13.0.md`（格式参照 `docs/pS-01-report-v0.12.0.md`）：做了什么、改了哪些文件、新增哪些用例、遗留问题。
8. 代码行为与文档矛盾时，**不要改代码去迁就文档**，先记入报告并问负责人。
9. 本仓库公开，所有新增样例、夹具、评测语料必须是**合成数据**：公司名虚构，域名用 `.example`，电话用保留号段。
10. **真实询盘、真实名单、真实走查记录不得进入仓库**；需要用真实数据做校准的任务（K-09），数据只放本地 `reports/` 且已脱敏，并写入 `.gitignore`。

---

## 1. 基线（已核实的事实）

| 项目 | 现状 | 依据 |
| --- | --- | --- |
| 版本 | 0.12.0（`origin/main` `8ec0941`） | `CHANGELOG.md`、`submission.manifest.json` |
| 测试 | 验收用例 A1–A243 全部通过；评测集 115 条；Python/Node 一致性通过 | 起草时我实际运行 |
| 精简包 | 26 个复制文件 + 2 个合并产物 = 28，满额；`render_card.py`、`phone_check.py`、`sanctions_check.py`、`identity_check.py`、`country_capabilities.json` 在包内；`render_card.mjs`、`phone_check.mjs`、`sanctions_check.mjs` 不在包内，只用于对照测试 | `submission.manifest.json` |
| 文件规模 | `render_card.py` 2754 行，`render_card.mjs` 2559 行，`identity_check.py` 1242 行 | `wc -l` |
| 询盘分类 | `lead_class` 共 8 类：`automated_submission phishing_like vendor_solicitation competitor_probe individual_research target_end_user reseller unclear`；类别以“· 类别：xxx”后缀出现在标题附近，`unclear` 时不显示；信号分弱信号集与 `LEAD_CONCRETE_SIGNALS`（`names_product_model states_quantity states_end_use_project states_target_market`） | `render_card.py:365-385`、`2159-2160` |
| 跟进投入等级 | **没有**。仓库回答“这是什么询盘”和“风险多高”，没有回答“该投入多少时间”。实战指南和 v0.12 手册都有 A/B/C/D | grep |
| 号码国不一致 | `RF-CORP-005`（权重 2）：号码国家区号与自称所在国不一致即命中，**没有转口枢纽例外**；红旗 ID 由证据包 `red_flags` 提供，`render_card.py:594 flag_ids_of` 汇集；`CONTACT_CONTRA`（325 行）含 `RF-CORP-005`，会影响“联系方式”维度状态 | 读代码 |
| 红旗判定细则 | `RF-CORP-001`：官网国、电话区号、注册地址、发件 IP 归属地中**至少 2 个独立字段**互相对不上才命中 | `red_flags.md:109-110` |
| 域名年龄 | `RF-DOM-002`：官网域名注册不足 **6 个月**（实战指南用 3 个月/3 年，不采纳，见 2.2） | `red_flags.md:96-97` |
| 号码脚本 | `phone_check.py` 已输出国家、`line_type`、`matches_claimed_country`；**没有**“去区号后的搜索变体”，指引里没有“固话可直接搜地址”这一步 | 读代码、grep |
| 即时通讯指引 | 有 WhatsApp 商业资料采集；**没有** Viber、Zalo、Line、KakaoTalk 等按地区选择的说明；没有 Truecaller 一类反查的说明 | grep |
| 海关指引 | `data-sources/global.md` 第六节：多平台、免费优先、看品类/角色/频次；**没有**单次出货规模（整柜/拼箱）、核心 HS 编码、现有供应商来源国（是否已从中国采购） | grep |
| 首封回复转化 | v0.12 有 `buyer_type`，用于报告“报价与跟进建议”措辞；**没有**“区域适配该问什么”（目的港、标准、贸易术语、包装标签等）的清单 | grep |
| 官网与人物 | 有官网真实性、About/Products/Contact、LinkedIn 现任职位是否在采购岗（`SKILL.md` T3）；**没有**“新闻/博客最后更新时间”“案例页/品牌页”“职位层级”“近期跳槽” | grep |
| 附件属性 | `docmeta` 只读 PDF Info，不存作者，只写“未见矛盾/存在可解释的差异”（`RF-DOC-001`，权重 1） | `SKILL.md`、`red_flags.md` |
| 批量快筛 | `render_card --batch`（2–10 封，表 ≤12 行） | `SKILL.md:171` |
| 使用指南 | `--guide short|full`，短版非空行 6、完整版 29，由 A171–A178 约束 | `render_card.py:391-475` |

**v0.12.0 遗留项（来自各任务报告）**

| 来源 | 遗留 |
| --- | --- |
| F-01 | DNS 在校验与连接之间被改写（TOCTOU）未防；没有跨重定向的总时限；`unsafe_url` 未接入地图/注册库命令的返回；完整 `safe_open`/`safeFetch` 流程缺可注入 opener/fetch 的夹具；Node `safeFetch` 读完 `arrayBuffer` 再判 2 MiB，不是流式中止 |
| S-02 | 真实 UK 名单约 50MB，测试只用合成夹具；误报测量只用合成夹具，没用 ≥5000 行随机名单；Node 版按行解析 CSV，真实文件里带换行的引号字段可能被截断（Python 版正常）；每次查询的耗时没测 |
| H-01 | 阈值没校准；p08“装好后第一次使用”走查没做；`render_card.py` 没整理 |
| C-01、G-01 | Made-in-China 会员字段、GLEIF/VIES/EDGAR/CSL/Companies House 使用条款仍“待核实” |
| R-01 | 候选仍由模型/`identity_check` 提供，同名同国不同登记号的真实消歧需真实数据校准 |
| B-01 | 自然人姓名识别是启发式（2–4 个字母词 + 无法人后缀） |

**两个会让开发 agent 踩坑的构建细节（沿用）**

- 改 `SKILL.md`/`README.md` 里的任何数字，必须同步改 `submission.manifest.json` 的 `rewrites`。
- `render_card.py` 约定“不联网、不写盘、不读系统时间”。

---

## 2. 版本目标与边界

### 2.1 目标

v0.12 让筛查更可靠。本版让结果**更好用**，并把实战指南里仓库还缺的手法补齐：

- **G1 跟进分级**：把现有输出收敛成 A/B/C/D 四档投入建议，回答“这条线索值多少时间”。
- **G2 减少误杀**：对转口枢纽国家的号码不一致，降为只提示。
- **G3 成果转化**：首封回复该问什么、该切哪个角度；海关画像里加“现有供应商来源”。
- **G4 线索手法补齐**：号码搜索变体与固话、即时通讯地区表、官网活跃度、人物层级。
- **G5 收口**：v0.12 的抓取安全残余、名单解析与性能、校准与走查。

### 2.2 本版不做 / 不采纳

- **不新增红旗，不改任何权重**（INV-01）。**唯一的触发条件改动**是 K-02 的转口枢纽例外，已获负责人同意。
- **不在卡片上加数字分**。A/B/C/D 是字母档位，由已有输出规则推出，不是第三个分数。
- **不做逐国电压/认证/目的港数据**（负责人决定，见 2.3）：只做通用“该问什么”清单。
- 不采纳实战指南的以下做法：
  - 把邮箱贴进 Facebook、Skype、PayPal、Google 联系人试探是否存在：属于按邮箱枚举账号，违反 v0.11 定下的边界（INV-10）。
  - Hunter、Snov、Apollo 一类抓取同事邮箱的工具：涉及个人信息抓取与条款风险。
  - 域名年龄用“3 个月 / 3 年”：保持 `RF-DOM-002` 的 6 个月口径，不改。
  - “日韩泰常用 Line”：韩国主流通讯软件我印象是 KakaoTalk，**待核实**后才写进指引，不照搬。
  - Truecaller“命中率极高”的说法：未经核实，只作为人工线索写入，并附隐私与登录提示。
- 不做主动弹出提示、不做 HTML 卡片、不引入付费接口、不绕过验证码与登录。
- 不判定出口管制，不构成法律意见。

### 2.3 负责人已确认的决定（2026-11-23）

| 问题 | 决定 |
| --- | --- |
| A/B/C/D 跟进分级做不做 | **做**。只由现有输出规则推出，不加数字分 |
| 转口枢纽例外怎么处理 | **按建议做**：号码国属于枢纽国（阿联酋、土耳其、新加坡、香港）且与自称所在国不同时，`RF-CORP-005` 降为只提示、不计分，并给一句委婉追问；权重和编号不变 |
| 区域适配（电压、认证、目的港） | **只做通用“该问什么”清单**，不做逐国数据 |

---

## 3. 不变量（任何任务不得违反）

| 编号 | 不变量 |
| --- | --- |
| INV-01 | 风险分公式、分档（0–29/30–59/60–100）、31 条红旗编号与权重、覆盖分母 8、置信度规则 R1–R5 不变。**例外**：K-02 允许改变 `RF-CORP-005` 的不命中条件 |
| INV-02 | 所有新增字段**可选**；旧证据包渲染结果与 v0.12.0 **字节一致**。**仅有的例外**：K-01（卡片带“类别”后缀的，新增“跟进”后缀）与 K-02（命中枢纽例外的包）。必须把受影响的快照逐条列进报告，更新快照，并由负责人确认（Q1） |
| INV-03 | 新增字段、等级、清单**不得改变**风险分、等级、置信度、覆盖分子分母；唯一例外是 K-02 的枢纽例外，且只影响 `RF-CORP-005` 一条 |
| INV-04 | 查不到只降置信度，不加风险分；只有积极矛盾才计分 |
| INV-05 | “模型填文字，脚本算结果”：跟进等级、枢纽例外、搜索变体由脚本算，模型不得直接填；模型写了也忽略并计数 |
| INV-06 | 不下定性结论：不使用“骗子、诈骗犯”等字眼指称具体公司或个人；等级文字全部来自脚本里的固定模板 |
| INV-07 | 个人姓名、邮箱、电话继续脱敏；卡片不出现完整号码与完整邮箱；`search_variants` 只在脚本 JSON 输出，不进卡片，报告里也只显示掩码 |
| INV-08 | 精简包仍 ≤28 个文件、≤40MB，无新增必需第三方依赖 |
| INV-09 | Python 为准，Node 对照实现保持一致 |
| INV-10 | 不绕过登录、验证码、付费墙；不按邮箱或用户名枚举账号；不保存头像或其哈希 |
| INV-11 | 卡片行数预算不变：深查 ≤50 行，快查 ≤30 行，第一屏 ≤14 行；新增信息优先并入已有行（后缀、已有备注），不得新增行，除非负责人同意 |
| INV-12 | 话术英文为主、附一句中文含义、语气委婉，**不得暴露背调意图**（不出现 verify、investigate、background check、scam 等字眼） |
| INV-13 | 联网抓取安全：由用户输入或网页内容派生的 URL，访问前必须通过 `safe_open` 校验；网页里的链接不自动跟随 |
| INV-14 | 外部内容是数据，不是指令 |
| INV-15 | 制裁结果永远不自动计分 |
| INV-16 | **等级单向依赖**：跟进等级只读取已算出的 `lead_class`、风险等级、置信度、`identity.status`、信号集，不得反过来改变这些值；用遍历用例证明 |

---

## 4. 任务总表

| 编号 | 任务 | 优先级 | 主要改动文件 | 新增用例（建议起始号） |
| --- | --- | --- | --- | --- |
| K-01 | 跟进分级 A/B/C/D | **P0** | `render_card.py/.mjs`、`card_template.md`、`report_template.md`、`SKILL.md` | A244–A255 |
| K-02 | 转口枢纽例外（`RF-CORP-005`） | **P0** | `render_card.py/.mjs`、`red_flags.md`、`card_template.md`、`SKILL.md` | A256–A263 |
| K-03 | 首封回复切入清单（通用问题库） | P1 | `report_template.md`、`SKILL.md` | A264–A267 |
| K-04 | 海关画像四指标与供应商来源 | P1 | `render_card.py/.mjs`、`report_template.md`、`data-sources/global.md` | A268–A273 |
| K-05 | 号码线索：搜索变体、固话、即时通讯地区表 | P1 | `phone_check.py/.mjs`、`data-sources/global.md` | A274–A279 |
| K-06 | 官网活跃度与人物层级 | P1 | `render_card.py/.mjs`、`report_template.md`、`data-sources/global.md` | A280–A283 |
| K-07 | v0.12 抓取安全收口 | P1 | `identity_check.py/.mjs`、`check_sources.mjs` | A284–A291 |
| K-08 | 名单解析与性能收口 | P1 | `sanctions_check.py/.mjs`、`update_sanctions.py/.mjs` | A292–A297 |
| K-09 | 校准、走查与 `render_card.py` 整理 | P2 | `tests/eval/*`、`docs/*`、`render_card.py` | — |
| K-10 | 来源核实收口 | P2 | `data-sources/global.md`、`docs/validation.md` | A298–A299 |
| K-11 | 业务员 5 分钟清单 | P2 | `README.md` | — |
| E-02 | 评测补充（跟进等级、枢纽、新字段） | P0 | `tests/eval/*` | E116–E135 |
| D-01…D-06 | 文档对账与发布 | P0 | 见第 8 节 | 沿用 `consistency.mjs` |

**建议执行顺序**：E-02（先写评测期望）→ K-01 → K-02 → K-05 → K-04 → K-06 → K-03 → K-07 → K-08 → K-10 → K-09 → K-11 → D 系列 → 发布。K-01 与 K-02 都动 `render_card`，按此顺序合并；K-03 引用 K-01 的 B 档措辞与 `buyer_type`，排在它们之后。

---

## 5. 任务规格

### K-01 跟进分级 A/B/C/D（P0）

**目的**：实战指南的核心是“5 分钟初筛，再按等级决定投入”。仓库有 `lead_class`（是什么询盘）和风险等级（风险多高），业务员还得自己把两者换算成“该不该花 20 分钟深查、该怎么回”。本任务把这个换算固定下来。

**输入（全部是已算出的值，INV-16）**：`lead_class`、风险等级（低/中/高/需人工核实）、置信度、`identity.status`（R-01，可空）、`lead_signals` 集合。

**规则（从上到下，第一条命中即停）**

| 等级 | 条件 | 含义（固定文字，见下） |
| --- | --- | --- |
| **D** | `lead_class` 为 `automated_submission` 或 `phishing_like`；**或**风险等级为“高” | 暂不投入 |
| **C** | `lead_class` 为 `vendor_solicitation`、`competitor_probe`、`individual_research` | 低优先级，标准回复 |
| **A** | `lead_class` 为 `target_end_user` 或 `reseller`，**且**风险等级为“低”，**且**信号里至少有 1 个 `LEAD_CONCRETE_SIGNALS`，**且**（置信度为“高”**或** `identity.status` 为 `resolved`/`probable`） | 高潜力，值得深查 |
| **B** | 以上都不满足（含 `unclear`、风险“中”、“需人工核实”、身份未解析） | 信息模糊，边聊边探 |

- `identity.status` 缺失（旧证据包）时，A 的最后一个条件只看置信度。
- **置信度“高”的取值名称以仓库现有为准**，agent 先读 `SKILL.md` R1–R5 写出映射再实现。

**固定文字（脚本模板，`LEAD_GRADE_ADVICE`；agent 可润色，语义不变，但必须符合 INV-06、INV-12）**

| 等级 | 一句话建议 |
| --- | --- |
| A | 高潜力：建议投入深查，并按对方角色定制首封回复。（时间预算建议值“约 20–30 分钟”来自实战指南，写进报告而不写进卡片，见 Q3） |
| B | 信息还不够：先边聊边了解，用轻量问题补信息，暂不做深度背调。 |
| C | 低优先级：用标准模板礼貌回复，不投入深查。 |
| D（依据为类别） | 这条提交需要谨慎：先不回复，也不要打开其中的链接或附件。 |
| D（依据为风险） | 风险较高：先暂缓投入，通过独立渠道确认疑点后再决定。 |

**显示**
- **卡片**：并入已有的“· 类别：xxx”后缀所在行，追加“· 跟进：A”（只显示字母）。完整一句话建议放进该行下已有的结论句位置：当 `lead_class` 结论句被用作判断行时，沿用其逻辑，不新增行（INV-11）。
- 只有卡片**已显示类别后缀**（`lead_class_source == "signals"` 且类别不是 `unclear`）时才显示等级。`unclear` 的卡片、没有 `lead_signals` 的旧证据包，**卡片不变**；等级仍写入 `--json` 的 `computed.follow_up_grade`。这样 INV-02 的受影响面最小。**是否对 `unclear` 也显示等级**见 Q1。
- **完整报告**：新增小节“跟进等级与依据”，列出等级、命中的条件（`follow_up_grade_basis[]`）、固定建议句、建议投入时间。
- **`--json`**：`computed.follow_up_grade`（`A|B|C|D`）、`follow_up_grade_basis[]`（如 `["lead_class:target_end_user","risk:低","concrete_signal:names_product_model","confidence:高"]`）。
- **批量快筛** `--batch` 的表增加“等级”列；表行数预算不变（≤12 行），列宽以不换行为准。
- 模型若在证据包里自填 `follow_up_grade`：忽略，并在 `computed` 里计数 `follow_up_grade_ignored`。

**用例**
- A244–A247：A/B/C/D 各 1 条典型输入（合成），断言等级与 `basis`。
- A248：`target_end_user` + 风险“中” → B，不是 A。
- A249：`reseller` + 低风险 + 具体信号 + 身份 `ambiguous` + 置信度“中” → B。
- A250：风险“高” + `target_end_user` → D（依据为风险）。
- A251：`phishing_like` + 风险“低” → D（依据为类别）。
- A252：遍历用例：对 200 个合成证据包，开启/关闭等级逻辑，风险分、等级、置信度、覆盖逐字节相同（INV-16）。
- A253：旧证据包（无 `lead_signals`）卡片字节与 v0.12.0 一致；`--json` 有 `follow_up_grade`。
- A254：模型自填 `follow_up_grade` 被忽略并计数。
- A255：Python 与 Node 在上述输入上输出一致；`--batch` 的“等级”列一致。

**验收**：A244–A255 通过；受影响快照清单写进报告；行数预算不超（深查 ≤50、快查 ≤30、第一屏 ≤14）。

---

### K-02 转口枢纽例外（P0，负责人已同意）

**目的**：实战指南提醒，阿联酋、土耳其、新加坡、香港的买家常为周边国家转口，号码国与自称所在国不一致很正常。`RF-CORP-005` 现在对这种情况照样加 2 分。

**规则**
- 常量 `HUB_COUNTRIES = {"AE", "TR", "SG", "HK"}`，注释写明“常见转口枢纽，仅用于 `RF-CORP-005` 的例外，不是风险名单”。
- 新增可选 `intake.phone_country`（ISO2，由模型从 `phone_check` 输出的 `country` 抄入）。
- **例外条件**：证据包里有 `RF-CORP-005`，**且** `phone_country ∈ HUB_COUNTRIES`，**且**自称所在国 ≠ `phone_country`。
- 满足时：脚本在 `flag_ids_of` 层面把 `RF-CORP-005` **从红旗列表里剔除**，使风险分、联系方式维度状态（`CONTACT_CONTRA`）、置信度等所有下游计算一致；在 `computed.hub_exception` 记录 `{flag: "RF-CORP-005", phone_country}`。
- **不适用**：自称所在国是枢纽国、但号码来自非枢纽国（如自称迪拜、号码来自尼日利亚）→ 仍计分；`phone_country` 缺失 → 不豁免（旧证据包不变）。
- 显示：不新增行。在“联系方式”维度备注（`dim_notes.contact` 的位置）由脚本追加固定短句：“号码来自转口枢纽国家，与自称所在国不同较常见：不计分，建议礼貌确认业务所在地与收货地。”完整报告写明例外依据。
- `RF-CORP-001`（≥2 个独立字段对不上）：号码国属枢纽国的不一致**不算独立字段**。这条在 `red_flags.md` 的 `RF-CORP-001` 判定细则里加一句；因为 `RF-CORP-001` 由模型判定，同时在 `SKILL.md` 的交叉比对段落写明。
- `red_flags.md` 的 `RF-CORP-005` 小节“不命中”追加这一例外，并在文末加“v0.13.0 判定细则变更记录”，说明权重与编号不变。
- 追问话术（模型写，不超过 3 条）：委婉问法示例“Which markets do you mainly serve from there, and where should we ship the goods?”（中文：您主要服务哪些市场、货物发往哪里？）。**不得暴露背调意图**（INV-12）。

**用例**
- A256：号码 AE、自称 BR → 不计分，维度备注含固定短句，`hub_exception` 有记录。
- A257：号码 NG、自称 BR → 照常 +2。
- A258：号码 NG、自称 AE → 照常 +2。
- A259：`phone_country` 缺失 → 照常 +2。
- A260：号码 HK、自称 CN，同时有第二个独立矛盾（官网国对不上）→ `RF-CORP-001` 是否命中按“枢纽不算独立字段”处理，用例写明预期。
- A261：旧证据包快照遍历：列出所有含 `RF-CORP-005` 的现有用例及结果是否变化，写入报告（INV-02 例外清单）。
- A262：枢纽例外不影响其他红旗与置信度的其他规则。
- A263：Python 与 Node 一致。

**验收**：A256–A263 通过；`red_flags.md`、`SKILL.md`、`card_template.md` 三处文字一致；例外清单已交负责人确认（Q1）。

---

### K-03 首封回复切入清单（P1，通用问题库）

**目的**：实战指南的最后一节：背调要落到首封回复里（角色匹配、产品挂钩、区域适配）。负责人决定**区域适配只做通用的“该问什么”**，不做逐国数据。

**要做（文档为主，不新增脚本逻辑）**
1. 在 `report_template.md` 新增小节“首封回复切入点”，固定三栏：
   - **角色匹配**：按 `buyer_type` 选首轮主打。先读 v0.12 B-01 已有的措辞表，**只补缺口，不重写**；参考：分销商→价格梯度与现货；OEM/制造→技术参数与定制能力；工程商→资质与项目交付案例；批发零售→价格、包装、产品线宽度；贸易中间商→价格、交期、起订量。
   - **产品挂钩**：点出对方官网或社媒正在主推的关联品类（来自证据，不得编造）。
   - **区域适配：该问什么**：见下面的通用问题库。
2. **通用问题库**（放在 `report_template.md` 同一小节，每条含触发条件、英文问法、中文含义，语气委婉）：

| 编号 | 触发条件（缺什么才问） | 英文问法（示例，agent 可润色） | 中文含义 |
| --- | --- | --- | --- |
| Q-01 | 没有目的港/收货地 | Which destination port or city should we quote for, so the price is accurate? | 报价要对准哪个目的港/城市？ |
| Q-02 | 没有贸易术语 | Do you prefer FOB, CIF or another term for this order? | 偏好 FOB、CIF 还是其他术语？ |
| Q-03 | 没有适用标准/认证 | Are there any certification or standard requirements in your market we should follow? | 您的市场有哪些认证或标准要求？ |
| Q-04 | 没有技术规格 | Could you share the specifications your market usually uses, so we match the right version? | 方便给一下当地常用规格吗？ |
| Q-05 | 没有包装/标签要求 | Any packaging or labeling requirements, such as language or brand? | 有包装或标签要求吗？ |
| Q-06 | 不清楚是单次还是长期 | Is this a one-time order or a regular program? | 是一次性订单还是长期需求？ |
| Q-07 | 不清楚现状 | What are you using at the moment, and is there anything you'd like to improve? | 目前用什么，有哪些想改进的？ |
| Q-08 | 不清楚用途 | Is it for a specific project or for resale? | 是项目用还是转售？ |
| Q-09 | 没有收货人信息 | To prepare the documents correctly, could you confirm the consignee details? | 为了单证准确，方便确认收货人信息吗？ |

3. **B 档**（K-01）：SKILL.md 规定，B 档的追问话术优先从问题库里按缺口选 1–2 条，仍受“话术 ≤3 条”约束。
4. 问题库**不含任何逐国数据**（电压、插头、认证机构名称），这些不进仓库。

**用例**
- A264：`report_template.md` 问题库每条都有 `en` 与 `zh`。
- A265：问题库全文不含禁用词（`verify`、`investigat`、`background check`、`scam`、`fraud`、`核实身份`、`调查`），大小写不敏感。
- A266：问题库不含逐国字段（不出现国家名后紧跟电压/频率/认证机构）。
- A267：B 档 `scripts[]` ≤3 条的既有约束仍成立。

---

### K-04 海关画像四指标与供应商来源（P1）

**目的**：实战指南要看 4 项：近 12 个月采购频次、单次规模（整柜/拼箱）、核心 HS 编码、现有供应商分布。其中“是否已从中国采购”决定替换空间，对写开发信最有用。仓库只有品类/角色/频次。

**要做**
1. 证据包新增可选 `customs_profile`：
   - `freq_12m`：枚举 `none | low | medium | high | unknown`（不要求具体次数，避免编造）。
   - `shipment_size`：枚举 `fcl | lcl | mixed | unknown`。
   - `main_hs`：数组，≤3，每项 6 位数字字符串；非 6 位的丢弃并计数。
   - `supplier_origins`：数组，≤5，ISO2 国家码。
   - `source_url`、`observed_at`（沿用 V-02 字段含义）。
2. **只进完整报告**，新增小节“海关画像”，并按 `supplier_origins` 输出**固定模板**的跟进提示（不计分、不判定）：
   - 含 `CN`：“对方已有来自中国的供应商：首轮建议突出价格之外的差异，如交期、品控、认证。”
   - 不含 `CN` 且非空：“对方当前供应商主要来自其他地区：可能存在替换或降本空间，需结合对方需求核实。”
   - 空或 `unknown`：不输出该提示。
3. 与现有 HS 编码矛盾红旗的关系：**不改**；`main_hs` 与询盘品类的比对仍走现有流程。
4. `data-sources/global.md` 海关节补充“看这 4 项”的采集说明，**平台条款与免费程度必须核对后再写（待核实）**。ImportYeti 的覆盖范围、是否免费、是否需要登录，开工时打开官方页面核对。
5. 查不到的处理沿用 INV-04：只降置信度，不计分；报告里写“未查到”而不是“无采购能力”。

**用例**
- A268：含 `CN` → 报告含第一条提示。
- A269：不含 `CN` → 第二条提示。
- A270：`supplier_origins` 空 → 无提示。
- A271：`main_hs` 含非法值 → 被丢弃并计数。
- A272：旧证据包字节一致；卡片不变。
- A273：Python 与 Node 一致。

---

### K-05 号码线索：搜索变体、固话、即时通讯地区表（P1）

**目的**：实战指南的手机号一节有三个仓库缺的点：号码在网页上格式不统一要多种写法搜；固话能直接搜出地址；不同地区用不同即时通讯软件。

**K-05a `phone_check.py/.mjs`：搜索变体**
- 输出新增 `search_variants[]`（≤6，去重）：以号码的“国家内号码”（去掉国家码，并去掉国内长途前缀 0，规则以现有 `phone_check` 的国家表为准）为基础：
  1. 完整国内号码纯数字；
  2. 后 8 位纯数字（长度 >8 时）；
  3. 后 8 位 4-4 分组，用连字符；
  4. 后 8 位 4-4 分组，用空格；
  5. 后 7 位纯数字（长度 >7 时）。
- 少于 7 位数字的变体丢弃。变体**只在脚本 JSON 中输出**，不进卡片，报告只显示掩码（INV-07）。
- `line_type` 为固定电话时，输出 `landline_hint: true`；SKILL 指引里写：“固话可以直接搜地址与地图标注，是核对公司地址的捷径”。`line_type` 为 `unknown` 时不输出该提示（不猜测）。
- 两个脚本输出一致，旧输出键不变（只新增键）。

**K-05b 指引（`data-sources/global.md` 或 `collection_checklists.md`，放哪里先看哪个在包内，放不下先问）**
- 手机号：存入通讯录后分别看 WhatsApp（尤其商业账号：头像、商业资料、地址、营业时间、官网、目录）、Status 动态。
- **即时通讯地区表**（`待核实`，每行写明依据来源，查不到依据的不要写）：Viber（东欧与中东部分地区）、Telegram（俄语区）、Zalo（越南）、Line（日本、泰国、台湾）、KakaoTalk（韩国，待核实）、微信（中文区）。实战指南把“日韩泰”并列为 Line，我怀疑韩国不准确，**不得照抄**。
- 号码反查类服务（如 Truecaller）：只作为人工线索；写明“需登录；其数据来自用户通讯录众包；备注名可能不准，不当证据；注意隐私与当地法规”；仓库不自动调用、不抓取。是否把它写进指引由负责人确认（Q5）。
- 号码所在国与时区：沿用现有时区说明，不重复。

**用例**
- A274：国内号码 10 位 → 变体含完整、后 8 位、两种分组、后 7 位，且无重复。
- A275：号码过短 → 变体少于 7 位的被丢弃。
- A276：`line_type` 固话 → `landline_hint: true`；`unknown` → 不输出。
- A277：旧输出键不变，Python 与 Node 一致。
- A278：卡片与报告中不出现完整 `search_variants` 内容（隐私扫描）。
- A279：指引里的每一行地区表都有“依据”或标“待核实”。

---

### K-06 官网活跃度与人物层级（P1）

**目的**：实战指南的两个线索：官网“新闻/博客最后更新时间”和案例页、品牌页；LinkedIn 的职位层级与近期跳槽。新兴市场买家官网常年不更新但社媒活跃，所以这些**只作线索，不计分**。

**要做（全部可选字段，只进完整报告，卡片不变）**
1. 公司层：`site_last_updated`（`YYYY-MM`，可空）、`site_sections_seen[]`（枚举 `about products brands projects news`）。
   - 报告提示（固定模板）：最后更新早于 12 个月 → “官网久未更新：可结合社媒近况判断活跃度，不计分。”
   - 看到 `brands` 时，提示“可从代理品牌判断对品质与合规的要求”；看到 `projects` 时，提示“可判断是否为工程承包商”。
2. 人物层级：`role_level` 枚举 `owner_director purchasing technical assistant_intern other unknown`；`recent_job_change` 为 `true | false | null`（近 12 个月内换了公司，来源 LinkedIn 公开资料，需 `observed_at`）。
   - 报告提示（固定模板）：`assistant_intern` → “对方可能只负责收集资料，决策人可能另有其人”；`recent_job_change: true` → “对方刚到新公司，可能在重建供应商库，是切入机会，需自行确认。”
3. **字段放在证据包的什么位置，agent 先读 v0.10 `person_company_link` 层的结构再定**，不要新建平行结构；先写方案交负责人确认。
4. 隐私：只使用公开可见的职业资料（职位、任职公司、行业），不看家庭、住址、私人照片（沿用 `SKILL.md` 现有约束）。

**用例**
- A280：`site_last_updated` 早于 12 个月 → 报告含固定提示，分数不变。
- A281：`role_level: assistant_intern` → 报告含固定提示。
- A282：缺字段 → 无提示，旧证据包字节一致。
- A283：Python 与 Node 一致。

---

### K-07 v0.12 抓取安全收口（P1）

按 `docs/pF-01-report-v0.12.0.md` 的遗留逐条处理：

1. **TOCTOU**：在 Python 里先解析并校验地址，再用**已校验的 IP** 建立连接，同时保留 `Host` 头与 TLS `SNI`（`server_hostname`），避免校验与连接之间 DNS 被改写。做不到的部分写进报告，不要假装已防住。Node 侧同理，做不到就明确写“残余风险”。
2. **总时限**：增加跨重定向的总时限（建议值：总计不超过单次超时的 3 倍，**以负责人确认的数为准**）。
3. **`unsafe_url` 结构化**：地图/注册库命令里，`UnsafeUrl` 不再以错误字符串返回，而是 `status: "unsafe_url"` + `reason`，与 `identity_check site` 一致。
4. **可注入夹具**：`safe_open`（Python）与 `safeFetch`（Node）支持注入假 opener/fetch，补完整流程用例，覆盖：重定向到内网、4 跳重定向、https→http、响应超过 2 MiB、内容类型不符。测试必须离线。
5. **Node 流式中止**：`safeFetch` 改为边读边计数，超过 2 MiB 立即中止，不先读完 `arrayBuffer`。

**用例**：A284 TOCTOU（假解析器第二次返回内网地址 → 拒绝或使用第一次已校验地址）；A285 总时限；A286 地图命令返回 `unsafe_url`；A287 注册库命令返回 `unsafe_url`；A288–A290 完整流程的重定向/大小/内容类型；A291 Node 流式中止。

---

### K-08 名单解析与性能收口（P1）

按 `docs/pS-02-report-v0.12.0.md` 的遗留处理：

1. **Node CSV 解析**：`sanctions_check.mjs`、`update_sanctions.mjs` 改为能处理“引号内带换行”的 CSV（状态机逐字符解析）。**先用真实 UK 名单验证 Python 与 Node 解析出的行数、列数一致**，再合并；真实名单只放本地 `.cache/`，不进仓库。
2. **真实名单实测**（写进 `docs/validation.md`，只写数字，不贴名单内容）：
   - OFAC + UK 两份缓存下，一次查询的耗时（冷启动与热启动各一次）；
   - 内存峰值。
   - 如果一次查询耗时过长（**建议阈值：超过 5 秒就做缓存索引**，阈值以负责人确认为准），在 `.cache/` 下生成归一化后的词索引文件，不改变匹配语义，不进包。
3. **误报测量**：用 E001–E135 与旧 85 条里所有合成公司名作为查询，对**真实**的 OFAC + UK 名单（本地）各跑一遍，统计误命中条数与类型，写进报告。目标：0；不为 0 时列出原因，并判断是否需要调整“partial”规则。
4. 保持 INV-15。

**用例**：A292 引号内带换行的合成 CSV → Python 与 Node 行数一致；A293 索引存在与不存在时输出完全一致；A294–A295 Node 与 Python 在 UK 合成夹具上输出一致；A296 误报测量脚本可复现（只依赖本地缓存，缓存缺失时跳过而不是失败）；A297 INV-15 回归。

---

### K-09 校准、走查与 `render_card.py` 整理（P2）

| 项 | 要求 |
| --- | --- |
| 阈值校准 | 收集 ≥50 条**脱敏**真实询盘（只存本地 `reports/`，不进仓库）；跑 `score_eval` 得到 `lead_class`、跟进等级、红旗的混淆矩阵；**只写建议，不改阈值**，改动另行提案 |
| p08 走查 | 找一位真实业务员，用本版走一遍“装好后第一次使用”，记录卡点；走查记录脱敏后留在本地 |
| `render_card.py` 整理 | 2754 行。本版只做**文件内**分区与注释整理（解析/评分/渲染/指南/去重/等级），**不拆新文件**（INV-08）；整理前后全部快照字节一致 |
| 评测对比 | K-01 的等级在评测集上的分布写入 `docs/validation.md` |

---

### K-10 来源核实收口（P2）

- **Made-in-China**：打开平台官方页面，核对会员等级与认证标识的名称与含义；核对不到的保持“待核实”。
- **GLEIF、VIES、EDGAR、CSL、Companies House**：逐条核对使用条款、是否需要 key、访问频率限制、是否允许自动化；把结论写进 `data-sources/global.md` 的 `terms_checked`，仍默认只给链接。
- A298：新增条目均含 `verified_at` 与 `terms_checked`；A299：`check_sources` 不因新增条目失败。

---

### K-11 业务员 5 分钟清单（P2，文档）

在 `README.md` 增加一节“业务员 5 分钟初筛清单”（**不改 `--guide` 文本**，以免破坏 A171–A178）：查号码归属与时区 → 存号看 WhatsApp 头像与商业资料 → 搜邮箱与域名看官网 → 搜“公司全称 + scam/fraud/complaint”。并说明：A 档才值得投入 20–30 分钟做深查，B 档边聊边探，C 档模板回复，D 档不点链接、先不回复。改动 `README.md` 的数字必须同步 `manifest.rewrites`。

---

### E-02 评测补充（P0）

**语料（`tests/eval/inquiries.jsonl`，E116–E135，共 20 条，全部合成）**

| 类型 | 数量 | 说明 |
| --- | --- | --- |
| 跟进等级 | 8 | A、B、C、D 各 2 条，覆盖“风险高的目标买家 → D”“风险中的目标买家 → B”“信息少但无雷点 → B” |
| 转口枢纽 | 6 | 号码 AE/TR/SG/HK 自称他国（应豁免）；号码 NG 自称 BR（不豁免）；自称 AE、号码 NG（不豁免） |
| 海关画像 | 3 | 供应商含中国/不含中国/未知 |
| 人物与官网 | 3 | `assistant_intern`、近期跳槽、官网久未更新但社媒活跃 |

- 新增字段 `expected_follow_up_grade`、`expected_hub_exception`；旧 115 条不改。
- `tests/eval/score_eval.mjs` 增加“跟进等级”混淆矩阵；`--self` 自检保留；不作为 CI 门槛。

---

## 6. 隐私与合规要点

1. `search_variants` 含完整号码，只在脚本输出，不进卡片、报告和日志；`privacy_scan` 增加检查。
2. K-09 的真实询盘只放本地 `reports/`，并加入 `.gitignore`；提交前运行 `privacy_scan`。
3. 号码反查服务、社媒平台只作人工线索，不自动调用、不抓取、不绕过登录。
4. 所有新增样例与夹具均为合成数据。

---

## 7. 精简包与构建

- 本版**预期不新增进包文件**：K-01/K-02/K-04/K-06 在 `render_card.py` 内；K-05 在 `phone_check.py` 内；K-03 在 `report_template.md` 内。
- K-05b 的指引放 `data-sources/global.md` 还是 `collection_checklists.md`：先确认哪一个在包内；放不进包就并入已有合并产物，不新增文件；仍放不下先问负责人。
- 发布前运行：`node tests/run_cases.mjs`、`node tests/consistency.mjs`、`node tests/consistency_scripts.mjs`、`node tests/eval/score_eval.mjs --self`、`privacy_scan`、`build_submission`；全部通过，文件数 ≤28，体积 ≤40MB。

---

## 8. 文档对账（D 系列）

| 编号 | 内容 |
| --- | --- |
| D-01 | 版本号 0.13.0：`SKILL.md` frontmatter、`submission.manifest.json`、`README.md`、`CHANGELOG.md`、`docs/development.md` |
| D-02 | `submission.manifest.json` 的 `rewrites`：A 用例终点（预计 A299）、评测条数（预计 135）与 SKILL/README 同步 |
| D-03 | `CHANGELOG.md` 新增 0.13.0 条目：**明确写出 `RF-CORP-005` 的触发条件变化**与受影响的旧用例 |
| D-04 | `red_flags.md`：`RF-CORP-005`、`RF-CORP-001` 的判定细则 + “v0.13.0 判定细则变更记录” |
| D-05 | `docs/validation.md`：K-08 实测、K-09 校准建议、K-10 核实结论、等级分布 |
| D-06 | 把本文提交为 `docs/iteration_plan_v0.13.md`，状态改为“已完成/部分完成”并列出未做项 |

---

## 9. 验收总清单（审核 agent 逐条打勾）

- [ ] K-01：等级规则逐条有用例；INV-16 遍历用例通过；旧证据包卡片字节一致；`--batch` 有“等级”列；行数预算不超
- [ ] K-02：枢纽例外只影响 `RF-CORP-005`；剔除发生在 `flag_ids_of` 层，分数、维度状态、置信度一致；受影响旧用例清单已交负责人
- [ ] K-03：问题库每条有英文与中文；无禁用词；无逐国数据
- [ ] K-04、K-06：全部可选字段，只进完整报告，旧证据包字节一致
- [ ] K-05：`search_variants` 不进卡片/报告；固话提示不猜测
- [ ] K-07：TOCTOU 有方案或明确残余风险；总时限；`unsafe_url` 结构化；Node 流式中止
- [ ] K-08：Node CSV 解析与 Python 一致；真实名单耗时与误报已记录；INV-15 回归
- [ ] K-09、K-10、K-11：按范围完成，真实数据未进仓库
- [ ] E-02：评测与评分器更新；`--self` 通过
- [ ] INV-01…INV-16 逐条自检写入总报告
- [ ] Python/Node 一致性全绿；精简包 ≤28 个文件、≤40MB；`privacy_scan` 通过

---

## 10. 需要负责人回答的问题（agent 先停下问）

| 编号 | 问题 | 推荐默认 |
| --- | --- | --- |
| Q1 | K-01、K-02 会改变少数旧输入的输出（带“类别”后缀的卡片新增“· 跟进：X”；命中枢纽例外的包少扣 2 分）。是否允许作为 INV-02/INV-03 的例外？另：`lead_class` 为 `unclear` 的卡片是否也显示等级？ | 允许；`unclear` 不显示（只写 `--json`），避免第一屏变长 |
| Q2 | 枢纽国家集合 `{AE, TR, SG, HK}` 是否要扩展（如沙特、印度尼西亚等）？ | 先用这 4 个，扩展另提案并逐国说明依据 |
| Q3 | K-01 的 A 档“建议投入时间约 20–30 分钟”来自实战指南，是否保留？ | 保留，仅写进完整报告，不进卡片 |
| Q4 | K-07 的总时限数值 | 单次超时的 3 倍 |
| Q5 | 号码反查类服务（Truecaller 等）是否写进指引（只作人工线索，附隐私提示）？ | 写，但标明“需登录、备注名仅作线索” |
| Q6 | K-08 中“一次查询超过多少秒就做缓存索引”的阈值 | 5 秒 |
| Q7 | 附件属性核验是否扩展到 Word/Excel（实战指南建议）？需要限制文件大小、不执行宏、不读外部关联，仍然“只比对、不存作者” | 本版不做，另提案 |

---

## 11. 起草时没有核实的事项（agent 必须自己核实）

1. 仓库 `SKILL.md` 里“置信度为高”的确切取值与 R1–R5 映射。
2. `render_card.py` 在 `lead_class` 后缀所在行的实际位置，以及 `--batch` 表的列宽余量。
3. `phone_check` 现有国家表对“国内长途前缀”的处理规则。
4. 即时通讯软件的地区使用情况（尤其韩国是否以 KakaoTalk 为主，Line 的主要市场）。
5. ImportYeti 等海关来源的覆盖范围、免费程度、登录要求与使用条款。
6. 真实 UK 名单中带换行的引号字段是否存在，以及真实名单下的查询耗时与内存。
7. Made-in-China 的会员与认证字段名称。
8. 证据包里 `person_company_link` 层的结构，用来决定 K-06 字段放哪里。
9. 实战指南本身是 AI 生成的经验文，其中的“命中率极高”“习惯用法”等说法均未经核实。
