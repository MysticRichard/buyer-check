# buyer-check · 外贸客户背调 Skill

> 收到陌生询盘、准备寄样或接单前，用一份有来源依据的风险报告，帮外贸业务员判断"这个客户值不值得往下走"。

`buyer-check` 是一个 Agent Skill：外贸业务员给出客户的公司名、域名、邮箱、询盘原文等有限信息，Skill 自动检索公开信息、交叉比对，输出**结构固定、每条结论都带来源链接和检索时间**的风险报告与下一步建议。

**定位边界**：做的是「风险信号筛查 + 证据整理」，**不判定对方是不是骗子**。风险等级由 `red_flags.md` 的固定权重算出，同一输入多次运行结果一致、可复现。

**数据不外传**：检索与报告都在使用者自己的环境完成；本 Skill 不收集、不上传用户数据，不做遥测。

## 解决什么问题

外贸常见的两类损失：

- **骗费用**：样品费、验厂费、保证金、清关费、垫付物流费
- **骗货款**：邮箱被仿冒后，把货款汇进诈骗账户（BEC）

业务员通常只有零散信息、没时间逐一核查。本 Skill 把零散信息变成一份可执行的判断依据。

## 快速开始

在支持 Agent Skill 的客户端（如华为云代码智能体）中直接提出需求即可触发：

```text
帮我背调一下这个客户：NORDIC IMPORT AB，官网 nordic-imp0rt.com，邮箱 info@nordic-imp0rt.com
这是他的询盘：We are interested in your products, please pay the factory audit fee of USD 500 first...
```

Skill 会依次执行：采集信息 → 并行检索 → 交叉比对 → 按规则打分定级 → 输出报告（保存到 `reports/report_<公司slug>_<YYYYMMDD>.md`）。

样例输出见 [`examples/sample-report.md`](examples/sample-report.md)。

## 风险分与等级

风险分 0–100，区间与等级对齐，一眼分辨高低：

| 等级 | 触发条件 | 风险分公式 | 区间（颜色） |
| --- | --- | --- | --- |
| 低 | 总分 T 0–3，且无权重 5 红旗 | 9 × T | 0–29（绿） |
| 中 | 总分 T 4–7，且无权重 5 红旗 | 35 + 8 × (T − 4) | 30–59（黄） |
| 高 | T ≥ 8，或命中任一权重 5 红旗 | max(权重5时 70, min(100, 65 + 5 × max(0, T − 8))) | 60–100（红） |
| 需人工核实 | 身份锚点全缺且未达高分档 | 按 T 对应等级公式照常计算 | 灰色 + 「低置信度，分数仅供参考」 |

等级优先级：已达高分档时永远显示「高」（置信度低时附加标注）；其余情况身份锚点全缺才显示「需人工核实」。

完整红旗清单（22 条）见 [`red_flags.md`](red_flags.md)。

## 目录结构

```text
buyer-check/
├── SKILL.md              # Skill 主文件：触发条件、流程、硬性约束、输出要求
├── red_flags.md          # 红旗清单与评分规则（唯一评分依据）
├── card_template.md      # 结论卡版式、证据包 Schema、追问话术规则
├── data-sources/         # global.md 全球通用入口 + countries/<iso2>.md 国家资料 + 采集清单
├── report_template.md    # 报告固定结构与措辞模板
├── scripts/              # 域名查询、相似度、评分、隐私扫描（Python + Node 双实现）
│   ├── whois_lookup.py / .mjs
│   ├── domain_similarity.py / .mjs
│   ├── risk_score.py / .mjs
│   ├── privacy_scan.mjs  # 提交前隐私扫描
│   ├── account_check.py / .mjs  # 订单前 IBAN/BIC 校验（mod-97 自实现）
│   ├── check_sources.mjs # 数据源可达性保鲜
│   ├── phone_check.py / .mjs + phone_check_data.json
│   ├── email_header_check.py / .mjs
│   ├── sanctions_check.py / .mjs + update_sanctions
│   ├── red_flags.json    # 机器可读红旗表
│   └── brands.json       # 知名公司域名清单
├── tests/                # 验收用例 A1–A14、一致性测试、行为评测集
├── examples/             # 脱敏样例报告
├── reports/              # 生成的报告（本地保留，不入仓库）
└── docs/                 # development.md 开发文档、iteration_plan.md 迭代方案
```

## 边界与硬性约束（任何版本不得放宽）

- **查询对象与目的**：仅限商业询盘中的对方，仅限识别交易风险；不用于查个人、跟踪或人肉。
- **个人资料范围**：只看职业身份相关公开资料（职位、任职公司、行业、账号真实性）；不看家庭、住址、私人照片，不做个人画像。
- **电话号码**：只检索对方主动给出的号码，仅用于找诈骗投诉记录与商业身份。
- **禁用工具**：不使用按用户名或邮箱枚举各网站账号的工具（Sherlock、Maigret、Holehe 一类）。
- **数据不外传**：检索与报告都在用户自己的环境完成；不收集、不上传用户数据，不做遥测。
- **平台与登录**：不绕过登录、验证码、付费墙，不批量抓取；对注册库只给链接和检索清单，不自动抓取。
- **个人信息显示**：姓名、邮箱、电话在卡片和报告中默认脱敏（如 `d***e@gmail.com`），用户明确要求才显示全称。
- **敏感信息**：银行账号、证件号仅用于本次分析，不写入任何文件，报告中脱敏显示。
- **防幻觉**：没有来源的内容不写成事实；每条事实带来源链接与检索时间；来源矛盾时如实并列；未覆盖的维度写「未覆盖」，不写「正常」。
- **合规措辞**：不使用「骗子」等定性字眼；报告与卡片固定附免责声明，不构成法律意见。
- **开源许可**：MIT 协议；不引入 GPL 代码与非商业授权数据。

## 验证

```bash
node tests/run_cases.mjs        # 验收用例 A1–A14
node tests/consistency.mjs      # V5 分数区间遍历 + V6 Python/Node 一致性
node scripts/privacy_scan.mjs   # 提交前隐私扫描
node tests/account_check_cases.mjs  # F2 收款账户校验
node tests/check_sources_cases.mjs  # F3 数据源保鲜
```

## 脚本用法

```bash
# 域名注册信息 + DNS（Python / Node 任一）
python scripts/whois_lookup.py example.com
node scripts/whois_lookup.mjs example.com

# 仿冒域名检测
python scripts/domain_similarity.py app1e.com
node scripts/domain_similarity.mjs app1e.com

# 确定性评分 / 脱敏
python scripts/risk_score.py --flags RF-PAY-001 RF-DOM-002
node scripts/risk_score.mjs --mask "4111 1111 1111 1234"
```

脚本输出均为 JSON；查询失败时返回 `status: "unavailable"`，调用方按「未查到」处理。

## 许可证

MIT，见 [LICENSE](LICENSE)。