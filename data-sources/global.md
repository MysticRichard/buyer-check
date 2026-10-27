# 全球通用数据源（data-sources/global.md）

全球通用的公开检索入口与降级做法。国家特定入口见 `countries/<iso2>.md` 与 `scripts/country_capabilities.json`。**只使用公开、免费的数据源**，不绕过登录、验证码或付费墙；注册库一律「链接 + 检索清单」，不自动抓取。

## 一、域名与 WHOIS / RDAP

| 用途 | 入口 | 说明 |
| --- | --- | --- |
| 域名注册信息 | `https://rdap.org/domain/<domain>` | RDAP 统一入口，注册日期/注册商/状态，JSON |
| 注册时间 / 注册商 | `scripts/whois_lookup.py <domain>` | 优先 RDAP，失败回退 whois CLI |
| DNS 记录 | DoH：`https://dns.google/resolve?name=<domain>&type=MX` | MX/SPF/DMARC 配置 |
| 证书最早签发时间 | crt.sh（可选） | WHOIS 之外的新站信号；不可用时填 null |
| 域名历史 | `https://web.archive.org/web/*/<domain>` | 官网是否新造、内容是否抄袭 |

## 二、邮箱与邮件头

| 检查项 | 做法 |
| --- | --- |
| 免费邮箱识别 | 比对 free-mail 域名表（gmail/outlook/hotmail/yahoo/qq/163 等） |
| 企业域名一致性 | 邮箱后缀 vs 公司名/官网域名 |
| 邮件头字段 | `scripts/email_header_check.py`（From/Reply-To/Return-Path/Received/SPF/DKIM/DMARC） |
| 假企业邮箱排除 | 挂在免费建站平台子域名上的地址、域名无 MX 记录的地址 |

## 三、负面信息检索

检索组合：`<公司名/域名/邮箱/电话> + (scam OR fraud OR complaint OR ripoff OR 诈骗 OR 骗子)`；询盘特征句加引号精确检索（话术指纹，RF-NEG-002）。

| 类型 | 入口 |
| --- | --- |
| 综合检索 | 通用搜索引擎 |
| 域名信誉 | ScamAdviser、URLVoid |
| 消费者投诉 | Trustpilot、Ripoff Report、BBB |
| 社区口碑 | Reddit、外贸圈/福步论坛 |
| 历史页面 | Wayback Machine |
| 图片反搜 | Google Lens / TinEye（头像、办公室照片、产品图——业务员回传要点） |

**证据要求**：至少两条独立来源，或一条来源 + 与主体一致的关键信息（域名/邮箱/电话）。

## 四、制裁与黑名单

| 名单 | 入口 | 状态 |
| --- | --- | --- |
| OFAC SDN | `scripts/update_sanctions` 下载 CSV 后本地匹配（官方直链） | configured |
| EU Consolidated | 官方下载入口未核实 | not_configured |
| UN Security Council | 官方下载入口未核实 | not_configured |
| UK OFSI | 官方下载入口未核实 | not_configured |

人名/公司名匹配需人工排除同名；存疑时标注「疑似命中，需人工核实」。

## 五、电话与社媒

| 检查项 | 做法 |
| --- | --- |
| 号码国别/类型/与自称国一致性 | `scripts/phone_check.py/.mjs`（本地 ITU 区号表） |
| 号码类型/运营商/时区（可选增强） | 自装 `phonenumbers`（Python，Apache-2.0，9.0.41）或 `libphonenumber-js`（Node，MIT，1.13.15）时由 phone_check 输出；许可证 2026-10-27 核对，未装时回退本地表且输出不变 |
| 号码负面检索 | 号码多格式 + scam/fraud |
| 号码与名称强关联 | 号码与公司名出现在同一来源（官网联系页/地图商家/B2B 平台）才算 |

## 六、地图 / 海关 / 社媒的实际查询通道（v0.7.0 起）

| 维度 | 先查（免费、可自动） | 查不到时的写法 | 禁止 |
| --- | --- | --- | --- |
| 地图 | Google Maps embed：`https://maps.google.com/maps?q=<公司名>&output=embed`（解析 POI）；OpenStreetMap Nominatim：`https://nominatim.openstreetmap.org/search?q=<公司名>&format=json` | 分别用公司名、电话、域名各搜一次；写明「Google Maps 按电话 +90… 返回找不到；按域名仅返回无关公司」 | 把同名不同公司（名称/电话/网站任一不同）当客户 |
| 海关 | ImportGenius 公共搜索：`https://www.importgenius.com/search?q=<公司名>`（美国进口库，免费摘要）；Trademo/ExportGenius 需订阅 | 写明「ImportGenius 美国库无记录；土耳其无公开公司级海关数据」 | 用国家宏观进出口统计冒充公司记录；把「无记录」写成「已确认无贸易」 |
| 社媒 | Brave/Bing：`site:linkedin.com "<公司名>"`、`site:facebook.com ...`、`site:instagram.com ...`；公共页能读则读 | 写明「无公开索引」或「登录墙，需人工登录核对」并给链接 | 把同名别家账号当客户；绕过登录 |

**判定纪律**：先执行上述通道，只有通道都执行且无结果才标 `not-covered`；未覆盖原因必须写**实际查询结果**（不是一句「未覆盖」）。同名不同公司不得合并。

## 七、降级做法（查不到时）

- **域名无法解析**：whois CLI → Wayback；仍无 → 「未查到，域名无法解析」。
- **公司名搜不到痕迹**：以身份锚点全缺为准判「需人工核实」，不得编造；询盘期不索要执照，用委婉话术只要官网/企业邮箱。
- **制裁名单无缓存**：运行 `update_sanctions`；下载失败 → 官方网页手动检索，记录查询时间。
- **邮箱无邮件头**：标注「未提供邮件头，该项无法核实」。
- **通用规则**：查不到只标「未查到」（降置信度），不阻塞其他模块；**只有积极矛盾才计分（D7）**。