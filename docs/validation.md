# buyer-check 验证说明（v0.9.1）

本文件只放仓库，不进精简包。所有案例使用虚构公司名、`.example` 域名和保留电话段，不含真实客户信息。

## 1. 验证范围

- 离线验收：`tests/cases/A1–A58`，覆盖评分、域名、电话、邮件头、制裁、账户、地图、身份、结论卡、入口、注册库、未完成项、证据强制、来源等级、数据日期、冲突、灰色卡和红旗说明。
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
| A55 | 红旗 why/benign | 23 条齐全，卡片只给最高权重触发行“可能无害” |
| A56–A57 | flip_hint 与固定声明 | 首屏外显示；声明恰好一次 |

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