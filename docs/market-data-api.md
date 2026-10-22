# 跨服务器公共股票数据 API

## 两台服务器的分工

原服务器保存股票公共数据库，继续运行采集、补齐和定时更新。新服务器仅通过原服务器的 `GET /api/market/data` 或只读查询 `POST /api/market/data` 获取结构化数据，无需迁移或同步整套股票数据库。账号、自选、笔记、AI 密钥和后台执行凭证不通过此接口共享。

此接口提供网站已支持的数据与原始记录；不保证数据库拥有所有股票、所有历史时期或来源没有披露的字段。缺失返回 404 或原业务接口的缺失状态，未知数值仍为 null。保留来源、币种、单位、报告期、交易日期、复权方式及过期标记。公告和报告返回结构化目录、原文链接或已有文本，不传 PDF 文件内容。

## 原服务器部署

1. 部署包含本次接口的代码，继续使用原有 PostgreSQL/公共市场库和更新执行器。
2. 配置 `MARKET_DATA_API_TOKEN` 为不少于 32 字符的随机密钥。未配置独立密钥时兼容已有 `MARKET_READONLY_TOKEN`，不在代码中保存明文。
3. 原服务器保持默认数据模式，不能设置 `MARKET_DATA_MODE=remote`。
4. 仅以 HTTPS 提供接口。API 密钥只交给新网站后端及经授权的诊断客户端。
5. 使用请求头 `x-fin-data-token: <密钥>`，也接受 `Authorization: Bearer <密钥>`。查询串中的 token、api_key 或 SQL 会被拒绝。禁止向浏览器发送该密钥。

默认接口地址示例：`https://a3f223f4c7a12db85.app.workbuddy.host/api/market/data`。只有原服务器实际部署并配置后该地址才可用；本地测试通过不代表线上已发布。

## 资源和用法

认证后调用 `?resource=catalog`，返回完整资源目录、允许的方法和可枚举原始数据类型。

| resource | 内容 | 常用参数 |
| --- | --- | --- |
| quote | 单只/批量行情，含当前 PE/PB 等 | code 或 codes（每次最多 200） |
| kline | 不复权/前复权/后复权历史 K 线 | code、period、adjust、count、start |
| minute | 分时 | code |
| valuation | 历史估值、分位和缓存好的走势图 | code、years=5 或 10、method=disclosure 或 cutoff |
| financial | 财务摘要，保持现有来源和派生口径 | code |
| finance-fields | 全量财务字段目录 | code |
| finance-compare | 多期财务指标和三张报表字段 | codes、fields、years、granularity；支持 POST JSON |
| dividend-yield | 股息率与计算依据 | codes |
| deducted-pe | 扣非 PE 与季度范围 | codes |
| records | 已入库的全量原始记录与派生缓存 | key、keys 或 prefix；支持分页和历史版本 |
| company-profile / analysis | 公司资料、既有解析与经营信息 | code |
| company-window / announcement-content | 公告目录及已提取内容 | codes / artCode |
| financial-reports | 报告目录与原文链接 | code、calendarYear |
| company-learning | 公司披露资料；POST 仅允许 action=pool | code、view；或 pool 查询 |
| market / industry / sw-industry / hk-industry | 大盘及行业数据 | 沿用原站同名接口参数 |
| peers / search / screen | 同行、搜索、只读条件筛选 | code / q / 原筛选 JSON |
| hk-valuation | 港股当前估值计算依据 | code、可选 price、asOf |
| health | 原站数据源状态 | 无 |

业务接口的参数、内容和缺失含义与原站 `/api/<resource>` 一致，避免新网站另建不同计算口径。多数结果为 `{ok:true,data:...}`；既有 analysis 接口保留原来的结构。错误有相应 HTTP 状态码。所有受保护响应为 `private, no-store`，不允许 CDN 公共缓存；源站既有估值结果缓存仍会复用，数据原始时间和缓存时间不会改写成调用时间。

### 读取全量已入库股票数据

1. 用 catalog 的 `recordFamilies` 获取所有公共记录类型。
2. 对每个类型请求 `?resource=records&prefix=kline:v2:&limit=20&payload=1`（以 K 线为例）。
3. 返回 `data.records` 与 `data.nextCursor`。把游标原样放入下一页的 `after`，直到 nextCursor 为 null。不同类型的游标不能混用。
4. 若只查元信息，使用 `payload=0`，每页最多 200 条；完整内容每页最多 20 条。
5. 可用 `key` 读取一条，或 `keys` 一次读取最多 20 条；`key=...&versions=1` 最多读取 4 个历史版本。

常见原始类型包括行情、A 股三表全字段、港股报表、指标、实际分红、分红方案、股本变动、公告日期、有息负债比率与利息费用等。估值结果、当前展示指标也可读取。请求只是按需返回 JSON，不会在新服务器自动导入整套数据库。正在更新的数据库不提供全库同一时点事务快照；单条记录保留 digest 与 acquiredAt。

原始记录采用明确的公共键白名单。系统队列、执行凭证、账号、自选注册、导入日志、运行日志、租约和个人资料均不开放，也不接受任意 SQL 或文件路径。

## 新服务器使用远程模式

```dotenv
MARKET_DATA_MODE=remote
MARKET_DATA_API_URL=https://original-site.example/api/market/data
MARKET_DATA_API_ACCESS_TOKEN=<与原服务器一致的密钥>
```

部署同一网站代码时，中间层会将公共数据请求转至统一接口；服务端渲染的行情、财务、估值等也走 API。接口不可用、鉴权失败或版本不符会明确报错，不会读取本地快照、下载包或本地市场数据库。原始记录诊断读取也转至 API。源服务器接口未部署前不要切换此模式。

远程模式禁止本服务器写入市场库，补齐/导入/股票更新由原服务器完成。新服务器不启动市场 worker，也不替换自己的个人账号库。公司资料池查询可远程共享，AI 文本生成与个人账户接口不属于共享数据协议。服务器后端调用 API 不需要浏览器跨域授权，密钥不会下发浏览器。

原服务器的接口不能指向消费者自身；消费者也不能作为下一层数据源，避免反复转发。客户端不跟随 HTTP 重定向，避免密钥被转送到其他地址。默认远程请求最多等待 90 秒，超过上限返回失败，用户可以稍后重试已经生成的缓存结果。

## 运行边界

- 每个实例、每个有效凭证每分钟最多 240 次，并发最多 8 次；返回 429 时按 Retry-After 等待。多实例全局配额需在部署网关配置，本实现不宣称跨实例共享计数。
- POST 查询体最多 64 KiB；JSON 响应最多 32 MiB；大范围数据按记录类型和游标拆页。
- 本地 HTTP 仅允许 localhost/127.0.0.1/IPv6 回环，正式跨服务器连接必须 HTTPS。
- 同源身份 Cookie、Authorization、个人 AI 密钥不会被浏览器转发链携带；服务器使用独立 API 请求头鉴权。
- 不记录 API 密钥，不把内部存储异常和连接地址返回给浏览器；原始记录有来源与校验摘要，结构校验不代表已人工核验原始披露。

## 后续维护与诊断

线上数据核对统一请求本接口，不能用本地示例、旧下载包或隔离夹具替代线上证据。密钥从环境或忽略配置读取；日志只输出资源、股票代码、状态、日期和摘要，禁止输出请求头和完整连接凭证。保留原 `/api/market/db` 作为旧版诊断兼容入口，正式网站复用接口使用 `/api/market/data`。
