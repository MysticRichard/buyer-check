# buyer-check 验证说明（v0.12.0）

本文件只放仓库，不进精简包。所有案例使用虚构公司名、`.example` 域名和保留电话段，不含真实客户信息。

## 1. 验证范围

- 离线验收：`tests/cases/A1–A243`，覆盖评分、域名、电话、邮件头、制裁、账户、地图、身份、结论卡、入口、注册库、未完成项、证据强制、来源等级、数据日期、冲突、灰色卡、红旗说明、询盘有效性分类、来源渠道、表单元数据、收货信息、独立确认、使用指南、OFAC 列位、全球后缀、抓取安全、UK 名单、身份状态、交易背景、免费来源与批内去重。
- 渲染一致性：Python 与 Node 两套 `render_card` 对同一证据包输出逐字节一致；旧证据包（不带 v0.9.1 新字段）保持 v0.9.0 的卡片字节。
- 隐私：仓库与精简包均通过 `privacy_scan`；不出现真实客户名、真实域名、真实电话。
- 精简包：≤28 个文件，不新增进包文件；`docs/validation.md` 与测试用例不占包内文件预算。

## 2. 虚构场景表（节选）

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| A23/A24 | 短品牌仿冒域名误报与真阳性 | 10 个假阳性 `false`，8 个真阳性 `true` |
| A25 | 制裁缓存、命中、下载成功/失败 | 无缓存 `no-network`，命中需人工复核 |
| A42–A44 | 制裁地址链、非法内容、全部失败 | 第一个通过即停；`invalid-content` 保留旧缓存；`all-urls-failed` 不崩溃 |
| A45–A46 | `checks_incomplete` | 覆盖行下方“本次未完成”，覆盖分子减 1、分母仍 8 |
| A47–A48 | 证据编号强制 | 假/空/重复编号移入“没查到”；`user_input` 不进“已核实” |
| A49–A50 | 来源等级与独立来源 | 官方或 2 条不同主域第三方才进“已核实” |
| A51 | 数据日期与 stale | 显示来源日期；陈旧写入未完成行 |
| A52 | 来源冲突 | 并列显示，不替用户二选一、不改风险分 |
| A53–A54 | 灰色卡 | “风险 待核实”，未核实维度有可执行下一步 |
| A55 | 红旗 why/benign | 31 条齐全，卡片只给最高权重触发行“可能无害” |
| A56–A57 | flip_hint 与固定声明 | 首屏外显示；声明恰好一次 |

### 2.1 v0.10 场景摘要（A68–A140）

- **A68–A80**：国家能力表 0.6.0、GSTIN/PAN 掩码自检、实体匹配门（仅名称不算匹配）、8 类公开足迹探针与 8 条新红旗的派生条件。
- **A81–A110**：官方来源/角色/时间窗/证据编号的真实性、媒体集团不算独立来源、`search-only` 下官方足迹降级、`offline` 不渲染足迹、别名匹配反绕过。
- **A111–A135**：判断行与动作阶梯矛盾回退、证件与文件自检、批量分诊、复查对比、检索日志附录 D、本地化话术、768 组合条款复跑、能力降级与灰色卡下一步。
- **A136–A140**：`alias` 官方/推断三例、GSTIN/PAN `source_url` 登记、名称+地址正例与注册号冲突否证。

### 2.2 v0.11 场景摘要（A141–A178）

- **A141–A152**：`lead_class` 八类映射、优先级、弱信号边界、真实买家安全附件、未知信号计数、旧包字节、遍历不变、L=高结论优先、行数预算、禁用词、Python/Node 一致、模板回归。
- **A153–A155**：`channel` 9 个枚举不改变卡片字节、非法值计数、缺失写“未提供”、`global.md` 第十四节覆盖 7 渠道。
- **A156–A160/A170**：IPv4/IPv6 脱敏、完整 IP `invalid-input`、三个异常标记与 4/5 秒边界、遍历不变、`honeypot` 才触发自动提交、`privacy_scan` 完整 IP 检测。
- **A161–A162**：`RF-SAN-001` 正例（权重 5、等级高）与人工排除反例。
- **A163–A164**：制裁源配置状态、未配置源 `not_configured`、下载失败/非法内容/全部失败的既有行为。
- **A165–A167**：收货国与买家国不同的线索、`risk_background` 命中与来源、`null` 不输出。
- **A168–A169**：`unverified-contact` 一次动作与视频核验话术的出现条件。
- **A171–A178**：`--guide` 行数与示例、电话/IBAN/域名自检、禁用词、双语言字节一致、模板与 README 一致、SKILL 求助词与 description 长度、不读证据包。

## 3. 已修复的误报

- 短品牌 `ups` 的 `groups` 后缀误报：修复后只对连字符独立词段或 `risk_words` 后缀判定 `affixed`，`dhlgroup.com`、`fedexgroup.com` 不再单独判仿冒，靠 RF-DOM-002 兜底。
- `domain_similarity` 对集团站-品牌站不一致的误判：人工排除，不命中 RF-DOM-001。
- 本次 v0.9.1 未新增红旗、未改权重、未改评分公式、未改覆盖分母 8。

## 4. 已知局限

- 地图：OSM Nominatim 覆盖有限，Google Maps 需要 API Key 或人工查看；地图无结果只写“没查到”，不当作负面。
- 注册库自动查询：只实现挪威 Brønnøysund Enhetsregisteret；其他国家返回 `not-covered` + 能力矩阵链接或人工入口，不猜。
- 制裁名单：依赖网络下载 OFAC SDN CSV；下载失败必须显示为“本次未完成”，不能写成“未发现”。
- 社媒：不自动登录、不绕验证码；登录墙后写 `login-wall`。
- 小公司官网可能只有联系表单、模板社交图标，不代表诈骗；只作为操作线索。

## 5. R1 下载地址实测（2026-11-11）

- 旧地址 `https://www.treasury.gov/ofac/downloads/sdn.csv` 返回 **302**，Location 为 `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn.csv`。
- 官方 SLS 端点 `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV` 返回 **200**，`Content-Disposition: attachment; filename="SDN.CSV"`，`Last-Modified: 2026-11-09`。
- 实得文件：**5,833,851 bytes**，CSV **19,564 行**、**12 列**（首行 12 列，含空行）。
- 内容校验阈值：非空行 ≥15,000，首行 ≥12 列，≥90% 行达到 12 列；不满足即 `invalid-content`，不覆盖旧缓存。
- 地址链：SLS 直连优先，treasury.gov 作为第二项；每项超时 20 秒；第一个通过校验即停。

## 5.1 制裁源实测（2026-11-20，N-05）

| 源 | 官方页面 | 实测 | 结论 |
| --- | --- | --- | --- |
| OFAC SDN | `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV` | 200，CSV，免登录，无令牌，约 5.8 MB / 19k 行，官方持续更新 | **configured** |
| EU Consolidated | `https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content` | **403 Forbidden**（带常见浏览器 UA 仍 403），需访问令牌或浏览器会话 | **not_configured**（`http-403-token-required`） |
| UN Security Council | `https://www.un.org/securitycouncil/content/un-sc-consolidated-list` 页面可访问（XML/HTML/PDF，页面注明 2026-11-16 更新） | 过去使用的 XML 直链 `https://scsanctions.un.org/resources/xml/en/consolidated.xml` 返回 **404**；未找到免令牌的稳定直链 | **not_configured**（`xml-link-404`） |
| UK OFSI Consolidated | `https://www.gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets` | 页面 200，但明确标注 **OFSI Consolidated List 已于 2026-01-28 关闭**，UK Sanctions List 成为唯一来源 | **not_configured**（`ofsi-list-closed-2026-01-28`） |

- 只配置免登录、官方发布、许可允许缓存使用的源；不满足的一律 `not_configured`，不硬上。
- `sanctions_check` 输出 `sources[]` 与 `lists_not_configured[]`；未配置源不抛异常，卡片如实写“已查哪些”，不写成“已排除制裁风险”。
- 许可：OFAC 数据为美国政府公开数据；EU/UN/UK 的许可与下载条款未在免令牌条件下核实，故不缓存。

## 5.2 OFAC 列位实测（2026-11-20，S-01）

- 2026-11-20 重新下载 SLS 端点：**200**，**5,845,409 bytes**，非空行 **19,600** 行（19,599 行 12 列，1 行空/1 列）；**无表头行**。
- 列位：**0 = ent_num**，**1 = 名称**，**2 = 类型**，**3 = program**，4–11 为其他字段（标题、呼号、船只信息等）。
- 类型列实测分布（按 `strip().lower()`）：`-0-` 10,122；`individual` 7,565；`vessel` 1,570；`aircraft` 342；未发现其他值。
- v0.11.0 的 `sanctions_check.py/.mjs` 对 OFAC 使用 `name_column=2`，实际读到的是类型列；真实名单上的姓名查询会全部落空（`-0-`/`individual` 等类型词反而可能参与比较）。本版已把 OFAC 名称列改为 **1**（Python/Node 同改），并新增类型列语义校验：12 列行中 ≥90% 的第 2 列必须落在上述小集合内，否则返回 `bad-type-column` → `invalid-content`，不覆盖旧缓存。
- 测试夹具已从“编号,类型,名称”的 3/4 列迁就格式，改为真实 **12 列**格式（名称在列 1），A179–A184 覆盖命中、类型词不命中、双语言一致、类型列异常与旧格式拒绝。
- **措辞区分**：5.1 的“下载与格式校验通过”只说明文件可下载、列数为 12；**不等于“姓名匹配通过”**。v0.11.0 的 OFAC 查询结果在真实名单上不可信，本版修复后才可写“已查 OFAC”。

## 6. 复现命令

```bash
node tests/run_cases.mjs
node tests/consistency.mjs
node tests/consistency_scripts.mjs
node tests/account_check_cases.mjs
node tests/check_sources_cases.mjs
node tests/ip_check_cases.mjs
node tests/phone_check_enrich_cases.mjs
node tests/eval/score_eval.mjs --self
node scripts/privacy_scan.mjs
node scripts/build_submission.mjs
(cd dist/submission && node tests/run_cases.mjs)
node scripts/privacy_scan.mjs dist/submission
```

## 7. Privacy

本文件与测试用例只使用虚构名（如 ACME TRADING LTD、Harbor Rim Engineering）、`.example` 域名和保留电话段；不含真实客户姓名、真实域名或真实电话。真实客户报告只保存在本地 `reports/`，不入仓库。
## 8. v0.11 评测基线（N-04d）

评测语料 `tests/eval/inquiries.jsonl` 共 **85 条**（E001–E085），其中 **53 条**正常询盘（`expected_flags: []`）。E046–E085 是新扩的 40 条，全部合成：公司名虚构、域名 `.example`、电话使用保留号段。

### 8.1 红旗样本覆盖

- 有文本正例的红旗 20 条：`RF-PAY-001`（4）、`RF-PAY-002`（3）、`RF-BEH-002`（3）、`RF-BEH-003`（3）、`RF-ACC-001`（2）、`RF-BEH-001`（2）、`RF-CORP-001`（2）、`RF-MAIL-002`（2），以及 `RF-ACC-002`、`RF-CORP-002`、`RF-CORP-003`、`RF-CORP-004`、`RF-CORP-005`、`RF-DOM-001`、`RF-DOM-002`、`RF-ID-001`、`RF-ID-002`、`RF-ID-003`、`RF-MAIL-001`、`RF-NEG-002` 各 1 条。
- 无文本正例的 11 条属脚本/离线派生类：`RF-SAN-001`、`RF-NEG-001`、`RF-CORP-006`、`RF-FOOT-001`–`RF-FOOT-005`、`RF-ID-004`、`RF-ID-005`、`RF-DOC-001`。它们由工具输出或本地自检派生，不适合用询盘原文评测；`RF-SAN-001` 的行为由 A161/A162 与 A25 覆盖，其余由 A79/A81/A102/A114/A125/A127/A138 等夹具覆盖。
- 自检：`node tests/eval/score_eval.mjs --self` 要求每条红旗 recall=1、fp=0，正常询盘误报为 0。

### 8.2 询盘有效性类别（`expected_lead_class`）

40 条新语料带类别标注；旧 45 条不改，缺字段视为未标注。自检结果（期望值当预测）：

| 类别 | 样本数 | 精确率 | 召回率 |
| --- | --- | --- | --- |
| `automated_submission` | 2 | 1 | 1 |
| `phishing_like` | 3 | 1 | 1 |
| `vendor_solicitation` | 4 | 1 | 1 |
| `competitor_probe` | 4 | 1 | 1 |
| `individual_research` | 2 | 1 | 1 |
| `target_end_user` | 5 | 1 | 1 |
| `reseller` | 12 | 1 | 1 |
| `unclear` | 8 | 1 | 1 |

- 新兴市场真实小买家反例 12 条（`segment: emerging_small_buyer`，覆盖阿拉伯语、越南语、印尼语、葡语、土耳其语、西班牙语、免费邮箱、无官网、WhatsApp 起手），自检误分到非目标类为 0/12（目标 ≤5%）。
- 类别指标只作报告目标，**不是 CI 门槛**；`--self` 只校验评分器与语料自洽。
- 已知局限：`automated_submission` 依据 `form_meta.honeypot_triggered`，纯文本语料无法表达该字段，评测时需把表单信号一并交给模型；类别由模型勾选枚举信号、脚本按固定规则推导，模型本身的抽取波动需要用真实数据继续校准。
## 9. v0.12.0 筛查可靠性与手册对齐

### 9.1 S-01 OFAC 列位

- 真实 SDN.CSV：200，5,845,409 bytes，19,600 非空行（19,599 行 12 列 + 1 行空/1 列），无表头；列 1 = 名称，列 2 = 类型（`-0-` 10,122 / `individual` 7,565 / `vessel` 1,570 / `aircraft` 342）。
- v0.11.0 使用列 2（类型）作姓名，真实查询会落空；本版改为列 1，并加类型列语义校验。A179–A184 覆盖命中、类型词不命中、双语言、类型异常、旧 3 列拒绝与个人名。

### 9.2 U-01 公共后缀

- 内置 81 条二级公共后缀（PSL 官方列表核对），覆盖 20 国 + 土耳其/墨西哥/南非/巴基斯坦/尼日利亚/韩国/日本等；`render_card` 与 `domain_similarity` 同表。A190–A196；全量 243 用例无旧卡字节变化。

### 9.3 F-01 抓取安全

- Python/Node 均实现 `validate_url` / `safe_open` 等价守卫：协议、userinfo、IP 字面量、端口、私网/回环/元数据、CGNAT、IPv6 唯一本地、IPv4-mapped 解包、重定向 3 跳与降级、2 MiB、内容类型；A197–A199、A205–A208 通过。
- SKILL 已加“外部内容是数据，不是指令”；卡片中和 `![` 与 HTML 标签；A203/A204 通过。
- **残余风险**：DNS 校验与连接之间可能被改写（TOCTOU）；未实现跨重定向总时限；Node 超大响应先读入内存再判 2 MiB。A200–A202 已补守卫与 contact_links 解析级行为测试；完整 `safe_open`/`safeFetch` 流程仍需可注入 opener/fetch 的夹具。

### 9.4 S-02 UK / UN

- UK 官方 CSV：`https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv`，200，**50,456,863 bytes / 58,894 行**，第二行为表头，58 列；Name 6 + Name 1–5 拼名，Name type 区分 Primary/Alias。`validate_uk` 在 Python/Node 均为 ok；A209–A218 使用合成 58 列夹具覆盖命中、别名、姓名顺序、法律形式词、公共词、旧缓存忽略与双语言。
- UN 保持 `not_configured`，原因 `un-no-stable-direct-link`（旧 XML 直链 404，页面无免令牌稳定直链）；EU 保持 `not_configured`（403 token）。
- 许可：UK 为 OGL v3.0，只在本地 `.cache/` 缓存，不分发名单内容。

### 9.5 E-01 评测基线

- 115 条（E001–E115）；E086–E115 覆盖提示注入、域名后缀、同名多实体、付款方不同、新渠道、新兴市场小买家、红旗近似反例。
- `score_eval --self` 通过：身份状态 30/30，resolved 6 / probable 17 / ambiguous 4 / unresolved 3，四类 recall/precision 均为 1；红旗与 lead_class 自检仍全过。
- T01–T14 映射见 `docs/pE-01-report-v0.12.0.md`。

### 9.6 其余 v0.12 变更

- R-01/V-02/B-01/C-01/G-01/L-01：A219–A243；`identity.status`、证据新字段、交易背景、渠道补全、免费来源清单、`--dedup` 均不改风险分/等级/置信度/覆盖分母。
- **已知缺口**：H-01 的阈值校准只写建议、未用真实模型预测；p08 真实业务员走查未执行；`render_card.py` 未做文件内分区整理。


## v0.13.0（2026-11-25）

### 跟进等级分布（评测集 E116–E135）

`node tests/eval/score_eval.mjs --self`：20 条带 `expected_follow_up_grade` 的语料，A 12 / B 4 / C 2 / D 2；`--self` 的混淆矩阵对角线全中（仅自洽检查，不是真实预测）。真实模型的等级分布需在真实询盘上另行记录。

### K-08 名单解析与性能（2026-11-25 真实名单实测）

- **合成夹具**：Python 与 Node 的 OFAC/UK CSV 解析均改为状态机，支持引号内换行；A292/A294/A295 断言两语言解析出的行数与名称一致；A293 断言索引文件存在/不存在时查询关键字段一致；A296 误报脚本在无本地缓存时 `status: skipped`（不失败）；A297 制裁命中不自动计分。
- **真实名单**（本地 `.cache/sanctions/`，不进仓库）：
  - 规模：OFAC SDN 5,845,409 bytes / **19,599 行**；UK Sanctions List 50,456,863 bytes / 物理换行 **58,896**，实际解析 **58,779 行** → **117 处引号内换行**，证明状态机必要。
  - Python 与 Node 解析行数/首条名称完全一致（19,599 / 58,779；`AEROCARIBBEAN AIRLINES` / `HAJI KHAIRULLAH HAJI SATTAR MONEY EXCHANGE`）。
  - 解析耗时：Python OFAC 0.248s、UK 1.11s；Node OFAC 167ms、UK 1,286ms。
  - 查询耗时（CLI 每次冷/热进程，含加载两份名单）：Python 1.56 / 1.50 / 1.54s；Node 2.15 / 1.92s → 均低于 5 秒阈值，**不需要**归一化词索引。
  - 内存：Python 加载两份名单后工作集约 **77,844 K（≈76 MB）**；Node 解析后 RSS **≈1.56 GB**（Node 仅作本地一致性对照，不是主运行时）。
  - 误报：**21** 个合成公司名（12 个来自用例/夹具 + 9 个从评测语料启发式提取），对 OFAC + UK 命中 **0 条**。
  - 局限：评测语料是自由文本、没有结构化公司字段；9 个名称由正则启发式提取，不是人工确认的全部公司名。

### K-10 来源核实结论（2026-11-25 实测）

本轮实际打开了以下页面；核对不到的如实记录，不写成“已核实”：

| 来源 | 实测结果 | 结论 |
| --- | --- | --- |
| trade.gov CSL | 页面可达；明确列出 CSV/TSV/JSON 下载与 API，API 免费、无需 key，每日 5:00 ET 更新 | **已核对**（仅页面说明层面） |
| ImportYeti | 首页与 FAQ 可达；首页称 7.15 亿条记录、每日更新，需免费注册/登录；FAQ 中免费额度与覆盖范围的答案未展开 | **部分核对**（需登录与注册已确认；额度/覆盖待核实） |
| EU VIES | 页面可达，但为 JS 应用，条款未在页面正文呈现 | 待核实 |
| GLEIF | 搜索页可达；`/en/about-lei/terms-of-use` 与 `/en/legal-notice` 均 404 | 待核实（terms 页面 404） |
| SEC EDGAR | `/os/accessing-edgar-data` 返回 403（机器人拦截） | 待核实（403） |
| UK Companies House | 登记查询页可达；`/guidance/companies-house-api` 返回 404 | 待核实（API 条款页 404） |
| Made-in-China | 首页可见 Secured Trading Service / Leading Factory / Selected Supplier 标识 | 标识名**已核对**；会员等级字段名仍待核实 |

### K-09 校准与走查

未执行：阈值校准需要 ≥50 条脱敏真实询盘；p08 走查需要一位真实业务员；数据只应放本地 `reports/` 并已脱敏、加入 `.gitignore`。

已完成：`render_card.py` 文件内分区注释整理（10 个分区：文本与脱敏、身份/收货/交易背景、核实度与评分、动作阶梯与结论句、询盘信号与跟进等级、证据契约与来源等级、复查/批量/去重、显示契约、渲染主流程、阶梯与 CLI），**不拆新文件、不改代码行为**；全量用例与旧卡片字节快照（A146/A253/A272/A282）验证一致。

### K-07 抓取安全的残余风险

- Python `safe_open` 已加跨读取总时限；但连接仍由 urllib 重新解析 DNS，**未做到用已校验 IP 建连**，TOCTOU 残余风险保留（未假装已防住）。
- Node `safeFetch` 已改为流式读取并在超过 2 MiB 时中止；重定向每跳重新校验。
- map / registry 在 SSRF 校验拒绝时返回 `status: "unsafe_url"` + `reason`。

### v0.13.0 两轮真实询盘验收（2026-11-25）

| 轮次 | 输入类型 | 结果 | 覆盖 | 实际查询结果摘要 |
| --- | --- | --- | --- | --- |
| 1 | 菲律宾农业贸易（公司名 + 个人 + PH 手机 + Gmail） | ⚪ 需人工核实；风险 0/待核实；核实度 10/100；跟进 B | 4/8 | 无红旗；候选域名均为停放/JS 跳转页或无 A 记录；DTI BNRS 精确查询被 JS/验证码门控；搜索/社媒/地图分别被验证码、登录墙、限流拦截；OFAC+UK 0 命中 |
| 2 | 巴西个人（仅姓名 + BR 手机） | ⚪ 需人工核实；风险 0/待核实；核实度 10/100；跟进 B | 2/8 | 无红旗；无公司名/邮箱/域名，无法做 CNPJ 查询；OFAC+UK 0 命中 |

**结论**：两轮真实输入上均未误报红旗、未把“查不到”当负面，均如实标「需人工核实」并给 B 档轻量追问。未发现新的功能性阻断。

**已知观察**：`phone_check` 对巴西“国家码后含区号”的号码可能给出 `line_type=fixed_or_unknown` 与 `landline_hint`，但可选依赖显示 MOBILE；本轮报告未采用该提示，建议后续版本修正区号+手机前缀判定。

**数据边界**：真实姓名、电话、邮箱、公司名与完整报告只存本地 `reports/`（`.gitignore`），未写入仓库、PR 或本文件；本表只保留匿名摘要。
