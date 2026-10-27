# BuyerCheck 迭代规划 v0.7.0（第三版）

Oct 27, 2026 · @Daniel

## 1. 概述

v0.7.0 只做三类事：先清掉公开仓库里的隐私遗留，再把提交包压到比赛限制以内，最后补两个小功能（邮件来源 IP 判断、手机号增强）。不新增红旗体系，不改评分公式。

触发原因：对 GitHub 项目 [GhostTrack](https://github.com/HunxByts/GhostTrack) 的调研。它只有 IP 查询、手机号解析、用户名枚举三个功能，值得借鉴的只有前两项的思路，且必须按本文边界重新实现，不复制代码。

| 编号 | 内容 | 类型 | 执行人 | 优先级 |
| --- | --- | --- | --- | --- |
| P0 | 清理 git 历史中的真实客户信息 | 隐私 | agent（负责人已授权） | 最高 |
| P1 | 比赛提交包精简（72 个文件 → ≤30） | 交付 | agent + 负责人确认 | 高 |
| P2 | 固化 RF-ACC-002 权重 | 规则 | 负责人决定，agent 落地 | 高 |
| A | `ip_check`：邮件来源 IP 归属与机房判断 | 新功能 | agent | 中 |
| B | `phone_check` 可选增强：号码类型、虚拟号 | 增强 | agent | 中 |

执行顺序固定：P0 → P2 → P1 → A → B。P0 未完成前，不要对外发布或提交比赛。

## 2. 现状基线（v0.6.0，2026-10-27 核对）

仓库当前是 v0.6.0，共 72 个跟踪文件，所有自动测试通过，但有三个遗留问题。

**已完成（不要重做）**

- 评分与等级对齐：低 0–29、中 30–59、高 60–100，权重 5 红旗至少 70 分；灰色「需人工核实」带低置信度标注。
- 双模式输出：结论卡默认只显示不落盘，完整报告按需写入 `reports/`；证据包 JSON。
- 脚本（Python + Node 双实现）：`phone_check`、`email_header_check`、`sanctions_check`、`account_check`、`check_sources`、`privacy_scan`。
- 22 条红旗（\`red\_flags.json\` 与 \`red\_flags.md\` 实际条目数一致，但文字说明里写的数字不一致，见下表）；16 国能力矩阵；评测集 42 条合成询盘；CI。
- 测试：A1–A14 共 14 项、评分一致性、脚本一致性、`account_check`、`check_sources`、评测集自检、隐私扫描全部通过。

**遗留问题**

| 问题 | 现象 | 风险 |
| --- | --- | --- |
| 真实客户信息仍在 git 历史 | 提交 `c5d6620` 中有迪拜客户报告（含姓名和 Gmail）；当前文件已删，历史仍可查，仓库是公开的 | 隐私泄露，最高 |
| 文件数超比赛限制 | 官方规则单次提交 ≤30 个文件、≤40MB；现有 72 个 | 无法提交 |
| RF-ACC-002 权重未确认 | red\_flags.md 标注「建议权重 3，待负责人确认」 | 规则可能后续改变 |

另有一项文档不同步（并入 P1 一起修）：红旗总数实际为 22 条，而 `red_flags.md` 标题和 README 写 21 条，`SKILL.md` 三处写 20 条。另外 `red_flags.md` 第 7 行写「新增 7 条」却列了 8 个编号。以 `scripts/red_flags.json` 为准统一。

## 3. 边界与硬性约束

以下规则在 v0.7.0 任何任务中都不可突破；遇到冲突时停下来问负责人，不要自行权衡。

| # | 规则 | 理由 |
| --- | --- | --- |
| B1 | 只查公开商业信息，不查个人私人账号、住址、家庭 | 现有硬性约束，不变 |
| B2 | 只报告「风险信号」，不用「骗子」等字眼定性具体主体 | 现有合规约束，不变 |
| B3 | **不做用户名/邮箱跨平台账号枚举**（Ghost Track 的 Username Tracker、Sherlock、Maigret、Holehe 一类） | 属于个人画像，与 B1 冲突；且「返回 HTTP 200 即存在」误报高，会把不确定的结果当证据。社媒核实继续用「链接 + 采集清单，业务员回传要点」 |
| B4 | **不接入 Seeker 之类诱导对方点击、获取对方位置的工具**；不向客户发送任何追踪链接、追踪像素、诱导性页面 | Ghost Track 文档建议 IP 查询配合 Seeker 获取目标 IP。这是隐蔽收集他人位置的做法，法律风险高，也与本 Skill「提醒业务员警惕可疑链接」的定位相反 |
| B5 | **不复制 Ghost Track 代码** | 项目页面未见许可证，无许可证即保留全部权利。只学习思路，由我们自己实现，代码不得与其相似。先查 LICENSE 文件再最终确认 |
| B6 | IP 定位只用到**国家级**和网络类型，不显示城市、经纬度、街道 | 城市级定位不准，且让工具像“跟踪”。比对自称所在国只需国家 |
| B7 | 联网查询默认关闭，需用户显式开启；只发送 IP，不发姓名、邮箱、公司名 | 保持「数据不外传」承诺；IP 可能被视为个人数据 |
| B8 | 证据包与报告中不保存完整 IP，只保存国家、ASN、网络类型和脱敏后的网段（如 203.0.113.0/24） | 数据最小化；完整 IP 只在当次会话显示 |
| B9 | 零依赖优先：第三方库只能作「可选增强」，没装时回退到现有本地表，结果标 unknown，不猜测 | 现有设计原则 |
| B10 | 不引入 GPL 代码、不引入非商用数据集；新增数据源必须核对许可证和条款并记录 | 仓库是 MIT，需要可商用 |
| B11 | 查不到只降置信度，只有积极矛盾才计分（D7）；IP 与自称国不一致必须经过下节的排除条件才能计分 | 避免 VPN、出差、网页邮箱导致误伤 |
| B12 | 不改评分公式、不改已发布红旗编号的含义；双实现（Python + Node）输出必须一致 | 可复现是本 Skill 的核心卖点 |

有两项我没有在这次核实到原始来源，按「未核实」处理：Seeker 的具体功能描述来自搜索结果（[zSecurity](https://zsecurity.org/accurately-locate-smartphones-using-social-engineering-seeker/)），没有逐页核对；Ghost Track 是否有 LICENSE 文件需负责人打开仓库确认。这两项不影响结论：即使有许可证，B3、B4 仍然成立。

## 4. P0 隐私与 git 历史清理（agent 执行，负责人已授权）

公开仓库的提交 `c5d6620` 里仍有真实客户的姓名和 Gmail。只删文件不够，必须改写历史。负责人在 2026-10-27 明确要求把这一步交给 agent，包括改写历史和对 `MysticRichard/buyer-check` 的 `main` 强推。因为强推不可逆，必须严格按下面的安全流程走，不得跳步。

**agent 按顺序执行：**

1. **列清单。** 用 `git log --all --diff-filter=A --name-only` 找出历史中所有 `report_*` 真实报告文件，用 `git grep` 在全部提交里找客户姓名和邮箱。把清单发给负责人（姓名、邮箱脱敏显示），**这是唯一一次停下来问**：等负责人回「确认」再继续。
2. **备份。** `git clone --mirror` 到工作目录，打成 `git bundle`，连同那两份真实报告一起发给负责人（付文件形式）。负责人收到后才能往下走，因为 agent 的工作环境是临时的。
3. **在全新的 mirror 克隆上改写**。用 `git filter-repo --path <真实报告> --invert-paths` 删文件；若其他文件也出现过姓名或邮箱，用 `--replace-text`（替换规则文件不得提交进仓库）。不在原工作目录上直接改。
4. **推送前验证**（见下表 V1–V5）：改写后的 HEAD 与改写前的 HEAD 内容树必须一致（因为现在文件已删），全部测试通过。任一项不过，停下来报告，不推送。
5. **强推**：只推 `main`，用 `git push --force-with-lease`；先用 `git branch -a` 和 `git tag` 检查有无其他分支和标签含敏感内容，有则一起处理并在汇报中列出。没有写权限时停下来告诉负责人，不自行改用「删仓库重建」。
6. **推送后验证**：重新全新克隆远程仓库，重复 V1–V3，确认 CI 通过。
7. **记录**：CHANGELOG 加一条「清理历史中的敏感文件，提交哈希已变更」，**不写**任何客户姓名、邮箱或报告文件名。

**agent 做不到、只能负责人做的事**

- 联系 GitHub 支持，请求清除旧提交的缓存视图。强推后旧提交可能仍能通过旧哈希链接访问一段时间（我的理解，未逐项核实 GitHub 官方说明）。
- 已经被别人 fork 或 clone 的副本无法清除。
- 判断是否通知相关客户。那个 Gmail 已在公开历史里出现过，这是业务判断。

**验收（全部满足才算完成）**

| 编号 | 检查项 | 方法 |
| --- | --- | --- |
| V1 | 历史中不再有 `report_*` 真实报告 | `git log --all -- 'report_*'` 无输出 |
| V2 | 历史中以真实姓名、邮箱关键字搜不到 | 对 `git rev-list --all` 逐个提交执行 `git grep` |
| V3 | 现有隐私扫描仍然干净 | `node scripts/privacy_scan.mjs` |
| V4 | 改写前后 HEAD 内容树一致，所有自动测试通过 | 比较 `git rev-parse HEAD^{tree}`，运行 CI 列表里的全部测试 |
| V5 | `.gitignore` 不再硬编码具体客户文件名，并忽略 `reports/`、`.env`、`*.key`、`.cache/`、`dist/` | 人工检查 |
| V6 | 负责人已收到备份包 | 负责人回复收到 |

## 5. P1 比赛提交包精简

目标：不破坏公开仓库的完整结构，另外生成一个精简提交包，文件数 ≤28（留 2 个余量）、体积 ≤40MB。规则来自 README 里引用的「单次提交 ≤30 个文件、内容 ≤40MB」，比赛截止时间为 2026-11-16（负责人已确认）。

**做法**：新增 `scripts/build_submission.mjs` 和 `submission.manifest.json`，按清单把文件复制或合并到 `dist/submission/`（`dist/` 加入 `.gitignore`）。不删除仓库里的任何现有文件。

**文件预算（建议，实际清单由 agent 提出、负责人确认）**

| 组 | 内容 | 文件数 |
| --- | --- | --- |
| 核心文档 | `SKILL.md`、`red_flags.md`、`card_template.md`、`report_template.md`、`README.md`、`LICENSE`、`CHANGELOG.md` | 7 |
| 数据源 | `data-sources/` 合并为单个 `data_sources.md`（全球 + 采集清单 + 试点国 SG/MY/TH/VN/AE/SA） | 1 |
| 脚本 | 核心 Python 脚本约 8 个 + 数据 JSON 约 4 个 | 12 |
| Node 对照实现 | 只保留 `risk_score.mjs` 与测试运行器所需的脚本 | ≤2 |
| 测试与评测 | A1–A14 合并为单个 `cases.json`、`run_cases.mjs`、评测集 `inquiries.jsonl` | 3 |
| 示例 | `examples/sample-report.md` | 1 |
| **合计** |  | **≤26** |

**不能碰的东西**：合并后的文件里的相对路径引用必须全部有效（SKILL.md 现在引用了 `data-sources/countries/*.md`，合并后要同步改写引用）；合并不得丢失任何检查点或红旗；精简包里的测试必须能独立运行。

**文档同步（顶层清理，和本任务一起做）**

- 红旗总数统一为 `scripts/red_flags.json` 的实际条数（22），修改 `red_flags.md` 标题与第 7 行、README、`SKILL.md` 三处。
- 把这个数字校验加入 `tests/consistency.mjs`，以后数字不一致 CI 直接失败。

**验收**

| 编号 | 检查项 |
| --- | --- |
| S1 | `node scripts/build_submission.mjs` 生成 `dist/submission/`，文件数 ≤28、总体积 ≤40MB，脚本自己检查并报错 |
| S2 | 在 `dist/submission/` 里独立运行测试全部通过 |
| S3 | 对精简包运行 `privacy_scan` 干净 |
| S4 | SKILL.md、README 里所有相对路径都能在精简包中找到（脚本自动检查链接有效性） |
| S5 | 红旗数量在各文档中一致 |

## 6. P2 RF-ACC-002 权重确认

`RF-ACC-002`（收款账户国与买家自称国不一致且无合理解释）现在权重是 3，标注「待负责人确认」。负责人已在 2026-10-27 确认权重为 3（第 11 节 Q1），agent 可以删掉「待确认」字样并固化。

| 选项 | 权重 3（现状，推荐） | 权重 4 | 权重 2 |
| --- | --- | --- | --- |
| 单独命中时分数 | 9 × 3 = 27（绿区上沿） | 35（黄区） | 18（绿区） |
| 与一条权重 5 红旗同时命中 | T=8，高风险 | T=9，高风险 | T=7，仍是高（权重 5 触发） |
| 适用场景 | 账户国不一致有合理解释的情况较多（集团财务集中、自贸区主体），单独命中不应进黄区 | 误伤风险偏高 | 起不到预警作用 |

推荐保持 3。单独命中落在绿区 27 分，提醒但不变色；和任何一条其他红旗组合才会进黄区，这符合「账户国不一致是线索而非证据」的定位。

**落地清单**（负责人确认后）

- `red_flags.md` 与 `scripts/red_flags.json` 删除「待确认」字样，权重写死。
- 若权重改变，重跑评分一致性、评测集、A10–A14，并在 CHANGELOG 记录。
- 权重只在负责人明确回答后才改，agent 不得自行调整。

## 7. 功能 A：ip\_check 邮件来源 IP 归属与网络类型

**要解决的问题**：`email_header_check` 已能从邮件头里取出来源 IP，但不知道它在哪个国家、是不是机房或大型邮件服务商。`RF-CORP-001` 里写了「发件 IP 归属地」但目前没有数据可用。思路参考 Ghost Track 的 IP 查询（国家、ASN、网络商），但按第 3 节边界重新设计。

**用法**

```text
python scripts/ip_check.py --ip 203.0.113.7 --claimed-country AE            # 默认离线，只做分类
node   scripts/ip_check.mjs --ip 203.0.113.7 --claimed-country AE --online   # 显式开启联网查询
python scripts/ip_check.py --ip 203.0.113.7 --rdap-json tests/fixtures/ip-rdap-sample.json   # 离线 fixture，与 whois_lookup 同模式
```

示例 IP 必须使用保留文档段（203.0.113.0/24、98.51.100.0/24、192.0.2.0/24），不得出现真实 IP，`privacy_scan` 会检查。

**数据来源**

- 默认联网来源：公开 RDAP（区域互联网注册机构的分配记录），返回分配国家、网络名、组织名。它反映注册信息而不是实际位置，这正好符合「只用国家级」。沿用 `whois_lookup` 访问 RDAP 的方式。
- 第三方定位服务（如 Ghost Track 使用的 ipwho.is、ipinfo 的免费档、MaxMind GeoLite2 本地库）：**v0.7.0 不内置**。要接入必须先核对其使用条款、频率限制、是否允许商用，并走 Q4 确认。我这次没有核实这些服务的条款。
- 本地小表：只放公认大型邮件服务商的 ASN。每一项必须在区域注册机构查证，不确定的不放；表文件记录核实日期。

**判断流程**

| 情况 | 处理 | 计分 |
| --- | --- | --- |
| 邮件头里没有来源 IP（null） | `status: skipped`，原因 no\_ip | 不计 |
| 私网、回环、保留地址 | `skipped`，原因 non\_public | 不计 |
| 属于大型邮件服务商中继（网页邮箱） | `net_type: mail_provider`，不比对国家，说明看到的是服务商而不是客户 | 不计 |
| 公网 IP，未开启联网 | `status: offline`，提示可开启 | 不计 |
| 联网查到，国家与自称国一致 | `consistent: true`，记入证据包 | 不计 |
| 联网查到，机房、云服务商或匹配到匿名化网络 | `net_type: hosting_or_anonymized`，不从中推断国家 | 不计（很多正常用户用 VPN） |
| 联网查到，国家与自称国不一致，仅此一项 | `consistent: false`，作为线索列入风险点。追问话术委婉核实行程，例如「近期是否在出差？」 | 不计 |
| 不一致，且至少还有一个独立字段也与自称国不一致（电话区号、官网所在国、注册地址） | 命中 `RF-CORP-001`，证据列出各字段与来源 | 按现有权重 2 |

**输出字段**（JSON，与现有脚本风格一致，查询失败返回 `status: "unavailable"`）

| 字段 | 含义 |
| --- | --- |
| `status` | ok / skipped / offline / unavailable |
| `reason` | 跳过或不可用的原因 |
| `ip_masked` | 脱敏网段，如 `203.0.113.0/24`（B8：不输出完整 IP） |
| `country` | 分配国家（ISO 3166-1 alpha-2），查不到为 null |
| `asn`、`org` | 网络编号和组织名，查不到为 null |
| `net_type` | mail\_provider / hosting\_or\_anonymized / unknown / non\_public |
| `claimed_country` | 用户传入的自称国 |
| `consistent` | true / false / null |
| `source`、`retrieved_at` | 来源链接和查询时间 |

**与现有体系的接入**

- 证据包 `checks[]` 里加可选项 `ip_origin`（result 可为 consistent / inconsistent / skipped / not-covered）。**不新增第 9 个覆盖率检查点**，避免改变覆盖率分母后 A13、A14 的数值变化。
- SKILL.md 的邮件头步骤中，在运行 `email_header_check` 后调用 `ip_check`，结果进证据包；结论卡只在命中红旗或形成线索时才占一条风险点。
- `red_flags.md` 的 `RF-CORP-001` 判定细则补充「至少 2 个独立字段矛盾，IP 只作其中之一，且排除邮件服务商中继和机房/匿名化网络」，不改编号、不改权重。

**验收**

| 编号 | 检查项 |
| --- | --- |
| G1 | 无 IP、私网 IP、邮件服务商 IP 均输出 skipped 或 mail\_provider，且风险分不变 |
| G2 | 用 fixture 覆盖「一致」「不一致仅此一项」「不一致且另有独立矛盾」三种结果，前两种不计分，第三种命中 RF-CORP-001 |
| G3 | 机房或匿名化网络不产生国家结论、不计分 |
| G4 | 输出与证据包中没有完整 IP，只有脱敏网段 |
| G5 | Python 与 Node 输出一致，加入 `tests/consistency_scripts.mjs` |
| G6 | 默认不联网：不加 `--online` 时任何情况下都不发出网络请求（测试用拦截网络的方式验证） |

## 8. 功能 B：phone\_check 可选增强

**现状（已实测）**：`phone_check` 用本地 ITU 区号表解析国别、判断是否有效、与自称国比对。输入不带 `+` 的号码时直接返回无效、不猜国家；这正好避开 Ghost Track 默认按印度尼西亚解析的问题，**不要改成默认某个国家**。缺点是号码类型只有少数国家能分出手机、其余为 `unknown`，也看不出虚拟号。

**增强内容**（都是可选，没装库时输出与现在完全一样）

| 新增字段 | 含义 | 注意 |
| --- | --- | --- |
| `number_type` | MOBILE / FIXED\_LINE / VOIP / TOLL\_FREE / PREMIUM\_RATE 等 | 仅在检测到可选库时输出；库分不出时为 `unknown`，不猜 |
| `carrier` | 首次分配运营商 | 必须附 `carrier_note`：携号转网后可能与现运营商不同，仅供参考 |
| `timezones` | 号码对应的时区列表 | 可和邮件头里的发送时区对照，只作线索 |
| `enriched_by` | 使用的库名与版本，没用则为 null | 用于证据追溯 |

**实现要求**

- Python 端检测能否 `import phonenumbers`，Node 端检测能否加载同类库；禁止把它们列为必需依赖，不写进安装步骤里的必选项。
- `phonenumbers` 的许可证据我所知是 Apache 2.0，但未核实；实现前必须核对其许可证（以及 Node 端所选库的许可证）并写入 `data-sources/global.md`，走 Q5 确认。
- Python 与 Node 对增强字段的结果可能不同（两边库的数据版本不同），所以一致性测试只比较基础字段；增强字段单独测试，没装库时跳过并在结果里标「skipped」，不算失败。

**评分影响**：不新增红旗。虚拟号（VOIP）、高费率号码只作为线索进入结论卡和证据包，不计分，因为正常公司也常用云电话（按 D7：只有积极矛盾才计分）。现有 `RF-CORP-005`（号码国与自称不符）不变。

**验收**

| 编号 | 检查项 |
| --- | --- |
| H1 | 没装可选库时，输出与 v0.6.0 完全一致（已有测试不修改即通过） |
| H2 | 装了可选库时增加 `number_type`、`carrier`、`carrier_note`、`timezones`、`enriched_by` |
| H3 | 不带 `+` 的号码仍然不猜国家 |
| H4 | 虚拟号、高费率号码不改变风险分与等级 |
| H5 | 测试里的示例号码只用保留虚构段，不出现真实号码（`privacy_scan` 通过） |

## 9. 红旗、评分、证据包与统一验收

v0.7.0 不新增红旗、不改评分公式。红旗总数仍为 22 条，权重只有 RF-ACC-002 可能按 Q1 的答案调整。

| 事项 | 变化 |
| --- | --- |
| 红旗 | 仅在 `RF-CORP-001` 判定细则里补充「至少 2 个独立字段矛盾」和排除条件；编号、含义、权重不变 |
| 评分公式 | 不变；`tests/consistency.mjs` 现在的「全部 4194304 种红旗组合」检查必须继续通过 |
| 覆盖率 | 不新增检查点，分母仍为 8 |
| 证据包 | `checks[]` 追加可选项 `ip_origin`；电话检查结果追加可选字段（见第 8 节）。按 `card_template.md` 现有 Schema 追加，必须兼容旧证据包 |
| 结论卡 | 不改版式。IP、虚拟号线索只在形成风险点时才占一条，仍然不超过 5 条 |
| 追问话术 | 遇到 IP 国家不一致的线索，话术只委婉询问行程和工作安排，不提及「我们查了你的 IP」；仍然最多 3 条、英文加中文含义 |
| CI | `.github/workflows/ci.yml` 追加 `ip_check` 和 `build_submission` 的测试步骤 |

**统一验收（全部通过才能发布 v0.7.0）**

- 各节验收：P0 的 V1–V6、P1 的 S1–S5、功能 A 的 G1–G6、功能 B 的 H1–H5。
- R1：v0.6.0 的全部现有测试不修改即通过（A1–A14、一致性、评测集自检、`account_check`、`check_sources`、`privacy_scan`）。
- R2：`SKILL.md` frontmatter 版本号、`CHANGELOG.md` 写 0.7.0，脚本表补 `ip_check`、`build_submission`。
- R3：README、`docs/development.md`、`docs/iteration_plan.md` 与实际状态一致（红旗 22 条、文件数、脚本表）。
- R4：所有新增示例数据（IP、号码、邮箱）均为保留虚构段，`privacy_scan` 清洁。

## 10. 给开发 agent 的执行说明

先读这份文档，再读仓库里的 `SKILL.md`、`red_flags.md`、`card_template.md`、`docs/iteration_plan.md`、`scripts/email_header_check.py` 和 `scripts/phone_check.py`。这份文档建议存成 `docs/iteration_plan_v0.7.md` 作为仓库内的正式依据。

**执行顺序**：P0 → P2（Q1 已答：权重 3）→ P1 → 功能 A → 功能 B → 统一验收（第 9 节）。每一步独立提交，上一步全部测试绿了再做下一步。P0 之前不要推送任何新功能。

**工程规范**

- 提交信息沿用仓库现有风格：`type(scope): subject`，例如 `feat(ip): add ip_check with offline classification`，一个事项一个提交。
- 脚本继续 Python 3.12 + Node 20 双实现，输出 JSON 字段一致；查询失败返回 `status: "unavailable"`，不抛异常。
- 新文件命名、编号、文档风格按仓库现有约定，不重命名现有文件。
- 所有示例、测试数据只用保留虚构段（IP：203.0.113.0/24、98.51.100.0/24、192.0.2.0/24；邮箱：示例域名）。
- 每完成一步，汇报四件事：做了什么、跑了哪些测试、结果、还有哪些待确认。

**必须停下来问负责人的情况**

- 文档与仓库现状冲突，或文档没写且会影响行为的情况。
- 需要新增任何第三方依赖、数据集，或访问一个还没核对过条款的网站和服务。
- 需要改红旗权重、评分公式、覆盖率分母。
- 需要删除仓库现有文件（P0 授权范围和提交包构建到 `dist/` 除外）。
- 测试失败且两次尝试后仍修不好。
- 发现仓库、报告、测试数据里有其他真实个人信息。
- 没有写权限、或强推被拒。

**禁止事项**

- 不实现或接入第 3 节 B3–B5 禁止的任何内容（用户名枚举、Seeker 一类定位工具、复制 Ghost Track 代码）。
- 除 P0 授权的对 `main` 的强推外，不执行 `git push --force`、`git reset --hard` 到远程等破坏性命令，不动其他分支。
- 不自动抓取各国企业注册库、不批量访问第三方网站；不在脚本里写死任何 API 密钥。
- 不把 `.cache/`、`.env`、`dist/`、`reports/` 提交进仓库。
- 查不到的东西不猜，写 unknown 或 null。

**启动提示词（可直接贴给执行 agent）**

```text
你要为公开仓库 MysticRichard/buyer-check 执行 v0.7.0 迭代。
先完整阅读《BuyerCheck 迭代规划 v0.7.0》和仓库里的 SKILL.md、red_flags.md、card_template.md。
按文档第 10 节的顺序执行：P0 → P2 → P1 → 功能 A → 功能 B。
严格遵守第 3 节边界和第 10 节「必须停下来问」「禁止事项」。
P0 中的历史改写和对 main 的强推已由负责人授权，但必须先备份、先获得清单确认。
每步完成后汇报：做了什么、跑了哪些测试、结果、待确认项。
```

## 11. 待确认问题与来源

负责人已于 2026-10-27 回答全部 7 项，答复见表后，以答复为准。表中「默认值」列即负责人确认的最终决定。

| 编号 | 问题 | 默认值 | 影响 |
| --- | --- | --- | --- |
| Q1 | RF-ACC-002 权重用 3、4 还是 2？ | 3 | 第 6 节。不答则不删「待确认」 |
| Q2 | 提交精简包里 Node 对照实现保留范围？ | 只保留 `risk_score.mjs` 及测试所需 | 第 5 节文件预算 |
| Q3 | 比赛官方最新规则是否仍是单次提交 ≤30 个文件、≤40MB？截止时间？ | 按 ≤28 个文件做 | 第 5 节 |
| Q4 | `ip_check` 是否允许可选接入第三方 IP 定位或 ASN 服务？要的话选哪家？ | 不接入，只用 RDAP | 第 7 节数据来源 |
| Q5 | 是否允许把 `phonenumbers` 类库作为可选依赖？ | 允许，仅可选，且先核对许可证 | 第 8 节 |
| Q6 | 证据包里 IP 脱敏到 IPv4 的 /24、IPv6 的 /48 是否可接受？ | 可接受 | 第 3 节 B8 |
| Q7 | 测试文件 `tests/consistency_scripts.mjs` 中的测试名字与此前真实利比亚客户同名（已替换为虚构名），是否替换为明确虚构的名字？ | 替换为虚构名，同名匹配的测试逻辑不变 | 第 4 节 |

**负责人答复（2026-10-27）**

- Q1：RF-ACC-002 权重用 3。agent 可以删掉「待确认」字样并固化。
- Q2：精简包按 ≤28 个文件，Node 只保留 `risk_score.mjs` 及测试所需。
- Q3：比赛截止时间是 **2026-11-16**。官方文件数和体积限制仍按 ≤28 个文件、≤40MB 执行。
- Q4：只用公开 RDAP，不接入第三方 IP 服务。
- Q5：允许把 `phonenumbers` 类库作为可选依赖，实现前先核对许可证。
- Q6：IP 脱敏到 IPv4 /24、IPv6 /48，接受。
- Q7：把该测试名字替换为明显虚构的名字，同名匹配的测试逻辑不变。

**时间安排建议**（我的建议，非负责人决定）：从 2026-10-27 到 2026-11-16 共 20 天。P0、P2、P1 必须在提交前完成，建议在 11-09 前做完，留一周余量。功能 A、B 是增强项，时间不够可以推迟到比赛后，不影响提交。

**来源**（除 zSecurity 外都是我打开过或实测过的）

- [HunxByts/GhostTrack](https://github.com/HunxByts/GhostTrack)：项目页面，功能列表，页面上未见许可证。
- [Hongkiat：How Good Is GhostTrack](https://www.hongkiat.com/blog/ghosttrack-what-this-osint-tool-actually-does/)：功能细节、使用的服务和库、局限。
- [zSecurity：Seeker](https://zsecurity.org/accurately-locate-smartphones-using-social-engineering-seeker/)：仅看到搜索结果标题、未打开页面，按未核实处理。
- [MysticRichard/buyer-check](https://github.com/MysticRichard/buyer-check)：已克隆并实测 v0.6.0（提交 `393bbb4`），所有自动测试通过。
- [BuyerCheck 迭代规划 v0.4.1–v0.6.0](https://claude.ai/artifact/YFpPTed44bbza4LUeo2YFk)：上一版规划，决策 D1–D13 以它为准。
