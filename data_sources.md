# 数据源与检索入口（data_sources.md）

本文件列出 `buyer-check` 可用的公开检索入口与查不到时的降级做法。**只使用公开、免费的数据源**，不绕过登录、验证码或付费墙。

## 一、域名与 WHOIS / RDAP

| 用途 | 入口 | 说明 |
| --- | --- | --- |
| 域名注册信息 | `https://rdap.org/domain/<domain>` | RDAP 统一入口，返回注册日期、注册商、状态，JSON 格式 |
| 注册时间 / 注册商 | `scripts/whois_lookup.py <domain>` | 优先 RDAP，失败回退 whois CLI |
| DNS 记录 | `dig` / `nslookup` / DoH（`https://dns.google/resolve?name=<domain>&type=MX`） | 检查 MX/SPF/DMARC 是否配置 |
| 域名历史 | `https://web.archive.org/web/*/<domain>` | 判断官网是否新造、内容是否抄袭 |

**判断要点**：注册不足 6 个月 → RF-DOM-002；与知名公司仅字符差异 → RF-DOM-001。

## 二、邮箱与邮件头

| 检查项 | 做法 |
| --- | --- |
| 免费邮箱识别 | 比对 free-mail 域名表（gmail.com、outlook.com、hotmail.com、yahoo.com、qq.com、163.com 等） |
| 企业域名一致性 | 邮箱后缀域名 vs 用户提供的官网域名 |
| 邮件头字段 | 取 `From`、`Reply-To`、`Return-Path`、`Received` 逐项比对 |
| 邮箱是否泄露 | Have I Been Pwned（需 API key，可选） |

## 三、负面信息检索

检索组合：`<公司名/域名/邮箱> + (scam OR fraud OR complaint OR ripoff OR 诈骗 OR 骗子)`。

| 类型 | 入口 |
| --- | --- |
| 综合检索 | 通用搜索引擎（Bing / Google） |
| 域名信誉 | ScamAdviser（`https://www.scamadviser.com/check-website/<domain>`）、URLVoid |
| 消费者投诉 | Trustpilot、Ripoff Report、BBB（美国） |
| 社区口碑 | Reddit、外贸圈/福步论坛、行业群组 |
| 历史页面 | Wayback Machine |

**证据要求**：至少两条独立来源，或一条来源 + 与主体一致的关键信息（域名/邮箱/电话）。

## 四、制裁与黑名单

| 名单 | 入口 |
| --- | --- |
| OFAC SDN | `https://sanctionssearch.ofac.treas.gov/` |
| EU Consolidated | EU Sanctions Map / 官方 consolidated list |
| UN Security Council | UN Consolidated List |
| 世界银行 / 多边开发银行 | 各机构 Debarred List |

**注意**：人名/公司名匹配需人工排除同名，存疑时标注「疑似命中，需人工核实」。

## 五、公司与公开痕迹

| 类型 | 入口 | 版本 |
| --- | --- | --- |
| 公开网页痕迹 | 官网、LinkedIn 公司页、地址、电话、新闻报道 | MVP |
| 各国企业注册库 | 英国 Companies House、OpenCorporates、各国商业登记处 | V2 |
| 注册地址类型 | Google Maps / 街景，判断是否虚拟办公室或住宅 | MVP（人工） |

## 六、降级做法（查不到时）

- **域名无法解析 / RDAP 无响应**：改用 whois CLI，再改 Wayback；仍无 → 写「未查到，域名无法解析」。
- **公司名搜不到任何痕迹**：判为「需人工核实」，**不得编造**任何公司信息；建议向对方索要注册证书编号后再查。
- **制裁名单无 API**：用官方网页手动检索，记录查询时间与截图来源链接。
- **邮箱无邮件头**：无法判断 Reply-To 一致性，标注「未提供邮件头，该项无法核实」。

**通用规则**：任何一项查不到，都只标记「未查到」，不阻塞其他模块与整份报告。