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

## 许可证

MIT，见 [LICENSE](LICENSE)。