# buyer-check 验证说明（v0.11.0）

本文件只放仓库，不进精简包。所有案例使用虚构公司名、`.example` 域名和保留电话段，不含真实客户信息。

## 1. 验证范围

- 离线验收：`tests/cases/A1–A178`，覆盖评分、域名、电话、邮件头、制裁、账户、地图、身份、结论卡、入口、注册库、未完成项、证据强制、来源等级、数据日期、冲突、灰色卡、红旗说明、询盘有效性分类、来源渠道、表单元数据、收货信息、独立确认与使用指南。
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