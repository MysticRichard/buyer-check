# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。迭代方案见 [docs/iteration_plan.md](docs/iteration_plan.md)（v0.4.1–v0.6.0）与 [docs/iteration_plan_v0.7.md](docs/iteration_plan_v0.7.md)（v0.7.0）。

## [0.7.0] - 2026-10-27

### 隐私与仓库卫生（P0）

- 清理 git 历史中的敏感文件，提交哈希已变更（`main` 已强制更新）。
- `.gitignore` 增加 `dist/`，提交包构建产物不入库。

### 规则固化（P2）

- `RF-ACC-002`（收款账户国与买家自称国不一致且无合理解释）权重固化为 3，移除「待确认」标注。单独命中为 27 分（绿区上沿），与其他红旗组合才进黄区。

### 提交包精简（P1）

- 新增 `scripts/build_submission.mjs` 与 `submission.manifest.json`，生成 `dist/submission/` 精简提交包：27 个文件、约 213 KB（限制 ≤28 文件 / ≤40 MB），构建时自动检查文件数、体积与相对路径有效性。
- 数据源合并为 `data_sources.md`（全球通用入口 + 采集清单 + 16 国资料），A1–A14 合并为 `tests/cases.json`；`tests/run_cases.mjs` 同时支持仓库分文件用例与精简包 `cases.json`。
- 红旗总数统一为 22 条（`red_flags.md`、README、`SKILL.md`），并加入 `tests/consistency.mjs` 校验，文档数字不一致时 CI 直接失败。
- CI 增加精简包构建（S1）、包内测试（S2）与包内隐私扫描（S3）。

### 新增：ip_check 邮件来源 IP 分类（功能 A）

- `scripts/ip_check.py/.mjs`：无 IP / 私网 / 回环 / 保留地址跳过；网页邮箱等邮件服务商中继与机房 / 云 / 匿名化网络不做国家比对；公网 IP 默认离线，仅用户显式 `--online` 时查询公开 RIR RDAP。
- 输出只含脱敏网段（IPv4 /24、IPv6 /48）、分配国、ASN、组织与网络类型，**不保存完整 IP**；国家不一致只作线索，至少两个独立字段矛盾才计入 `RF-CORP-001`。
- `scripts/ip_ranges.json` 只收录 2026-10-27 经 RIR RDAP autnum 核实的邮件服务商与云网络 ASN；查不到保持 unknown。
- 验收 G1–G6：`tests/ip_check_cases.mjs` + `tests/fixtures/ip-rdap-sample.json`；Python/Node 一致性加入 `tests/consistency_scripts.mjs`；CI 增加对应步骤。
- `SKILL.md` 接入邮件头步骤与证据包可选 `ip_origin`；`red_flags.md` 的 `RF-CORP-001` 细则补充「至少 2 个独立字段」与排除条件；`card_template.md` 增加字段说明。

### 增强：phone_check 可选号码类型/运营商/时区（功能 B）

- 可选依赖 `phonenumbers`（Python，Apache-2.0，9.0.41）与 `libphonenumber-js`（Node，MIT，1.13.15），**不列为必需依赖**；未安装时输出与 v0.6.0 完全一致。
- 安装后增加 `number_type`、`carrier`、`carrier_note`、`timezones`、`enriched_by`；运营商标注「携号转网后可能不同，仅供参考」。
- 虚拟号（VOIP）、高费率、免费号码只作线索，**不新增红旗、不改评分与等级**；`RF-CORP-005` 不变。
- 修正基础解析：输入不带 `+` 或 `00` 时不再按 ITU 表猜测国家，统一返回「international prefix required；不猜国家」（H3）。
- 验收 H1–H5：`tests/phone_check_enrich_cases.mjs`；Py/Node 一致性只比较基础字段，增强字段按文档允许存在差异；CI 增加步骤。

## [0.6.0] - 2026-10-23

订单前复核与可持续运营（F1–F5 验收全过）。

### 新增：收款账户校验 account_check（F2）

- `scripts/account_check.py/.mjs`：IBAN 结构与 **mod-97 校验位自实现**（ISO 13616 公开算法，不引入第三方库）+ 常用国外贸国 IBAN 长度表（未知国家长度输出 unknown 不猜测）+ BIC/SWIFT 解析（银行代码/国家/地点/分支）+ 三重国别链比对（IBAN 国 vs BIC 国 vs 买家自称国）。
- **账号永不存储、输出只含脱敏形式**（前 4 + 后 4）；`tests/account_check_cases.mjs` 覆盖经典合法样例（GB82）、篡改校验位、错误长度、运行时构造合法 AE 样例、BIC/IBAN 国不一致、账户国 vs 自称国不一致（RF-ACC-002 输入），全部 Py/Node 一致。

### 新增：RF-ACC-002 红旗（21 条）

- 收款账户国与买家国不一致且无合理解释（建议权重 3，**待负责人确认**）：account_check 报告事实，模型衡量合理解释（集团财务集中/自贸区主体 + 授权文件）后才计分；无解释或含糊其辞按无解释处理。评测集同步补 1 正例 2 反例（含可验证合理解释的反例）。

### 新增：订单前复核流程（F1，SKILL.md 模块 7 落地）

- 四步：执照核验（按国家能力矩阵给链接+清单，不自动抓取）→ 官网税号/登记号与执照一致性比对 → `account_check` 收款账户校验 → 收款安全建议（**优先平台担保订单 / L/C / 第三方托管**；账户变更双确认；第三方收款需授权证明）。report_template 收款建议同步更新。

### 新增：数据源保鲜 check_sources（F3）

- `scripts/check_sources.mjs`：从国家能力矩阵与 data-sources/*.md 收集 URL，串行 + 延迟做**可达性探测**（单次请求、不读正文、遵守 robots.txt 保守精神；429 容忍）；非 2xx/3xx 列入失效清单。`tests/check_sources_cases.mjs` 用本地临时 HTTP 服务验证 200/404/拒连三分支与收集器（注：跨进程回环 fetch 在沙箱环境被拦截，测试采用同进程 probe 调用）。

### 新增：CI（F4）

- `.github/workflows/ci.yml`：push/PR 上自动运行全部用例（A1–A14、V5/V6、E3、F2、F3、E4、privacy_scan），Python 3.12 + Node 20 双环境。

### 新增：国家扩展至 16 国（F5）

- 卡塔尔/阿曼/科威特/巴林/印尼/菲律宾/柬埔寨 7 国以**骨架条目**加入（机构名 + URL null + verification: unverified——本轮检索未定位官方入口，按「未知不猜测」纪律处理）；`data-sources/countries/<iso2>.md` 同步建页。矩阵 16/16 条目全部标注核实来源（F5 通过）；not_yet_surveyed 清空。

### 文档

- SKILL.md frontmatter version 0.6.0、脚本表补 account_check/check_sources；red_flags.md 21 条；README/development.md 同步。

## [0.5.0] - 2026-10-23

可信度与全球化：七块交付物（E1–E8 验收全过）。

### 新增：行为评测集（E4）

- `tests/eval/inquiries.jsonl`：42 条合成询盘语料（11 条正常买家反例；每条文本可判红旗 ≥1 正例；全合成、无真实客户数据；英文为主含中文）。
- `tests/eval/score_eval.mjs`：对照期望输出每条红旗召回率/精确率/误报率与正常条目误报率；`--self` 自检模式（回归保护）。
- `tests/eval/predictions.example.json`：预测文件格式示例。

### 新增：证据包与双模式输出（D4/D5/D6）

- `card_template.md`：结论卡版式（首行颜色+等级+分数、10 格分数条、灰▒、≤5 风险点、≤3 话术英文+中文）、证据包 JSON Schema（checks[].result 含 not-covered/skipped-login；anchors.closure 四档）、追问话术规则与话术库（D6/D13：委婉含蓄、询盘期不索要执照）。
- SKILL.md 输出改为双模式：结论卡默认只显示不落盘；完整报告按需写入 `reports/`；同一证据包渲染保证一致性（E1）；支持增量复核。

### 新增：三个全球通用脚本（E3，Python + Node 双实现，tests/consistency_scripts.mjs 保证输出一致）

- `phone_check.py/.mjs` + `phone_check_data.json`：本地 ITU E.164 区号表解析国别/有效性/线路类型/与自称国一致（零依赖，未知的线路类型输出 unknown 不猜测）。
- `email_header_check.py/.mjs`：原始邮件头解析（From/Reply-To/Return-Path、Received 链、SPF/DKIM/DMARC、发送时区、来源 IP 隐藏时填 null），对应 RF-MAIL-001。
- `sanctions_check.py/.mjs` + `update_sanctions.py/.mjs`：官方名单本地匹配（OFAC SDN 直链可下载至 .cache/；EU/UN/OFSI 标 not_configured 不猜测）；同名一律 requires_manual_review。

### 新增：核实体系落地与采集清单（D7/D8/D9）

- SKILL.md 工作流程改写：身份链四类节点与闭合度四档 → 置信度；能力探测三档（one-shot/semi-auto/manual）；登录规则与 LinkedIn 私密模式提醒；「名称+电话」起手流程 5 步（含回流与补一条信息）；防伪造规则（新注册官网不算验证）。
- `data-sources/collection_checklists.md`：WhatsApp 商业资料/Facebook 透明度/LinkedIn/地图/海关五份「看什么、回传什么」清单。

### 新增：新红旗 8 条（13→20，全部积极矛盾才计分，D7）

- RF-ID-001 头像盗用(3)、RF-ID-002 职业资料与自称不符(3)、RF-ID-003 账号新建且无活动(2)、RF-CORP-002 地址与自称不符(2)、RF-CORP-003 商家电话不一致(2)、RF-CORP-004 海关记录与询盘不符(2)、RF-CORP-005 号码国家与自称不符(2)、RF-NEG-002 询盘话术指纹命中(3)；ID 类别登记；评测集同步补 8 条正例语料。

### 新增：国家适配层与试点国家（D10/D11/D12）

- `scripts/country_capabilities.json`：国家能力矩阵（注册库入口/免费情况/英文/自动化许可/海关/地图/last_verified/verification；未知填 null 不猜测；含 us/mx/cn 常用国）。
- `data_sources.md` 拆分为 `data-sources/global.md`（全球通用入口）+ `data-sources/countries/<iso2>.md`（sg/my/th/vn/ae/sa 六国试点，均标注 secondary-source 待官方核实）；运行时先查矩阵再决定维度，无覆盖跳过、标注 not-covered、不扣分。

### 新增：低成本通用核实手段（D9）

- 图片反搜（链接+清单，业务员回传）、询盘话术指纹（特征句加引号联网检索）、证书透明度（whois_lookup 可选字段，不可用 null）、官网页脚税号/登记号（记入证据包供订单前核验）。

### 验收用例

- A10 中档分数区间与等级一致；A11 名称+电话起手 → 需人工核实（预期）；A12 权重5+锚点全缺 → 仍「高」附低置信度标注；A13 未登录跳过不扣分（invariance）；A14 国家无覆盖跳过不扣分（invariance）。runner 新增 invariance 类型。
- 全量：A1–A14（14/14）+ V5 全组合区间不变式 + V6 评分双语言一致 + E3 三脚本双语言一致 + E4 评测集自检 + privacy_scan 全绿。

### 文档

- README/SKILL.md/development.md 同步 v0.5.0 结构与 20 条红旗口径；SKILL.md frontmatter version 0.5.0。

## [0.4.1] - 2026-10-23

卫生版：隐私清理、分数口径修正、文档同步（不新增功能）。

### 隐私清理

- 从仓库移除真实客户背景调查报告文件，历史版本清理清单已提供（由仓库所有者执行强制推送）；本地报告移入 `reports/`（不入仓库）。
- `.gitignore` 重写：新增 `.env`、`*.key`、`*.pem`、`reports/`、`*.evidence.json`、`.cache/`；删除写死的客户文件名；保留 `report_*.md` 通配（`report_template.md` 除外）。
- Skill 报告默认输出目录改为 `reports/`，文件命名规则不变。
- SKILL.md 新增「个人姓名、邮箱、电话默认脱敏显示」等边界约束。
- 新增 `scripts/privacy_scan.mjs`：扫描邮箱、国际号码、证件号格式，命中时列出文件与行号并以非零状态退出；白名单覆盖合成样例。

### 分数口径修正（区间与等级对齐）

- 新公式：低 = 9×T（0–29 绿）；中 = 35+8×(T−4)（30–59 黄）；高 = max(权重5时 70, min(100, 65+5×max(0,T−8)))（60–100 红）；需人工核实按 T 对应等级公式照常计算，灰色显示。一条「先付款」（T=5）得 70 分落红区，与等级「高」一致。
- **等级优先级修正**：已达高分档（T≥8 或权重 5 红旗）时永远显示「高」（置信度低附加标注，防止严重信号被灰色掩盖）；其余情况身份锚点全缺才显示「需人工核实」。
- 更新 `scripts/risk_score.py` / `.mjs` / `red_flags.json` / `report_template.md` / `examples/sample-report.md` 与用例 A1、A8 预期值。
- 新增 `tests/consistency.mjs`：V5 遍历全部 8192 种红旗组合验证区间不变式；V6 验证 Python 与 Node 评分输出完全一致。

### 文档同步

- README：红旗数 13、验收用例 A1–A9；赛事对照表移至 `docs/development.md`；新增「边界与硬性约束」与「数据不外传」声明。
- SKILL.md：frontmatter 增加 `metadata.version`；自检清单对齐五个检查模块；测试范围 A1–A9；硬性约束按边界文档全量扩充。
- `docs/development.md`：与 v0.4.x 对齐（模块名、两阶段模型、13 条红旗、A1–A9），顶部注明迭代方案以 `docs/iteration_plan.md` 为准。
- 新增 `docs/iteration_plan.md`：v0.4.1–v0.6.0 迭代方案定稿。
- `data_sources.md`：「公司名搜不到」的降级做法改为两阶段模型表述（询盘期不索要执照，「需人工核实」以身份锚点全缺为准）。

### 提交规范

- 此后提交使用英文 Conventional Commits，scope 用模块名（如 `fix(score): align risk score bands with levels`）。

## [0.4.0] - 2026-10-22

对齐外贸真实业务流程：两阶段模型（询盘期背调 → 订单前复核）。

### 变更（核心）

- **身份锚点重新定义**：从「公司注册/官网域名/企业邮箱」改为**询盘期可公开验证**的三项——公司名公开痕迹（检索到官网/LinkedIn/名录）、企业邮箱（域名与公司名匹配）、官网域名。**营业执照不再作为询盘期锚点**——询盘初期拿不到执照是外贸常态，此前设计会导致所有初期客户误判「需人工核实」，报告失去区分度。
- **置信度规则简化**：高（锚点≥2）/ 中（锚点=1）/ 低（锚点=0，强制「需人工核实」）。
- 检查点 1 由「公司注册信息」改为「公司名公开痕迹」（询盘期可执行）。

### 新增

- **两阶段模型**（red_flags.md / SKILL.md / 模板）：询盘期背调（主场景，输入=聊天记录/姓名/手机号/邮箱/公司名，输出=跟进分级：正常跟进/谨慎跟进/停止投入）与订单前复核（二阶段，输入=执照/PO/银行信息，输出=收款安全建议）。
- **话术两阶段拆分**：询盘期话术只索要官网/企业邮箱（不索要执照）；订单前话术才索要执照与双确认收款变更。
- **信息缺口两分法**（模板 §1.2）：「询盘期正常缺失」（执照/PO/银行信息，不降置信度）vs「影响判断的缺失」（公司名等）。
- 验收用例 A9：询盘标配信息（公司名痕迹+企业邮箱=锚点2）→ 置信度高 + 等级低（正常跟进）——验证新体系区分度。

## [0.3.0] - 2026-10-22

专业尽调版报告（Kroll/D&B 风格）：报告编号体系、执行摘要三段式（评分卡/核心结论/行动指令）、全量红旗计分表（13 项含未命中证据）、置信度判定链、证据编号体系（E-01…E-NN）、附录 A/B。修复 `.gitignore` 误伤 `report_template.md` 从未入库的缺陷。

## [0.2.1] - 2026-10-22

报告可读性升级：重点前置 + 评分规则透明化。

### 新增

- **⚡结论速览**章节（报告开头 10 秒版）：可视化分数条 + 等级 + 一句话行动建议 + 🔴🟡🟢🔵 四色关键要点（含「已排除的怀疑点」）。
- **「评分怎么来的」阅读指南**章节：风险分公式、区间对照表、覆盖率/置信度指标解释。
- `examples/sample-report.md` 升级为完整七段结构（高危示范）。

### 变更

- 报告章节统一为：结论速览 → 评分规则 → 评分明细 → 风险点全览 → 红旗详单 → 核查概览 → 建议下一步 → 免责声明。
- `report_template.md` 同步新结构；两份实战报告重排为示范版（后于 0.4.1 移出仓库，本地存档于 `reports/`）。

## [0.2.0] - 2026-10-22

报告与打分体系升级：完整报告 + 数值化打分。

### 新增

- **0–100 风险分**（初版公式，0.4.1 已改为区间对齐分段公式），与等级并列展示，由 `risk_score.py/.mjs` 确定性计算。
- **信息覆盖率与置信度**：8 个核心检查点 + 3 个身份锚点；置信度低时等级强制「需人工核实」，分数标注仅供参考。
- **RF-BEH-003 仅社交媒体/IM单一渠道**（权重 2）：仅 WhatsApp/Telegram 联系且无正式渠道时命中。
- **背景风险提示**（不计分）：CR-GEO-001 国家风险背景、CR-NAME-001 主体唯一性，列入风险点全览。
- **报告模板新结构**：风险分/等级/覆盖率置顶 → 8+ 检查点逐项状态全览表（✅/⚠️/❓，不遗漏）→ 命中红旗详单 → 核查概览 → 建议 → 免责。
- 验收用例 A8（单一渠道+信息匮乏场景）。

### 变更

- `tests/run_cases.mjs` score runner 支持 `covered`/`anchors` 参数与 `risk_score`/`confidence` 断言。

## [0.1.1] - 2026-10-22

与 2026 华为开发者大赛·小红书 Skill 创新赛要求对齐。

### 新增

- 赛事对齐章节（赛道归属、评审五维、提交核对、双市场发布流程），后于 0.4.1 从 README 主体移至 `docs/development.md`。

## [0.1.0] - 2026-10-21

MVP 首个版本。

### 新增

- `SKILL.md`：触发条件、5 步流程（采集 → 并行检索 → 交叉比对 → 评分 → 报告）、硬性约束、完成前自检清单。
- `red_flags.md`：12 条红旗清单（编号 `RF-<类别>-<序号>`）、判断细则、权重与四级等级划分。
- `data_sources.md`：RDAP/WHOIS、DNS、负面信息、制裁名单等公开入口，以及查不到时的降级做法。
- `report_template.md`：报告固定结构、追问话术模板、按等级的收款建议、措辞规范与文件命名规则。
- `scripts/whois_lookup.py` / `.mjs`：域名注册信息与 DNS 查询，支持 `--rdap-json` 离线 fixture。
- `scripts/domain_similarity.py` / `.mjs`：仿冒域名识别（同形字符、编辑距离、连字符、换后缀）。
- `scripts/risk_score.py` / `.mjs`：确定性评分与敏感信息脱敏。
- `scripts/red_flags.json`、`scripts/brands.json`：机器可读红旗表与知名品牌域名清单。
- `tests/`：验收用例 A1–A7 及离线运行器 `tests/run_cases.mjs`。
- `examples/sample-report.md`：脱敏样例报告。
- `docs/development.md`：开发文档。
- `README.md`、`LICENSE`（MIT）、`.gitignore`。

### 设计说明

- 评分只依据 `red_flags.md` 与 `red_flags.json`，不依赖模型临场判断，保证可复现。
- Python 与 Node 双实现，逻辑同构，便于在无 Python 环境时验证。
- 查不到信息时统一输出「未查到」或 `status: "unavailable"`，不编造。

### 计划中（后续由迭代方案接管）

- v0.5.0：结论卡与双模式输出、三个全球通用脚本、行为评测集、国家适配层。
- v0.6.0：注册库接入、收款账户校验、社区贡献机制、数据源保鲜。