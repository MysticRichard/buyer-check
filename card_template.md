# 结论卡与证据包规范（card_template.md）

本文件定义 `buyer-check` 的双模式输出：**一次检索只产生一份证据包；结论卡与完整报告都从同一份证据包渲染**（E1：两者等级、分数、命中红旗完全一致）。v0.5.0 起 SKILL 按本文执行。

## 一、双模式输出（D4、D5）

| 模式 | 触发 | 落盘 | 内容 |
| --- | --- | --- | --- |
| **结论卡（默认）** | 每次检索自动输出 | **只显示、不落盘** | 颜色+等级+分数、置信度+覆盖率+未覆盖项、≤5 条风险点、≤3 条话术、补充建议 |
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
  "score": { "total": 3, "risk_score": 27, "level": "低" }
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

## 三、结论卡版式（硬性规则）

1. **第一行永远是「颜色 + 等级 + 分数」**，用二级标题（字号最大）：
   - `## 🟢 低风险 · 27 / 100 ▓▓▓░░░░░░░`
   - 颜色：🟢 低（0–29）/ 🟡 中（30–59）/ 🔴 高（60–100）/ ⚪ 需人工核实（灰）。
2. **第二行固定为「置信度 + 覆盖率 + 未覆盖项」**：
   `置信度：中（锚点 1/3）｜覆盖：5/8 ｜ 未覆盖：地图（需浏览器）、海关/注册（TR 无矩阵）、社媒（未登录）`
   - 8 个核心检查点：公司名痕迹、域名/官网、邮箱/邮件头、电话、负面、制裁、地图、海关/注册；社媒（LinkedIn/Facebook/WhatsApp）为附加项，不计入 8 但必须显示。
   - 未覆盖项逐项带原因：`需浏览器` / `无矩阵` / `无免费数据` / `需登录` / `未提供` / `检索受限`；没有未覆盖项写「无」。
   - 未覆盖项放在本行，**不占用 ≤5 条风险点名额**；未覆盖不计分、不扣分，但**不得省略**。
3. **分数条 10 格**：按 `round(分数 / 10)` 用 ▓ 填充、░ 留空；**灰色状态用 ▒ 填充全部 10 格**。
4. 需人工核实时，分数旁固定标注：「低置信度，分数仅供参考，还需要更多信息实际核实」；并给出信息增益最大的一项（如「补充企业邮箱，置信度可从低提升到中」）。
5. **整卡 ≤ 25 行**；风险点 ≤ 5 条，按严重程度排序；每条只有「符号 + 红旗名（编号）+ 一句证据」。
6. 符号：🔴 命中权重 ≥4；🟡 命中权重 ≤3；🟢 已排除；⚪ 未查到或未覆盖。
7. 建议话术 ≤ 3 条：英文为主 + 一句中文含义；每条对应命中的红旗或缺失的线索，不凭空提问。
8. 卡片尾部固定一行：「仅为基于公开信息的风险提示，不构成法律意见。」

## 四、结论卡样例

````markdown
## 🔴 高风险 · 70 / 100 ▓▓▓▓▓▓▓░░░

置信度：低（锚点 0/3）｜覆盖：6/8 ｜ 未覆盖：地图（需浏览器）、社媒（未登录）

建议：先不要寄样，也不要垫付任何费用。客户：ACME TRADING LTD

**风险点**
- 🔴 要求先付款（RF-PAY-001）：对方要求先付 USD 500 验厂费（询盘第 2 段）
- 🟡 官网域名过新（RF-DOM-002）：注册仅 23 天（RDAP，2026-10-23）
- 🟢 已排除：未命中制裁名单；电话区号与所在国一致
- ⚪ 未查到：公开名录中没有这家公司

**建议这样回复（任选）**
1. Please send your inquiry from your company email.
   请从公司邮箱发送询盘。
2. Could you share your company website so I can recommend the right product line?
   方便分享官网吗？我好推荐合适的产品线。

补充【企业邮箱】可提升置信度。需要完整报告请回复「出完整报告」。
仅为基于公开信息的风险提示，不构成法律意见。
````

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

**业务员提示（只给业务员看）**：
- 验厂费话术：把话题拉回报价。正常买家会回答型号和数量；骗子会继续追着验厂费。
- 建档话术：用「建档」当理由要企业邮箱。很快给出是正常信号；拒绝或只给免费邮箱需提高警惕。
- 官网话术：借「推荐产品线」询问官网，不显得在查人。
- 回拨话术（仅订单前）：对方抗拒回拨或只接受邮件确认，是强烈警惕信号。