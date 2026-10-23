# A股批量导入接口

批量导入在原数据服务器执行，沿用 `MARKET_MAINTENANCE_TOKEN`。不需要新增数据库表或开放数据库端口。导入使用独立持久队列，不占用每日/周日采集任务槽位。

## 部署

1. 拉取包含本功能的最新代码，执行 `npm ci`、`npm run build`，重启原数据服务器的应用进程。保持原有数据库连接与维护令牌。
2. 重启现有 `npm run market:worker` 服务：它现在会同时推进批量导入队列。此服务已有的 `MARKET_UPDATE_ORIGIN`、`MARKET_UPDATE_WORKER_TOKEN` 和服务端 `MARKET_UPDATE_WORKER_ENABLED=1` 配置继续使用。
3. 大批量导入可另外启动 `npm run market:import:worker`。它使用 `MARKET_IMPORT_ORIGIN`（或 `MARKET_UPDATE_ORIGIN`）及 `MARKET_UPDATE_WORKER_TOKEN`（或 `MARKET_MAINTENANCE_TOKEN`），只推进导入队列。多个执行器通过数据库租约协调，每次最多处理5只，最多运行约20秒后让出；单只重建可能另用30秒。按常驻服务管理执行器，关闭网页不影响任务。
4. 导入端可用 `npm run market:import:batch -- --input batch.json --wait --report result.json` 提交并查看结果。导入端环境变量为 `MARKET_IMPORT_ORIGIN` 和 `MARKET_MAINTENANCE_TOKEN`。凭证只放环境变量，不放Git、JSON文件或URL。
5. 首次验收用少量已导入股票重复提交：应显示 `unchanged`，确认任务进度、来源凭据和回读结果后再分批处理全A。提供 `--drive` 可由维护端主动推进后台tick，适合部署验收；正常运行推荐常驻服务器执行器。

代码推送不代表服务器已部署。`POST` 返回202表示接收成功，任务完成须以 `GET` 的最终状态与逐股票结果为准。`workerConfigured` 仅表示服务端开关已配置，不证明执行器进程在线。

## 提交：POST /api/market/import-batch

请求头 `x-fin-maintain-token` 或 `Authorization: Bearer ...`，正文为JSON；支持 `Content-Encoding: gzip`。压缩前后均最多8MiB，每批最多50只A股、1500个导入项。大包必须拆批，不能通过压缩绕过解压体积限制。

```json
{
  "idempotencyKey": "qmt-20261023-group-001",
  "proof": {
    "source": "qmt",
    "reference": "QMT导出批次20261023，原始文件校验通过",
    "files": [{"name": "package_index.json", "sha256": "填写实际文件的64位SHA256"}]
  },
  "rebuild": true,
  "items": [
    {"type": "finance", "record": {
      "symbol": "002705", "statement": "profit", "unit": "wan", "currency": "CNY", "basis": "cumulative",
      "reportDates": ["2016-06-30", "2016-09-30"],
      "items": [{"name": "归属于母公司所有者的净利润", "vals": [14233.261354, 32696.523997]}]
    }},
    {"type": "a-indicators", "record": {
      "symbol": "002705", "year": 2023,
      "items": [{"date": "2023-12-31", "indicator": "资产负债率(%)", "value": 30}]
    }}
  ]
}
```

以上为结构示例，指标数值不作为来源证明，使用前须换成已核验的实际值与文件校验码。

支持现有A股导入类型：`finance`、`financial-history`、`a-indicators`、`disclosure-dates`、`share-history`、`dividend-plans`、`dividend-impl`、`kline`。`record` 沿用单条导入格式。日线只支持不复权日线，来源须为qmt或tdx；财务金额使用人民币万元累计值；实际股数使用股；首次披露日期须经独立核验，不能把QMT修订日期直接映射为首次公告。QMT来源批次禁止提交disclosure-dates或非空finance.announceDates；真实公告日期须使用公告证据单独导入。现有保留窗口及合法日期/单位校验继续生效；扩大本地下载范围不会自动扩大网站图表或写入保留范围。

同一令牌、同一幂等键、同一内容重复提交返回原任务，避免重做；同一键提交不同内容返回409。创建返回202，重复返回200。请求只做范围与形状检查，逐股票完整内容校验在后台执行，因此202不保证每个导入项均有效。

## 进度：GET /api/market/import-batch?jobId=...

仍须维护凭证，仅返回该令牌创建的任务。返回 `total/imported/unchanged/pending/failed/conflicts/finished` 和逐股票结果；任务正文及所有凭证不在进度响应中返回。

股票写入状态：

- `imported`：提交的变化已回读验证。
- `unchanged`：输入与已有有效事实一致，无需重写。
- `conflict`：已有有效值不一致，整只股票在暂存校验阶段阻止写入；不会阻止本批其他股票。
- `error`：校验、存储或回读失败。提交期间失败可能已有部分记录成功，结果明确保留为失败，重试从数据库重读合并。

任务状态 `queued/running/rebuilding/completed/completed_with_issues`。`finished` 不等于所有网站输入齐全。默认所有股票写入结束后集中推进重建，每只只重建一次；缺少首次披露记录的股票直接标记 `validation.blocked`。设置 `rebuild=false` 只验收写入，不代表历史估值可用。

## 重试与停止

`POST` 同一接口：

```json
{"action":"retry","jobId":"任务编号"}
```

只重试存储/校验失败的股票以及重建错误，不重做已完成股票。数值冲突须核对后改用新输入与新幂等键，不会用重试授权覆盖旧值。

```json
{"action":"cancel","jobId":"任务编号"}
```

取消会停止后续股票；正在提交的单只股票可能完成，不回滚已核验数据。任务可查询7天；任务正文和状态在30天后可由现有维护器清理，逐项来源凭据不会随200条接口日志滚动丢失。

## 写入方式与一致性

服务器按股票预取全部涉及记录，在内存中调用现有类型校验和合并器；检查全部原有效值保留（包括0和常见科目别名）。该股票全部导入项通过后，非K线记录经适配层 `writeInputs` 批量CAS提交，随后批量回读核对digest；K线使用现有专用事务路径，保留较新的尾部行情。

原始财务页和指标兼容现有读取键；新补的单元格记录 `fieldSources`，关联 `market-import-proof:v1:<任务>:<股票>` 的源文件SHA256、参考说明、变更记录和回读结果。重复提交不替换已有来源。

单只股票的暂存校验是整体的；底层提交不能保证整个批次原子事务。并发CAS冲突会重新读取并合并，最多3次；部分提交、中断或提交后响应丢失都通过回读确认，未确认绝不报成功。后台崩溃后租约最多10分钟过期，由下一执行器重放未完成股票。文件适配器仅支持单进程预览；多进程、多副本使用已有PostgreSQL协调存储。

## 验收

- `node --test scripts/tests/market-batch-import.test.mjs scripts/tests/market-batch-route.test.mjs`
- `npm run typecheck`、`npm test`、`npm run build`
- 部署后：少量真实股票重复导入，确认无新写入、原有效值不变，查询任务结束状态；再用原300只分6批验收。不要用本地模拟通过来代替线上验收。
