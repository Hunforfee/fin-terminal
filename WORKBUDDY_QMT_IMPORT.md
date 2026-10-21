# QMT 数据包：本地与服务器共用的导入流程

本轮未操作生产数据库。部署时必须使用包含本文件、导入工具及 canonical 行情读取逻辑的同一版代码，不能只把数据写入旧版网站。

本地验收（2026-10-21）：370 项回归及生产构建通过；544 只、635,843 条导入并重复回读通过，数据库读取检查未调用历史行情网络。PostgreSQL 适配器以本地隔离引擎验证 3 只、3,606 条，真实构建的 HTTP 接口核对普通股票和新上市股票通过。上述不代表已连接或验收生产服务器。

## 本次范围与交接文件

- 私有清单去重 788 只：A 股 544、港股 244。只覆盖这份清单，不采集全市场。
- `full_result.zip`：544 只 A 股，635,843 条不复权日线，请求区间 2021-10-21 至 2026-10-20；不同上市日期的实际起点不同。
- 包内 `manifest.json` 保存全部证券范围、实际起止、逐文件 SHA256 和下载结果。前复权参考及除权因子保留供核对，本次不导入为网站复权、财报或股息计算输入。
- 港股 244 只未在本包完成，见 `website_pending_hk.json`。财报、股本、已实施分红及其披露日仍由网站后台补齐。
- 红太阳 `sz000525` 有停牌间隔，保留原始覆盖警告。发行人公告确认 2024-11-11 停牌、2024-12-13 复牌：[原始公告](https://static.cninfo.com.cn/finalpage/2024-12-13/1222007211.PDF)。不能填充虚构交易日。

数据包和导入报告通过私有文件渠道交接，不提交 Git，不放 `public/`、镜像构建上下文或公开下载目录。WorkBuddy 不能直接读取用户电脑的 D 盘；用户须提供实际 ZIP 文件。包内包含私人自选范围。

## 部署前准备

1. 部署包含本轮改动的代码。普通部署运行 `npm ci`、`npm run build`；构建会生成 `.market-importer/`。Docker 镜像已包含运行导入器及后台 worker 所需文件；不要单独在精简的 Next standalone 输出里找脚本。
2. 将 ZIP 上传服务器私有持久目录，解压为例如 `/srv/fin-data/qmt-20261020/`；该目录直接包含 `manifest.json`、`raw/` 等。不要把外层目录误当输入目录。目录和报告目录需允许执行导入的服务账号访问。
3. 对市场数据库做可恢复备份。通过服务器私密环境变量配置 `MARKET_DATABASE_URL`；必须与网站及 worker 指向同一市场数据库。若未设置，工具沿用 `DATABASE_URL`。连接串不要发到聊天或报告中。
4. 在网站运行环境或同一镜像中执行以下命令。显式 `--database` 才允许写 PostgreSQL；不能使用用户电脑的文件适配器目录代替服务器库。

## 先检查，再导入，再回读

以下命令在应用根目录运行，路径替换为服务器实际路径。

```sh
# 检查全部文件校验码、证券、币种、OHLC、日期及与已存行情的价格冲突。
# 不写入行情。首次连接可能初始化市场存储表结构。
npm run market:import -- --input /srv/fin-data/qmt-20261020 --database --report /srv/fin-data/qmt-preflight.json

# 预检无冲突后执行；每家公司写入后从目标库回读比对。
npm run market:import -- --input /srv/fin-data/qmt-20261020 --database --apply --report /srv/fin-data/qmt-import-result.json

# 再执行一次：已存在的相同数据会跳过，保留原采集时间。
npm run market:import -- --input /srv/fin-data/qmt-20261020 --database --apply --report /srv/fin-data/qmt-import-recheck.json
```

首次空目标应为 `imported=544, verified=544, totalBars=635843, conflicts=0`；重复导入应为 `imported=0, unchanged=544, verified=544`。已有数据时首次也可能部分或全部 `unchanged`。价格不一致或已有导入范围更短的公司不会被自动覆盖：退出码 2，查看报告的 `conflicts`；其他错误退出码 1。失败后可重复运行，相同公司会跳过。报告不含数据库连接串。

工具写入共享 `MarketStore`，使用事务、版本校验及同一逐日存储逻辑；不要自行拼 SQL 写 JSON。行情键为 `kline:v2:<symbol>:day:none:canonical:prices-only`，逐日价格在 `fin_market_bars`，元数据和来源在 `fin_market_records`。这不是把 ZIP 存进数据库，也不是线上定时复制本地数据库。

## 确认网站真的使用了服务器数据

1. 检查导入报告的 `target=server-postgresql`、回读数量及冲突数。还须确认网站和导入命令使用同一环境变量来源，不能只看命令运行成功。
2. 抽查 `sh600415`、`sz000923` 和停牌样本 `sz000525`，证券名称和代码以包内清单为准。
3. 在数据库读取模式的隔离验收实例，访问 `/api/kline?code=600415&period=day&adjust=none&count=1500&start=2021-10-21`；应返回数据库持久存储信息、真实日期及原价，并且不调用历史行情接口。日线序列来源 `canonical`，原始来源 `qmt` 在存储元数据中，后续接口更新保留各自来源分段。
4. 可核对以上 canonical 键在 `fin_market_records` 的证券数及对应 `fin_market_bars` 数量。本包刚导入的基准是 544/635843；运行更新后末尾新增的交易日会使总条数增加，勿将变化直接判定为重复。
5. 真实账号同步这份自选清单，分组点击「补齐5年」，补齐其余财务和估值输入。QMT 原价成功不代表 PE、PB、股息和前复权数据已经齐全。尚未完成前，不要全站开启 `MARKET_READ_MODE=database`。

## 后续自动维护

按 `WORKBUDDY_MARKET_UPDATES.md` 与 `docs/market-five-year-handoff.md` 部署独立 worker，配置私密执行器密钥和 `MARKET_CLOSE_UPDATE_ENABLED=1`。用户真实自选登记后，按北京时间 18:30 更新、次日 06:30 补偿。原价须与接口重叠日核对后增量续接，前复权保持完整窗口一致性；不依赖用户电脑持续开 QMT。

保持最多十年滚动清理；当前页面默认五年。生产环境禁止 `MARKET_UPDATE_LOCAL_PREVIEW=1`。数据库模式最终切换需在财报、估值、股息样本及完整性验收后进行。上线与 worker 验收由 WorkBuddy 在实际服务器执行，本地通过不等于服务器已经部署成功。
