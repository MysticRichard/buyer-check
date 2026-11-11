# 结论卡与证据包规范（card_template.md）

本文件定义 `buyer-check` 的双模式输出：**一次检索只产生一份证据包；结论卡与完整报告都从同一份证据包渲染**（E1：两者等级、分数、命中红旗完全一致）。v0.5.0 起 SKILL 按本文执行。

## 一、双模式输出（D4、D5）

| 模式 | 触发 | 落盘 | 内容 |
| --- | --- | --- | --- |
| **结论卡（默认）** | 每次检索自动输出 | **只显示、不落盘** | 风险分+核实度、覆盖行、结论、动作阶梯、六维表、三栏风险点、一次动作、≤3 条话术、补充建议 |
| **完整报告（按需）** | 用户说「出完整报告」 | 写入 `reports/<slug>_<YYYYMMDD>.md` | 按 `report_template.md` 专业尽调体例 |

**证据包**是唯一事实源：默认只在内存/临时目录；用户要完整报告时才随报告写入 `reports/<slug>_<YYYYMMDD>.evidence.json`（同样脱敏）。

**增量复核**：业务员回传客户回复或补充信息后，只更新变化的维度并重新出卡；可再追加最多 3 条话术。

## 二、证据包 JSON Schema

```json
{
  "subject": {
    "company": "ACME TRADING LTD",
    "person": "d***e",
    "phone": "+971 5* *** 1234",
    "email": null,
    "domain": null,
    "country": "ae"
  },
  "stage": "inquiry",
  "capability_tier": "semi-auto",
  "checks": [
    { "id": "dom-age", "dimension": "domain", "result": "suspicious", "evidence_ids": ["E-01"] }
  ],
  "evidence": [
    { "id": "E-01", "source_url": "https://rdap.org/domain/example.com", "retrieved_at": "2026-10-23T10:05:00Z", "summary": "registered 23 days ago" }
  ],
  "flags": [
    { "id": "RF-DOM-002", "weight": 3, "evidence_ids": ["E-01"] }
  ],
  "anchors": { "closure": "none" },
  "coverage": {
    "checked": 5,
    "total": 8,
    "uncovered": [
      "map:not-covered:needs-browser",
      "customs:not-covered:no-matrix",
      "social:skipped-login:login-required"
    ]
  },
  "confidence": "low",
  "score": { "total": 3, "risk_score": 27, "level": "低" },
  "checks_incomplete": [
    { "check": "sanctions", "reason": "download-failed", "next_step": "在 OFAC 官方站按公司名手动查一次" }
  ]
}
```

**字段规则**：
- `subject` 中人名、电话、邮箱一律脱敏（`d***e`、`+971 5* *** 1234`）。
- `checks[].result` 取值：`normal` / `suspicious` / `unverifiable` / `not-covered`（该国无覆盖，跳过不扣分）/ `skipped-login`（未登录 LinkedIn/Facebook，跳过不扣分）。
- 可选检查 `ip_origin`（v0.7.0）：`result` 取 `consistent` / `inconsistent` / `skipped` / `not-covered`；只写脱敏网段（IPv4 /24、IPv6 /48）、分配国、ASN 与网络类型，**不写完整 IP**；不纳入 8 个覆盖率检查点，旧证据包可以不含此项。
- `anchors.closure` 取值：`none`（未锚定）/ `single`（单点线索）/ `bidirectional`（双向闭合）/ `independent`（独立来源确认，标注「已独立验证」）。
- `capability_tier`：`one-shot`（一步到位）/ `semi-auto`（半自动）/ `manual`（纯人工），按能力探测三档写入。
- `stage`：`inquiry` / `pre-order`。
- 证据条目必须含 `source_url` 与 `retrieved_at`；没有来源的发现不得进入 `evidence`。
- 8 个覆盖率检查点固定为：`company`（公司名痕迹）/ `domain`（域名与官网）/ `email`（邮箱与邮件头）/ `phone`（电话）/ `negative`（负面信息）/ `sanctions`（制裁）/ `map`（地图）/ `customs`（海关与注册库）；`coverage.total` 固定为 8。
- 社媒 `social`（LinkedIn / Facebook / WhatsApp）为附加项，不计入 8 个分母，但必须出现在 `coverage.uncovered` 与结论卡覆盖行。
- `coverage.uncovered` 为**必填数组**，列出所有未执行/未覆盖项，格式 `"<checkpoint>:<result>:<reason>"`：
  - `result`：`not-covered`（该国/该维度无覆盖）/ `unverifiable`（工具或检索受限）/ `skipped-login`（未登录跳过）。
  - `reason`：`needs-browser`（地图需浏览器/JS）/ `no-matrix`（该国不在能力矩阵）/ `no-free-data`（无免费公司级数据）/ `login-required`（社媒需登录）/ `not-provided`（用户未提供，如邮件头/电话）/ `search-blocked`（检索被验证码或限流拦截）/ `no-public-record`（已实际查询但公开无记录）/ `login-wall`（公共页被登录墙拦截）/ `no-company-level-data`（该国无公开公司级数据）/ `no-double-match`（社媒名称+电话/域名未双匹配）/ `name-only-match`（仅同名，不能算真实）。
  - 没有未覆盖项时为空数组 `[]`；**不得省略字段**。
- 可选 `checks_incomplete`（v0.9.1）：任何应跑但没跑完的检查写入 `{check, reason, next_step}`；`check` 取 `sanctions` / `registry` / `search` / `map` / `other`，`reason` 取 `no-network` / `download-failed` / `invalid-content` / `all-urls-failed` / `login-wall` / `timeout` / `stale`；`next_step` 必填且 ≤40 字。卡片覆盖行下方输出一行「⚠ 本次未完成：…」，覆盖分子减去对应检查、分母仍为 8；标题追加「· 有 N 项未完成」。旧证据包不带该字段时渲染结果与 v0.9.0 完全一致。
- 证据强制（v0.9.1）：证据包一旦带 `evidence`，`display.attention[]` 与 `display.verified[]` 每条必须带 `evidence_ids`，每个编号必须真实存在且带 `url` + `retrieved_at`；缺编号、假编号、重复编号自动移入「没查到」并加「（缺证据）」，返回 `evidence_missing` 计数。`source_type: user_input` 可无 URL，但只能留在「需要注意」，不能进「已核实」。旧证据包不带 `evidence` 时不做强制。
- **官网匹配可作为 🟢 正向证据**（不占红旗、不计分）：写明官网域名、官网 Contact 的姓名/电话是否与客户一致；邮箱域名与官网不同时标「待确认」，不直接判伪。
- 平台边界项（登录/验证码/付费）必须在卡片给**可点击链接 + 一次动作说明**；不能只写 `not-covered`。
- 可选 `layers`（v0.8.0，旧证据包可不带）：
  - `company`: `credibility`（high/medium/low/unknown）、`official_social[]`（platform/url/link_type=mutual|name-only）、`main_business_matrix[]`（source=website|facebook|linkedin_company|customs、keywords、verdict=consistent|partial|different|not-checked）、`map_scale`（verdict=matched|small|residential|unknown、street_view_date）。
  - `person_company_link`: `strength`（strong/medium/weak/none/contradiction）、`evidence[]`（type=S1-S4|M1-M3、url、retrieved_at、method=auto|browser|user-reported）。
  - `person_authenticity`: `level`（high/medium/low/unknown）、`avatar`（auto_result=same-image|near-duplicate|different|not-comparable|reverse-hit-other、human_verdict=same-person|different|unsure|null、links[]）、`account`（span_years、thickness=thick|normal|thin|unknown、recently_modified）。

### 2.1 intake 与 display（v0.9）

**`intake`（模型抽取）**：`company`、`person`、`email`、`domain`、`phone`、`country`、`city`、`product`、`quantity`、`amount`、`inquiry_text`、`inquiry_type`、`best_next`。`inquiry_type` 取 `tender` / `sample` / `large_first_order` / `account_change` / `pre_order` / `general`；缺失写 `null`。不追问规则见 `SKILL.md` 第 0 步（只要公司名/域名/邮箱/电话/社媒任一存在就开始）。

**`display`（模型填文字，脚本渲染）**：`customer_label`、`inquiry_type`、`dim_notes{company, link, contact, behavior, compliance, scale}`、`attention[]`、`verified[]`、`missing[]`、`open_questions[]`、`scripts[]`。

**校验规则**：`customer_label`/`inquiry_type` ≤40 字；`dim_notes.*` 已查项必填、每项 ≤28 个汉字；`attention`/`verified`/`missing` ≤3/3/2，每条 `text` ≤30 个汉字；`attention[].kind` 取 `flag`/`clue`，`flag` 必须给 `flag_id` 且能在 `flags` 找到；`missing[].action` 四个字段齐全，`url` 为 http/https 或 `null`；`scripts` ≤3；`open_questions` 每条 ≤12 个汉字、≤3 条；所有文字不含技术词、禁用词、完整手机号和完整邮箱。

## 三、结论卡版式（v0.9 硬性规则）

**版式自上而下：**

```text
[1] 标题行      ## 颜色 等级 · 风险 N/100 分数条 ｜ 核实度 M/100（高/中/低）· 有 N 项未完成
[2] 覆盖行      置信度：x（锚点 n/3）｜覆盖：X/8｜未覆盖：…
[2a] 未完成行   ⚠ 本次未完成：<检查>未完成（<原因>）→ <下一步>
[3] 结论行      **结论：一句话。** 客户：名称（国家/城市）· 询盘类型
  ——— 以上加 [4] 为第一屏 ———
[4] 动作阶梯    表：动作 | 建议 | 条件（4 行）
[5] 六维表      表：维度 | 状态 | 依据（6 行）
[6] 三栏        需要注意（≤3）/ 已核实（≤3）/ 没查到（≤2）
[7] 一次动作    每个“没查到”配一行：▸ 项目 — 链接：做什么
[8] 追问话术    ≤3 条，英文加一句中文含义
[9] 末行        补充建议一句 + 免责声明
```

| 规则 | 取值 |
| --- | --- |
| 整卡行数 | ≤45 行（含表格行）；第一屏 [1]–[4] 含未完成行 ≤14 行 |
| 未完成行 | `checks_incomplete` 非空时输出一行，位于覆盖行下方；覆盖分子减去对应检查，分母仍为 8 |
| 标题 | 二级标题；🟢 低（0–29）/ 🟡 中（30–59）/ 🔴 高（60–100）/ ⚪ 需人工核实 |
| 分数条 | 10 格，填充数 `floor(风险分 / 10 + 0.5)`；`■` 已填、`□` 未填；需人工核实全部 `□` |
| 核实度 | 标题行只写数字和档位，不画条；公式见 `SKILL.md`/`report_template.md` |
| 分隔符 | 覆盖行沿用全角竖线 `｜`；表格用标准管道表格 |
| 禁用 | HTML、颜色代码、`U+2593 U+2591 U+2592` 旧分数条字符、代码块包裹整张卡 |
| 语言 | 默认中文；英文话术保留英文；客户原文/公司名保留原样 |
| 脱敏 | 人名、电话、邮箱沿用 v0.8.0 规则；卡片不出现完整号码和完整邮箱 |

**动作阶梯（只显示，不改风险分/等级）**

| 动作 | 规则（从上到下，第一条命中即停） | 条件文字 |
| --- | --- | --- |
| 回复和报价 | L=高 → ⚠️；其余 → ✅ | ⚠️：只做标准报价，不发定制方案 |
| 寄样和小额投入 | L=高 → ⛔；CL 或 L=需人工核实 → ⚠️；L=中 → ⚠️；L=低且 V=低 → ⚠️；L=低且 V=中/高 → ✅ | ⚠️：先补核实（见一次动作）；✅：留空 |
| 定制和大额备货 | L=高、L=需人工核实、CL、V=低 → ⛔；L=中 → ⚠️；L=低且 V=中 → ⚠️；L=低且 V=高且 CP=是且 Q 为空 → ✅；其余 L=低且 V=高 → ⚠️ | ⚠️：先确认 + Q 前两项；CP=否：先补制裁名单检查 |
| 收定金和付款 | PA 或 L=高 → ⛔；S=pre-order 且 AC=通过 且 L 不是高 → ✅；其余 → ⛔ | ⛔：先做订单前复核（执照和收款账户）；✅：仍需电话回拨确认账户 |

**结论句模板（从上到下取第一条）**

| 条件 | 结论句 |
| --- | --- |
| L=高 | 先不要投入：不寄样、不垫付、不付款。 |
| 寄样 ✅ 且 定制 ✅ | 可以正常推进，收款前先做订单前复核。 |
| 寄样 ✅ 且 定制 ⚠️ | 可以报价、寄样；定制或大额备货前，先{定制条件}。 |
| 寄样 ⚠️ | 可以先报价；投入前先{寄样条件}。 |
| 其他 | 信息还不足：先报标准价，不要投入。最值钱的补充：{第一项未覆盖项}。 |

**六维表**

| 维度 | 状态词（按完成度） | 条形 |
| --- | --- | --- |
| 公司真实度、买家与公司的关联、联系方式、合规口碑、规模匹配 | 1.0–0.9 已核实；<0.9–0.6 基本核实；<0.6–0.3 部分核实；<0.3 未核实；矛盾：有矛盾 | 5 格，`floor(完成度×5+0.5)` 填充 `■`，其余 `□` |
| 交易行为 | 命中 RF-PAY-*/RF-ACC-*/RF-BEH-* 任一 → 有异常；没命中且有询盘原文 → 无异常；没提供原文 → 未核实 | 不画条，用 `—` |

状态符号：已核实/基本核实 ✅；部分核实 🟡；未核实 ❓；有矛盾/有异常 ⚠️；无异常 ✅。顺序固定：公司真实度、买家与公司的关联、联系方式、交易行为、合规口碑、规模匹配。人物真实度写进“买家与公司的关联”的依据里。

**三栏风险点**

| 栏 | 放什么 | 上限 | 符号 | 排序 |
| --- | --- | --- | --- | --- |
| 需要注意 | 命中的红旗（名称+编号）、待确认项、规模偏小/账号近期改动等线索 | 3 条，超出写“另有 N 项，见完整报告” | 🔴 权重≥4，🟡 权重≤3/线索 | 权重从大到小，同权重按编号 |
| 已核实 | 有来源的正向证据和已排除项 | 3 条 | 🟢 | 公司层→链接层→联系方式→合规 |
| 没查到 | 已查过但公开网络无结果，或没能检查 | 2 条 | ⚪ | 信息增益最大的在前 |

“需要注意”为空写一行“未发现需要注意的信号”；“没查到”栏标题必须带“没查到不代表没问题”。每条 ≤30 个汉字，红旗保留编号。

**一次动作**

“没查到”里需要人做一次动作的项，在三栏下单独列：`▸ 项目 — [链接文字](url)：做什么、回传什么`。最多 4 行，按信息增益排序（地图/注册库在前，领英/Facebook 在中）。链接模板来自 `data-sources/global.md` 与 `collection_checklists.md`，不硬编码。人只需：登录一次、过一次验证码、回传一句话。

**写作规则**：只填 `display` 文字字段，不自己排版、不算数字；一句话一个事实；不出现 `card_template.md` 第五节技术词和禁用词；每条话术只索取一样东西。

## 四、结论卡样例

### 4.1 低风险（虚构示意）

```markdown
## 🟢 低风险 · 风险 0/100 □□□□□□□□□□ ｜ 核实度 90/100（高）
置信度：高（锚点 3/3）｜覆盖：7/8｜未覆盖：地图（没找到商家）
**结论：可以报价、寄样；定制或大额备货前，先确认西门子是否强制、项目地点。** 客户：Harbor Rim Engineering（新加坡 / 巴淡岛） · 招标邀请

| 动作 | 建议 | 条件 |
| --- | --- | --- |
| 回复和报价 | ✅ 可以 | |
| 寄样和小额投入 | ✅ 可以 | |
| 定制和大额备货 | ⚠️ 有条件 | 先确认西门子是否强制、项目地点 |
| 收定金和付款 | ⛔ 不建议 | 先做订单前复核（执照和收款账户） |

| 维度 | 状态 | 依据 |
| --- | --- | --- |
| 公司真实度 | ✅ ■■■■■ 已核实 | 官网 2015 年注册，领英和 Facebook 页互相指向 |
| 买家与公司的关联 | ✅ ■■■■■ 已核实 | 领英现任职 Harbor Rim Engineering，职位和询盘吻合 |
| 联系方式 | ✅ ■■■■■ 已核实 | 官网电话与客户一致，邮箱域名等于官网 |
| 交易行为 | ✅ — 无异常 | 没要求先付款，没要求换收款账户 |
| 合规口碑 | ✅ ■■■■■ 已核实 | 制裁名单无匹配，公开检索没发现投诉 |
| 规模匹配 | ❓ □□□□□ 未核实 | 地图没找到商家，海关公开库无记录 |

**需要注意**
- 🟡 招标信息待确认：西门子是否强制，项目在巴淡岛还是新加坡

**已核实**
- 🟢 官网电话和客户一致，邮箱域名等于官网域名
- 🟢 域名已使用 11 年，没发现钓鱼或投诉记录
- 🟢 制裁名单没有匹配

**没查到（没查到不代表没问题）**
- ⚪ 地图上没找到这家公司
- ⚪ 海关公开库没有记录

**一次动作**
▸ 地图 — [在 Google 地图搜 Harbor Rim Engineering](https://www.google.com/maps/search/Harbor+Rim+Engineering+Batam)：看建筑规模和门口有没有招牌，回传“吻合 / 偏小 / 住宅”

**建议这样回复（任选）**
1. Could you confirm whether Siemens is mandatory or an equivalent brand is acceptable?
   请确认西门子是否强制，或是否接受同等品牌。
2. Could you confirm whether the project site is Batam or Singapore?
   请确认项目地点是巴淡岛还是新加坡。

补充地图结果后核实度可达 95。需要完整报告请回复“出完整报告”。
仅为基于公开信息的风险提示，不构成法律意见。
```

### 4.2 高风险（虚构示意）

```markdown
## 🔴 高风险 · 风险 85/100 ■■■■■■■■■□ ｜ 核实度 10/100（低）
置信度：低（锚点 0/3）｜覆盖：6/8｜未覆盖：地图（需浏览器）、社媒（未登录）
**结论：先不要投入：不寄样、不垫付、不付款。** 客户：NORDIC IMPORT AB · 询盘（要求先付验厂费）

| 动作 | 建议 | 条件 |
| --- | --- | --- |
| 回复和报价 | ⚠️ 有条件 | 只做标准报价，不发定制方案 |
| 寄样和小额投入 | ⛔ 不建议 | |
| 定制和大额备货 | ⛔ 不建议 | |
| 收定金和付款 | ⛔ 不建议 | |

| 维度 | 状态 | 依据 |
| --- | --- | --- |
| 公司真实度 | ⚠️ □□□□□ 有矛盾 | 官网域名和自述域名仅差一字，且注册仅 23 天 |
| 买家与公司的关联 | ❓ □□□□□ 未核实 | 邮箱用的是这个可疑域名，官网上找不到此人 |
| 联系方式 | ⚠️ □□□□□ 有矛盾 | 域名没有收信设置，“企业邮箱”收不了信 |
| 交易行为 | ⚠️ — 有异常 | 要求先付 500 美元验厂费 |
| 合规口碑 | ✅ ■■■■■ 已核实 | 制裁名单无匹配，公开检索没发现投诉 |
| 规模匹配 | ❓ □□□□□ 未核实 | 地图和海关都没查到 |

**需要注意**
- 🔴 要求先付款（RF-PAY-001）：对方要求先付 500 美元验厂费
- 🔴 仿冒域名（RF-DOM-001）：和自述官网仅差一个字符
- 🟡 域名过新（RF-DOM-002）：注册只有 23 天

**已核实**
- 🟢 制裁名单没有匹配，公开检索没发现投诉

**没查到（没查到不代表没问题）**
- ⚪ 公司注册记录和地图商家页，都没找到

**一次动作**
▸ 地图 — [在 Google 地图搜 NORDIC IMPORT AB](https://www.google.com/maps/search/NORDIC+IMPORT+AB)：看建筑规模和门口有没有招牌

**建议这样回复（任选）**
1. Thanks for your interest. In our process, factory visits are arranged after the order is confirmed. Could you tell me the product model and quantity you have in mind?
   感谢关注。我们的流程是下单确认后再安排验厂。方便告诉我型号和数量吗？

不要垫付任何费用。需要完整报告请回复“出完整报告”。
仅为基于公开信息的风险提示，不构成法律意见。
```

## 五、追问话术规则（D6、D13）

- 用常规业务流程当理由（「我们的标准流程」「为了团队统一建档」「财务要求」）；**不出现「核实」「背调」「怀疑」「诈骗」等词**。
- 每条话术只索要一样东西；询盘期不索要执照（订单前阶段才索要）。
- 不拒绝、不指责；对方不合理要求时用「我们的流程是……」把话题带回正常轨道。
- 话术必须对应命中的红旗或缺失的线索；每条最多附一行只给业务员看的提示（说明目的与判读方式）。
- 英文为主，每条附一句中文含义。

**询盘期话术库**：

| 对应情形 | 可直接发送的话（英文） | 中文含义 |
| --- | --- | --- |
| 要求先付验厂费（RF-PAY-001） | Thanks for your interest. In our process, factory visits are arranged after the order is confirmed. In the meantime, could you tell me the product model and quantity you have in mind, so I can prepare a quotation? | 感谢关注。我们的流程是下单确认后再安排验厂。方便告诉我型号和数量吗？我来准备报价。 |
| 仅用聊天软件联系（RF-BEH-003） | To keep all specs and quotations in one file for our team, could you also send the inquiry to my email? Our system files it by company email. | 为了让团队统一建档，方便您也把询盘发到我邮箱吗？我们按公司邮箱归档。 |
| 没有官网或域名可疑 | Could you share your company website so I can recommend the right product line for your market? | 方便分享贵司官网吗？我可以针对贵地市场推荐合适的产品线。 |
| 订单前，要求更换收款账户（RF-ACC-001） | Our finance team confirms any change in beneficiary details by phone, using the number we already have on file. Could you let us know a good time for a quick call? | 我们财务对任何收款信息变更都用留档电话回拨确认。什么时间方便简短通话？ |
| 要公司资料（链接层弱） | Could you share your company profile so I can pass it to our sales manager? | 能发一下贵公司简介吗？我转给销售经理。 |
| 确认职位/部门（对照 LinkedIn） | Which department are you in? I will arrange the right colleague for you. | 您在哪个部门？我帮您安排对接同事。 |
| 客户主动分享 LinkedIn | Do you have a LinkedIn page? I would like to connect with you there. | 您有 LinkedIn 主页吗？我想和您在那里联系。 |

**业务员提示（只给业务员看）**：
- 验厂费话术：把话题拉回报价。正常买家会回答型号和数量；异常账号会继续追着验厂费。
- 建档话术：用「建档」当理由要企业邮箱。很快给出是正常信号；拒绝或只给免费邮箱需提高警惕。
- 官网话术：借「推荐产品线」询问官网，不显得在查人。
- 回拨话术（仅订单前）：对方抗拒回拨或只接受邮件确认，是强烈警惕信号。
## 六、技术词 → 人话（卡片禁用技术词）

卡片面向业务员，不出现 HTTP 状态码、DNS 记录名、工具名和「误报已排除」之类的内部过程；脚本误报经审查排除后只记在完整报告附录 C，不进卡片。

| 原来的写法 | 改成 |
| --- | --- |
| 官网 200 | 官网可以正常打开 |
| Outlook MX、SPF | 邮箱服务正常，发信域名设置规范 |
| 域名 2015 年注册 | 域名已使用 11 年（按检索日期算） |
| 脚本把 X 误报成 UPS 仿冒，已人工排除 | （卡片不显示） |
| OSM/Yandex 无 POI，Google 未配 Key | 地图上没找到这家公司，点此用 Google 地图搜一次 |
| OFAC 无缓存未核验 | 制裁名单没能自动检查，点此到 OFAC 官方查一次 |
| ImportGenius 美国库无记录，Volza 被 CAPTCHA | 公开海关库没查到；Volza 需要过一次验证码，点此查看 |
| name-only-match | 只查到同名页面，不能算同一家 |
| 锚点 3/3 | 身份线索齐全（3/3） |
| DMARC 缺失 | 邮件防伪造设置缺失 |