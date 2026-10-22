# buyer-check · 外贸客户背调 Skill

> 收到陌生询盘、准备寄样或接单前，用一份有来源依据的风险报告，帮外贸业务员判断"这个客户值不值得往下走"。

`buyer-check` 是一个 Agent Skill：外贸业务员给出客户的公司名、域名、邮箱、询盘原文等有限信息，Skill 自动检索公开信息、交叉比对，输出**结构固定、每条结论都带来源链接和检索时间**的风险报告与下一步建议。

**定位边界**：做的是「风险信号筛查 + 证据整理」，**不判定对方是不是骗子**。风险等级由 `red_flags.md` 的固定权重算出，同一输入多次运行结果一致、可复现。

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

Skill 会依次执行：采集信息 → 四模块并行检索 → 交叉比对 → 按规则打分定级 → 输出报告（保存为 `report_<公司slug>_<YYYYMMDD>.md`）。

样例输出见 [`examples/sample-report.md`](examples/sample-report.md)。

## 报告结构

1. 风险等级 + 一句话理由
2. 已核实项 / 无法核实项 / 相互矛盾项
3. 命中的红旗清单（每条附来源链接与检索时间）
4. 建议下一步（可直接发送的追问话术、建议索要的材料、收款方式建议）
5. 免责声明

## 风险等级

| 等级 | 规则 |
| --- | --- |
| 低 | 总分 0–3，且无权重 5 的红旗 |
| 中 | 总分 4–7 |
| 高 | 总分 ≥8，或命中任一权重 5 的红旗 |
| 需人工核实 | 关键信息无法检索，无法形成可靠判断 |

完整红旗清单（12 条，MVP）见 [`red_flags.md`](red_flags.md)。

## 目录结构

```text
buyer-check/
├── SKILL.md              # Skill 主文件：触发条件、流程、硬性约束、输出要求
├── red_flags.md          # 红旗清单与评分规则（唯一评分依据）
├── data_sources.md       # 公开检索入口与查不到时的降级做法
├── report_template.md    # 报告固定结构与措辞模板
├── scripts/              # 域名查询、相似度、评分（Python + Node 双实现）
│   ├── whois_lookup.py / .mjs
│   ├── domain_similarity.py / .mjs
│   ├── risk_score.py / .mjs
│   ├── red_flags.json    # 机器可读红旗表
│   └── brands.json       # 知名公司域名清单
├── tests/                # 验收用例 A1–A7 与运行器
├── examples/             # 脱敏样例报告
└── docs/development.md   # 开发文档
```

## 硬性约束

- **防幻觉**：查不到写「未查到」，不凭印象编造；每条结论必带来源链接与检索时间；来源矛盾时如实并列。
- **隐私**：只查公开商业信息，不查个人住址、家庭、私人账号。
- **合规**：不使用「骗子」等定性字眼指称具体主体；报告固定附免责声明；银行账号等敏感信息脱敏且不落盘。

## 验证

```bash
node tests/run_cases.mjs
```

覆盖验收用例 A1–A7：红旗判定、仿冒域名识别、域名过新、查不到时的处理、报告结构、评分可复现、敏感信息脱敏。

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

## 赛事对齐（2026 华为开发者大赛·小红书 Skill 创新赛）

**赛道归属**：产业赛道 · 赛题四「AI行业先锋」——面向外贸行业的智能风控应用，解决真实业务问题（客户背调与防诈骗）。

**评审五维标准对照**：

| 评审维度 | 本作品的对应实现 |
| --- | --- |
| 场景真实性 | 外贸业务员收到陌生询盘是高频真实痛点：骗样品费/验厂费、BEC 邮箱仿冒转账货款均有真实损失场景；输入就是业务员手上已有的零散信息（公司名/域名/邮箱/询盘原文），不虚构数据 |
| 作品可用性 | 五步流程端到端可执行；A1–A7 验收用例全部通过；脚本可直接运行并输出 JSON；`examples/sample-report.md` 展示真实输出形态 |
| Skill 复用率 | 不限定行业品类，任何 B2B 询盘/客户背调场景均可复用；输入灵活（任一组合即可起步）；红旗清单与品牌库可持续追加 |
| 技术完成度 | 评分确定性可复现（A6）；Python + Node 双实现；支持离线 fixture 测试；防幻觉/隐私/合规硬性约束内置在 SKILL.md |
| 内容传播力 | 报告自带可直发的追问话术模板，天然适合小红书「一篇笔记一次产品发布」的晒单场景；发布带标签 #小红书Skill创新赛 #2026华为开发者大赛 |

**提交核对**（官方规则：单次提交 ≤30 个文件、内容 ≤40MB）：本作品内容文件 26 个、约 2MB，满足要求；`.arts/`、`.codegraph/`、`.merkle-snapshot.json` 为 IDE 本地文件，不参与提交。

**发布流程**：作品须同时发布到**华为云 Skill 市场**和**小红书 Skill 市场**。通过码道 CodeArts（网页版或 IDE）对话提交，或对码道说「我正在参加小红书Skill创新赛，帮我把这个Skill先发布到华为云Skill市场，再使用 redskillhub-upload 发布到小红书Skill市场」。

## 许可证

MIT，见 [LICENSE](LICENSE)。