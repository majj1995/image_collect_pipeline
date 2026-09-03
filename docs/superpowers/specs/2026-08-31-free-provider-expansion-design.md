# 免费图片来源扩展设计

日期：2026-08-31  
状态：用户已授权自主实现，仅做最终功能验收

## 1. 目标

把本地“素材扩展台”从 5 个来源扩展为一个可继续插入新来源的免费图片查询与下载目录。本轮按用户要求，只以“可以零费用查询，且 API 结果可得到图片文件或可下载的图片 URL”为纳入标准；暂不用授权范围或是否可训练作为渠道纳入门槛。

现有的来源、许可和导出元数据保留，不因本轮扩展删除；用户仍可在内部研发模式中审核和导出自己确认的素材。

## 2. “免费渠道”的工程定义

纳入：

- 无需密钥的公开 API；
- 可免费申请 API Key、Access Token 或开发者审批的 API；
- 官方提供免费持续额度的搜索 API；
- 可通过官方可查询清单或元数据 API 定位图片文件的公开数据源。

不纳入默认免费模式：

- 只有一次性试用金、试用后必须充值的来源；
- 必须绑定付费账户，免费金用完后可自动扣费的来源；
- 只返回 HTML 快照、没有稳定图片资源 URL 的广告库；
- 需抓取网页 DOM、绕过登录、验证码、防盗链或反机器人机制的站点。

Brave Images 和 DataForSEO 适配器保留以兼容旧数据，但不再进入新安装的免费默认注册表。

## 3. 来源分组

### 3.1 无 Key，安装后可用

- Openverse
- Wikimedia Commons
- The Metropolitan Museum of Art
- Cleveland Museum of Art
- Art Institute of Chicago
- Library of Congress
- NASA Image and Video Library
- Internet Archive
- Open Food Facts
- Smithsonian Open Access（默认使用官方 `DEMO_KEY`，可选换成免费个人 Key）
- Rijksmuseum Data Services
- Microsoft Bing Ad Library
- Snap Ads Gallery

### 3.2 免费 Key 或免费账号，配置后可用

- 百度千帆图片搜索
- SerpApi Google Images 免费档
- Europeana
- Pexels
- Pixabay
- Unsplash
- Flickr
- Harvard Art Museums
- Digital Public Library of America（DPLA）

### 3.3 免费申请/审批的广告库

只有在官方 API 能返回可下载图片资源时才接入。本轮接入可匿名搜索的 Microsoft Bing Ad Library 和 Snap Ads Gallery，以及需免费审批凭据的 TikTok Commercial Content API。只有广告快照或无稳定图片字段的 Meta Ad Library 等来源仅记录为未支持，不制造“可下载”假象。Amazon Berkeley Objects 和 Open Images 没有官方在线搜索 API，留待后续“离线数据集导入”，不伪装成 live provider。

## 4. 统一提供方目录

每个适配器除现有搜索能力外，必须声明：

- `credentialMode`: `none | optional | required | approval`；
- `credentialVariables`: 后端所需环境变量名，绝不返回变量值；
- `sourceCategory`: `general | culture | commerce | ad_library`；
- `freeTier`: 简短、可读的免费额度或申请说明；
- `docsUrl`: 官方 API/申请页；
- `defaultSelected`: 是否默认加入新一轮搜索。

注册表依据 `credentialMode` 统一判断是否启用：`none` 和 `optional` 默认启用；`required` 和 `approval` 只在所有必需环境变量存在时启用。

## 5. 搜索与下载行为

- 每个适配器必须使用官方 API，将结果归一为现有 `NormalizedHit`。
- 优先返回原图或官方大图 URL；没有原图时才回退到官方预览图。
- 需要二段请求的 API（如先搜索 ID 再查作品详情）必须有有界数量、超时、失败隔离和分页上限。
- 搜索失败只标记当前来源，不丢弃其他来源已获得的候选。
- 图片仍经过现有 SSRF、大小、像素、格式和重定向检查后才落地。
- 不实现任何付费调用或自动升级套餐；达到第三方免费额度后，请求按该来源的 429/403/配额错误失败并在页面显示。

## 6. 前端

### 6.1 工作台来源选择

“继续搜索”旁增加来源选择器：

- 按无 Key、免费 Key/账号、审批 Token 呈现；
- 只显示当前可用来源为可勾选，未配置来源给出配置提示；
- 支持全选、清空和“仅选无 Key”；
- 初始只勾选 `defaultSelected` 来源，避免一次点击消耗所有免费额度；
- 重试某个失败来源时仍只调度该来源。

### 6.2 设置页

设置页显示来源类型、免费方式/额度、状态、所需环境变量和官方申请链接。前端仍不接收、输入或保存密钥值。

## 7. 兼容与安全

- 扩展 `ProviderId` 但不删除旧 ID，保证旧 SQLite 数据和导出快照仍可读。
- 合同声明从硬编码对象改为只允许已知 Provider ID 的可扩展部分记录。
- 入参最大来源数跟随注册表上限，仍拒绝重复 ID 和非法 ID。
- API 密钥、Token、签名查询参数不得进入候选、日志、前端响应或 ZIP。
- 保留每个来源串行、全局最多 4 个搜索请求和 4 个下载的现有上限。

## 8. 验收标准

1. 在空密钥环境中，提供方页面能列出并启用所有无 Key 来源。
2. 在配置免费 Key/Token 后，对应来源自动变为可选，且任何 API 响应不泄露密钥值。
3. 每个新适配器均有官方响应形状夹具、请求参数测试和归一化结果测试。
4. 至少对每个无 Key 来源运行一次真实小流量搜索，并对可获得的图片 URL 做安全下载探测。
5. 用户可在工作台选择来源，搜索、预览、筛选和 ZIP 导出主流程不回归。
6. `npm test`、`npm run typecheck`、`npm run build`、`npm run test:e2e` 全部通过，并完成桌面与移动端浏览器验收。
