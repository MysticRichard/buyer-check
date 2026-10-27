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

| 维度 | 先查（免费、可自动） | 判定规则 | 禁止 |
| --- | --- | --- | --- |
| 地图 | **双向**（Google Maps embed）：① 按电话 `https://maps.google.com/maps?q=<E.164>&output=embed`；② 按公司名 `https://maps.google.com/maps?q=<公司名>&output=embed`；补充 OpenStreetMap Nominatim `https://nominatim.openstreetmap.org/search?q=<公司名>&format=json` | 电话与名称**分别**搜索；只有名称匹配且电话一致（或官网/地址可对应）才算同一实体；名称匹配但电话不同 → 不合并，写「同名不同公司」；两者都无 → 「按电话/名称均无商家页」 | 把同名不同公司（名称/电话/网站任一不同）当客户 |
| 海关 | **多平台、免费优先**：① ImportGenius `https://www.importgenius.com/search?q=<公司名>`（美国库，免费摘要）② Volza `https://www.volza.com/search/?q=<公司名>`（免费预览）③ Panjiva `https://panjiva.com/search?q=<公司名>` / Trademo（可达时）④ 52wmb / ExportGenius（可达时）；逐平台记录 | 至少查 2 个可达平台并逐平台写结果；无记录写「多平台无记录」，不写「无贸易」；土耳其无公开公司级数据时注明 | 用国家宏观进出口统计冒充公司记录；只查一个平台就下结论 |
| 社媒 | **名称 + 电话双匹配**：`"<公司名>" "<E.164>"`、`"<公司名>" "<域名>"`、`site:linkedin.com/facebook.com/instagram.com "<公司名>"`；公共页能读则看绑定信息 | 只有「名称 + 电话（或域名）+ 主页绑定公司名/域名」同时匹配，才记「社媒已验证」；仅同名 → `name-only-match`，不算真实；无结果 → `no-double-match`；登录墙 → `login-wall` | 把同名别家账号当客户；仅凭名称相同就判定真实；绕过登录 |

**判定纪律**：地图双向、海关多平台、社媒双匹配都执行后，才允许标 `not-covered`；未覆盖原因必须写**实际查询结果**（如「按电话找不到」「Volza 只返回同名别家」），不是一句「未覆盖」。同名不同公司不得合并。

## 七、降级做法（查不到时）

- **域名无法解析**：whois CLI → Wayback；仍无 → 「未查到，域名无法解析」。
- **公司名搜不到痕迹**：以身份锚点全缺为准判「需人工核实」，不得编造；询盘期不索要执照，用委婉话术只要官网/企业邮箱。
- **制裁名单无缓存**：运行 `update_sanctions`；下载失败 → 官方网页手动检索，记录查询时间。
- **邮箱无邮件头**：标注「未提供邮件头，该项无法核实」。
- **通用规则**：查不到只标「未查到」（降置信度），不阻塞其他模块；**只有积极矛盾才计分（D7）**。
## 八、官网画像（有公司名/工作邮箱时优先做）

1. **取域名**：从工作邮箱后缀取域名（如 `ahmet@unitytechelectronic.com.tr` → `unitytechelectronic.com.tr`）；**邮箱域名不一定是官网**，官网可能是 `unitytech.com.tr` 或其他变体。
2. **找官网**：公司名 + 国家/城市搜索；同时检查域名变体（`.com.tr` / `.com`、去掉/增加 `electronic`、连字符）；用 Google/Brave/DDG 比对「公司名 ↔ 域名」。
3. **抓画像**：主页 / About / Products / Contact；提取公司简介、主营产品、目标市场、成立年份、地址、电话、邮箱。
4. **交叉验证**：官网联系页的**姓名 + 电话**是否与客户提供一致；一致 → 高置信度。邮箱域名不同但姓名/电话/公司名一致 → 标注「邮箱域名与官网不同，需确认」，**不直接判伪**。
5. **不可达**：Wayback → 搜索引擎摘要 → 标未查到；不得编造简介或产品。
6. **输出**：公司画像（主营/市场/地址/联系人匹配）写入报告与结论卡的正向证据。