# 素材扩展台

一个本地单用户工具，用于为多模态大模型后训练收集、筛选并导出广告图片素材。工具支持广告主商品层级标注和内容审核多标签两类任务，通过 23 个可免费查询、免费获取候选图片的 API 来源聚合素材，并把人工审核后的图片与来源、授权状态和校验信息一起导出为 ZIP。

> 搜索结果只用于发现候选素材。来源记录、提供方返回的许可信息和用户确认都不自动等同于取得版权、存储或训练授权；导出前仍需按你的合同与素材权利情况核验。

> 当前这轮渠道扩充只按“可以免费查询并由工具尝试下载图片”纳入，不把授权范围或可训练性作为渠道筛选条件。程序仍会原样保留来源页、原始提供方、许可描述、权利状态和文件校验等溯源字段，便于后续再做治理。这里的“免费”指无需付费即可使用匿名接口、免费额度或免费申请入口；不承诺无限额度，也不代表结果图片具有免费商用或模型训练授权。

## 本地启动

需要 Node.js 24 或更高版本。安装依赖并准备本地环境变量：

```bash
npm install
cp .env.example .env
npm run dev
```

开发模式同时启动 Vite 前端和仅监听 `127.0.0.1:8787` 的 Fastify 后端。浏览器访问 `http://127.0.0.1:5173`。

生产模式先构建，再由 Fastify 同时提供 `dist/client` 单页应用与 `/api/*`：

```bash
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:8787`。`dev` 和 `start` 都会通过 Node.js 24 的 `--env-file-if-exists=.env` 读取可选 `.env`。不创建 `.env` 也能启用 12 个免 Key/可选 Key 来源；其中 Openverse、Open Food Facts 和 Microsoft Bing Ad Library 默认勾选，其余来源可在工作台的来源选择器中开启。Wikimedia Commons 仍然免 API Key，但必须先在 `.env` 显式设置合规的单行 `WIKIMEDIA_USER_AGENT` 才会启用并进入默认选择；值中需包含你自己的联系 URL、邮箱，或 `(项目名; User:用户名)` 形式的 Wikimedia 用户联系信息。留空或值不合规时只会禁用 Wikimedia，不会阻止应用启动。应用不会生成或猜测你的联系信息。

本应用按本地单进程、单实例运行设计。不要让多个进程同时使用同一个 `DATA_DIR`；退出旧进程后再启动新实例，也不要干预正在生成的临时导出目录。

### 企业级远程代理

公司内网服务器必须经过统一出口代理时，先确认代理能够访问外部 API，例如 `curl -x http://proxy.example.com:8080 -I https://api.openverse.org` 返回成功状态；然后仅在本机 `.env` 中显式配置：

```dotenv
NODE_USE_ENV_PROXY=1
ALLOW_REMOTE_ENV_PROXY=1
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
```

请把示例域名和端口替换为公司实际提供的值，不要提交 `.env`。未设置 `ALLOW_REMOTE_ENV_PROXY=1` 时，程序仍只接受 `127.0.0.1`、`localhost` 或 `::1` 上的本地代理；该开关只应用于你明确信任的企业代理。修改代理配置后需要重启应用。

## 搜索提供方

当前生产注册表共有 23 个来源。通用图片和公共馆藏来源可扩大视觉风格、商品外观或包装图的召回；Open Food Facts 更偏商品包装；Bing、Snap 和 TikTok 是广告资料库。搜索时仍需用“电商广告、促销海报、商品展示”等风格词约束结果，并在工作台人工筛选。

### 免 Key 或可选 Key：13 个

其中 12 个来源在没有 `.env` 提供方变量时即可启用。Smithsonian 会自动使用官方 `DEMO_KEY`；配置免费的个人 Key 可以获得更适合持续使用的额度。Wikimedia 不要 API Key，但要求运行者显式提供带联系信息的 `WIKIMEDIA_USER_AGENT`。

| 提供方 | 内部 ID | 类型 | 环境变量 | 免费使用说明 | 官方文档 |
| --- | --- | --- | --- | --- | --- |
| Openverse | `openverse` | 通用图片 | 无 | 匿名公开 API | [API 指南](https://docs.openverse.org/api/guides/) |
| Wikimedia Commons | `wikimedia` | 通用图片 | 必填 `WIKIMEDIA_USER_AGENT`（非 Key） | 匿名公开 API；User-Agent 必须包含本人联系 URL、邮箱或 Wikimedia `User:` 用户名，留空或不合规时禁用该来源 | [MediaWiki Imageinfo](https://www.mediawiki.org/wiki/API:Imageinfo) |
| The Metropolitan Museum of Art | `met` | 公共馆藏 | 无 | 免 Key；官方限速 80 请求/秒 | [Collection API](https://metmuseum.github.io/) |
| Cleveland Museum of Art | `cleveland` | 公共馆藏 | 无 | 匿名公开 API；单页最多 1,000 条 | [Open Access API](https://openaccess-api.clevelandart.org/) |
| Art Institute of Chicago | `artic` | 公共馆藏 | 无 | 匿名公开 API；官方建议图片串行下载 | [API 文档](https://api.artic.edu/docs/) |
| Library of Congress | `loc` | 公共馆藏 | 无 | 匿名公开 JSON API；服务端动态限流 | [JSON/YAML API](https://www.loc.gov/apis/json-and-yaml/) |
| NASA Image and Video Library | `nasa` | 公共馆藏 | 无 | 免 Key；官方未公布固定额度 | [API 文档 PDF](https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf) |
| Internet Archive | `internet_archive` | 公共馆藏 | 无 | 免 Key；需遵守公平使用和 429 退避 | [开发者文档](https://archive.org/developers/) |
| Open Food Facts | `open_food_facts` | 商品/包装 | 无 | 匿名读取；搜索限 10 次/分钟/IP | [API 文档](https://openfoodfacts.github.io/openfoodfacts-server/api/) |
| Smithsonian Open Access | `smithsonian` | 公共馆藏 | 可选 `SMITHSONIAN_API_KEY` | 未配置时使用 `DEMO_KEY`：每 IP 30 次/小时、50 次/天；个人 Key 可免费申请 | [Open Access API](https://edan.si.edu/openaccess/apidocs/) |
| Rijksmuseum Data Services | `rijksmuseum` | 公共馆藏 | 无 | 免 Key；当前 Data Services 未公布固定额度 | [Search 文档](https://data.rijksmuseum.nl/docs/search) |
| Microsoft Bing Ad Library | `bing_ads` | 广告资料库 | 无 | 匿名公开 API；频率限制较严 | [Ad Library API](https://learn.microsoft.com/en-us/advertising/guides/ad-library-api?view=bingads-13) |
| Snap Ads Gallery | `snap_ads` | 广告资料库 | 无 | 匿名公开 API；当前适配器按广告主名称搜索 | [Ads Gallery API](https://developers.snap.com/marketing-api/Ads-Gallery-Api/using-the-api) |

### 免费 Key、免费账户或免费申请：10 个

在对应官网完成免费注册或审批后，把凭据写入本地 `.env`；必需变量全部存在时来源才会启用。免费额度和申请政策可能调整，以提供方控制台显示为准。

| 提供方 | 内部 ID | 类型 | 环境变量 | 免费使用说明 | 官方申请/文档 |
| --- | --- | --- | --- | --- | --- |
| 百度千帆图片搜索 | `baidu` | 通用图片 | `BAIDU_QIANFAN_API_KEY` | 免费额度以百度千帆控制台当期规则为准 | [百度搜索 API 文档](https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5) |
| SerpApi Google Images | `serpapi` | 通用图片 | `SERPAPI_API_KEY` | 免费账户含月度额度；具体额度以控制台为准 | [Google Images API](https://serpapi.com/images-results) |
| Europeana | `europeana` | 公共馆藏 | `EUROPEANA_API_KEY` | 免费申请 API Key | [获取 API Key](https://pro.europeana.eu/page/get-api) |
| Pexels | `pexels` | 通用图片 | `PEXELS_API_KEY` | 免费开发者 API Key；受官方请求速率限制 | [API 文档与 Key](https://www.pexels.com/api/documentation/) |
| Pixabay | `pixabay` | 通用图片 | `PIXABAY_API_KEY` | 免费账户 API Key；单次最多 200 条、每个查询最多 500 条 | [API 文档与 Key](https://pixabay.com/api/docs/) |
| Unsplash | `unsplash` | 通用图片 | `UNSPLASH_ACCESS_KEY` | 免费 Demo 应用额度；需注册开发者应用 | [Search Photos 文档](https://unsplash.com/documentation#search-photos) |
| Flickr | `flickr` | 通用图片 | `FLICKR_API_KEY` | 可申请免费 API Key；当前免费政策按官方账户规则执行 | [申请 Key](https://www.flickr.com/services/apps/create/) / [Photos Search](https://www.flickr.com/services/api/flickr.photos.search.html) |
| Harvard Art Museums | `harvard_art_museums` | 公共馆藏 | `HARVARD_ART_MUSEUMS_API_KEY` | 免费申请 API Key | [官方 API 文档](https://github.com/harvardartmuseums/api-docs) |
| Digital Public Library of America | `dpla` | 公共馆藏 | `DPLA_API_KEY` | 免费申请 API Key | [申请 Key 与 API 政策](https://pro.dp.la/developers/policies) |
| TikTok Commercial Content | `tiktok_ads` | 广告资料库 | `TIKTOK_CLIENT_KEY`、`TIKTOK_CLIENT_SECRET` | 免费申请并经平台审批；Client Token 有效期 2 小时，由后端自动刷新 | [申请入口](https://developers.tiktok.com/products/commercial-content-api) / [接入指南](https://developers.tiktok.com/docs/en/commercial-content-api-getting-started) |

凭据值只由本地后端读取，API、页面、日志和导出文件都不会返回密钥；设置页只展示环境变量名称和是否已配置。任何来源的 401、403、408、429、超时或服务错误只影响该来源；网络/代理错误、超时、408、429、5xx 以及提供方明确标记的临时错误会有限退避重试，并可在重启后继续。永久失败会在工作台按来源展示，可通过“重新尝试该来源”显式重跑，不会静默跳过。

Brave Images 和 DataForSEO 不属于持续免费的默认渠道，因此不进入上述 23 个生产来源，也不会因设置 `BRAVE_SEARCH_API_KEY`、`DATAFORSEO_LOGIN` 或 `DATAFORSEO_PASSWORD` 而出现在新任务的来源列表。程序仍识别旧数据库和旧导出中的 `brave`、`dataforseo` ID 与历史权利策略，避免已有任务失去兼容性。

## 使用流程

1. 新建“广告商品品类”或“内容审核”任务，输入每行一个层级标签，例如 `电商快销 > 3C及电器 > 影音电器 > 音箱`。
2. 设置中英文主商品查询词、图片风格、必须词、排除词、目标数量和候选数量。广告品类任务默认选择淘宝/天猫、京东、拼多多、唯品会、小红书和抖音电商；内容审核任务默认不限定平台。
3. 选择可用来源并开始搜索。系统通过官方 API 聚合候选、校验图片格式与尺寸、生成本地缩略图并保留完整来源链。单次继续操作最多调度 2,000 个查询运行；超大计划按同页断点分批推进，重复点击不会重复写入同一命中。
4. 人工选择、拒绝、换类或添加内容审核多标签，并按需确认授权依据。
5. 运行导出预检，处理权利、标签冲突和文件完整性阻断后生成 ZIP。

广告品类任务中，每张导出图片只能有一个叶子标签；内容审核任务允许多标签，并以 primary label 决定图片目录。降低安全搜索只对明确允许风险类别的内容审核任务生效，广告品类任务始终保持安全搜索。

平台定向是附加搜索策略，不会改变标签路径或导出标签。当前百度千帆会追加中文平台词，SerpApi 会追加 `site:` 域名约束；Openverse、公共馆藏、商品库和广告资料库等来源仍执行原查询。每个平台只基于对应语言的主商品词和主风格追加一个查询，不会与所有别名和次级风格做笛卡尔积；支持分页的 SerpApi 在“继续搜索”时沿用同一完整平台查询翻到下一页。

## 本地数据与安全限制

默认数据位于项目的 `.data/`，可通过 `DATA_DIR` 改到其他本地目录。目录包含 SQLite 数据库、原图缓存、缩略图和导出文件，请自行备份并按素材合规要求清理。

下载器只接受 HTTP/HTTPS 的静态 JPEG、PNG 和 WebP，并阻断本机、私网、保留地址、云元数据地址及不安全重定向。硬限制为 20 秒、25 MB、100 MP、任一边至少 128 px；设置页只能把这些限制收紧，不能放宽。HTML、SVG、动画、多页图和伪装文件会被拒绝。直连模式会把连接固定到已校验的公网 DNS 地址；显式设置 `NODE_USE_ENV_PROXY=1` 时，程序要求同时提供有效的 `HTTP_PROXY` 和 `HTTPS_PROXY`，默认只接受本机回环地址。只有再设置 `ALLOW_REMOTE_ENV_PROXY=1` 才会接受远程企业代理。代理模式会主动忽略 `NO_PROXY`，避免外部下载退回未固定 IP 的直连；程序仍会在本机预检每一跳 URL、DNS、公网地址和重定向，但代理会再次解析目标域名，因此远程模式只应使用公司明确提供并由你信任的代理。

`ALLOW_TEST_FIXTURES` 只供自动测试使用。应用仅在 `NODE_ENV=test` 且 `ALLOW_TEST_FIXTURES=1` 时启用固定的本地测试图片；开发或生产环境中设置该变量会直接拒绝启动。

## 导出内容

ZIP 包包含：

- `images/`：安全重编码后的图片；
- `manifest.jsonl`：标签、来源、哈希、许可、质量检查和人工审核记录；
- `taxonomy.json` 与 `dataset.json`：标签树和不可变导出审计快照；
- `checksums.sha256`：全部图片与元数据文件的校验值；
- `reports/acquisition_summary.json` 与 ZIP 内的 `README.md`。

生成完成前会流式复核每个文件的哈希，并校验 ZIP/ZIP64 的中央目录、文件名集合与尾部记录；结构不完整的包不会被标记为可下载。

“严格合规”模式只导出已验证的 CC0/PDM、自有或有明确许可证据的素材。“内部研发”模式允许对权利未知素材进行明确确认，但不能绕过提供方合同、非法内容、技术安全阻断、文件缺失或广告品类跨叶子冲突。

## 验证

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

端到端测试会启用固定的测试提供方和本地图片，不访问真实搜索平台，也不会读取或输出真实 API 密钥。

如需对最多 13 个免 Key/可选 Key 来源做小流量真实联网抽查，可运行 `npm run smoke:free`；未配置合规 `WIKIMEDIA_USER_AGENT` 时会自动跳过 Wikimedia，共抽查 12 个来源。该命令会实际调用外部搜索 API，并把首批可用图片经过与正式下载相同的安全与格式校验；它可能消耗匿名限额或遇到平台临时限流。使用代理时，请先按 `.env.example` 设置 `NODE_USE_ENV_PROXY`、`HTTP_PROXY` 和 `HTTPS_PROXY`；远程企业代理还需设置 `ALLOW_REMOTE_ENV_PROXY=1`。
