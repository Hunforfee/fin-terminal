#!/usr/bin/env node
/**
 * 港股上传数据包 → 站点数据库导入工具（WorkBuddy / 管理员侧执行）。
 *
 * 用法:
 *   node scripts/hk-upload-import.mjs convert <dataDir> <outDir> [--as-of YYYY-MM-DD]
 *   node scripts/hk-upload-import.mjs import  <recordsDir> [--only hk00001,hk00005]
 *                        [--type hk-statements,hk-indicators,hk-dividend-events]
 *                        [--concurrency 4] [--dry-run]
 *
 * 输入（convert）：<dataDir>/{balance,income,cashflow,indicators,dividends}/*.json，
 *   东财 datacenter 原始响应信封 {url,fetchedAt,httpStatus,payload:{result:{data}}}。
 *   期望目录形态：解压后的「财务/data」目录（balance/income/cashflow/indicators/dividends）。
 * 输出（convert）：<outDir>/<type>/<NNN>-<symbol>[-<statement>].json，
 *   每条 = POST /api/market/import 的 body {type, record}。
 *
 * 口径与站点读取器严格同构（复刻 src/lib/datasource/ 的纯解析函数）：
 *   - 三大报表：parseHkStatementRows（date=STD_REPORT_DATE ?? REPORT_DATE 前10位；
 *     STD 系统性滞后一期的证券改按 REPORT_DATE 归位，与站点逻辑一致；
 *     itemCode=STD_ITEM_CODE，itemName=STD_ITEM_NAME ?? ITEM_NAME，amount=AMOUNT 数值或 null）
 *   - 主要指标：fetchAllHkIndicatorPoints 的 map（date=REPORT_DATE 前10位，raw=全部数值字段，
 *     kind/label 按 REPORT_TYPE 推导，currency=CURRENCY）
 *   - 分红事件：parseHkDividends（仅 ASSIGN_PROGRESS 已实施的现金派息，dps 仅解析已披露港元额）
 *   - 三大报表带 overwrite:true：全量快照修正站点旧 _PC 接口落入的人民币折算口径污染；
 *     并逐报告期附 completeReports 完整项目清单声明（上传包即原始来源全量，非 partial 补丁）。
 * 保留期：与 marketCutoff 一致（今天-10年），超期报告期/除息日预过滤，与站点抓取行为对齐。
 *
 * 导入会话：自签 fin_session（同 scripts/mcp-fill-gaps.mjs），Origin 用 APP_ORIGIN。
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const command = args[0];
const positional = args.slice(1).filter(a => !a.startsWith('--'));
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const fail = (message) => { console.error(`✗ ${message}`); process.exit(1); };

/* ---------------------------------------------------------------- 常量 */
// 数据快照日：上传包 fetchedAt 最大值；分红统计截止到该日。默认取今天。
const AS_OF = flag('--as-of', new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
const TODAY = AS_OF;
const cutoffOf = (today) => { // marketCutoff：今天-10 年（同月日，月末钳位）
  const [y, m, d] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y - 10, m, 0)).getUTCDate();
  return `${y - 10}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
const CUTOFF = cutoffOf(TODAY);

const summary = { asOf: AS_OF, cutoff: CUTOFF, types: {} };
const skipped = { statementBeforeCutoff: 0, statementFuture: 0, statementNoRows: 0,
  indicatorBeforeCutoff: 0, indicatorFuture: 0, indicatorNoRows: 0,
  dividendBeforeCutoff: 0, dividendFuture: 0, dividendNoRows: 0, dividendNotImplemented: 0 };

const num = (v) => { // 站点 num()：数值或数值字符串 → number，否则 null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};
const iso10 = (v) => { // 站点 reportDate()：取日期部分前 10 位
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

/** 遍历子目录全部批量文件，返回信封数组。 */
function* batchFiles(dataDir, sub) {
  const dir = path.join(dataDir, sub);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const d = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    yield { file: f, envelope: d };
  }
}

/* ------------------------------------------------ 三大报表（复刻 parseHkStatementRows） */
function parseStatementRows(rows) {
  // 与站点 parseHkStatementRows 同款：默认按 STD_REPORT_DATE ?? REPORT_DATE 归位；
  // 少数证券（实测 11 只）STD 系统性滞后一期（无 STD==REPORT 行且 REPORT 有 STD 没有的期），
  // 按 STD 会整链错位并丢失最新报告期，改按 REPORT_DATE 归位。
  const std10 = (r) => { const m = r.STD_REPORT_DATE ? String(r.STD_REPORT_DATE).match(/^(\d{4}-\d{2}-\d{2})/) : null; return m ? m[1] : null; };
  const rep10 = (r) => iso10(r.REPORT_DATE);
  const anyExact = rows.some(r => std10(r) !== null && std10(r) === rep10(r));
  const stdDates = new Set(rows.map(std10).filter(Boolean));
  const reportDates = new Set(rows.map(rep10).filter(Boolean));
  const stdLags = !anyExact && [...reportDates].some(d => !stdDates.has(d));
  const byItem = new Map();
  for (const r of rows) {
    const date = iso10(stdLags ? r.REPORT_DATE : (r.STD_REPORT_DATE ?? r.REPORT_DATE));
    const itemCode = String(r.STD_ITEM_CODE ?? '');
    const itemName = String(r.STD_ITEM_NAME ?? r.ITEM_NAME ?? '').trim();
    if (date && itemCode && itemName) byItem.set(`${date}:${itemCode}`, { date, itemCode, itemName, amount: num(r.AMOUNT) });
  }
  return [...byItem.values()];
}

function convertStatements(dataDir, outDir, sub, statement) {
  const byCode = new Map();
  for (const { envelope } of batchFiles(dataDir, sub)) {
    const result = envelope.payload?.result;
    if (envelope.payload?.success === false || !Array.isArray(result?.data)) continue;
    for (const row of result.data) {
      // cashflow 为按 REPORT_DATE 分组、VALUE_LIST 逐证券行的宽表；其余为逐行
      const flat = sub === 'cashflow'
        ? (row.VALUE_LIST ?? []).map(v => ({ ...v, REPORT_DATE: row.REPORT_DATE }))
        : [row];
      for (const r of flat) {
        const code = String(r.SECUCODE ?? '');
        if (!code) continue;
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code).push(r);
      }
    }
  }
  let written = 0, empty = 0;
  for (const [code, group] of [...byCode.entries()].sort()) {
    const rows = [];
    for (const r of parseStatementRows(group)) {
      if (r.date > TODAY) { skipped.statementFuture++; continue; }
      if (r.date < CUTOFF) { skipped.statementBeforeCutoff++; continue; }
      rows.push(r);
    }
    if (!rows.length) { empty++; continue; }
    const symbol = `hk${code.slice(0, 5)}`;
    const name = `hk-statements/${String(written + 1).padStart(3, '0')}-${symbol}-${statement}.json`;
    // 上传包为东财原始全量快照：逐报告期声明完整项目清单（completeReports），
    // 使就绪检查识别为整期完整，而非仅补充项目的 partial 补丁。
    const completeReports = [...new Set(rows.map(r => r.date))].sort()
      .map(date => ({ date, itemCodes: rows.filter(r => r.date === date).map(r => r.itemCode).sort() }));
    // overwrite：全量快照修正站点旧抓取链路的人民币折算口径污染（冲突金额以上传快照为准）。
    writeFileSync(path.join(outDir, name), JSON.stringify({ type: 'hk-statements', record: { symbol, statement, rows, completeReports, overwrite: true } }));
    written++;
  }
  skipped.statementNoRows += empty;
  summary.types[`hk-statements:${statement}`] = { records: written, emptyCodes: empty };
}

/* ------------------------------------------------ 主要指标（复刻 fetchAllHkIndicatorPoints map） */
function convertIndicators(dataDir, outDir) {
  const byCode = new Map();
  for (const { envelope } of batchFiles(dataDir, 'indicators')) {
    const result = envelope.payload?.result;
    if (envelope.payload?.success === false || !Array.isArray(result?.data)) continue;
    for (const r of result.data) {
      const code = String(r.SECUCODE ?? '');
      if (!code) continue;
      const d = iso10(r.REPORT_DATE);
      if (!d) continue;
      if (d > TODAY) { skipped.indicatorFuture++; continue; }
      if (d < CUTOFF) { skipped.indicatorBeforeCutoff++; continue; }
      const raw = {};
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'number' || (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)))) raw[k] = Number(v);
      }
      const type = String(r.REPORT_TYPE ?? '');
      const kind = /年报/.test(type) ? 'annual' : /中报/.test(type) ? 'semi' : /一季/.test(type) ? 'q1' : /三季/.test(type) ? 'q3' : 'other';
      const label = type.replace('年年报', '年报').replace('年中报', '中报').replace('年一季报', 'Q1').replace('年三季报', 'Q3') || d;
      if (!byCode.has(code)) byCode.set(code, new Map());
      byCode.get(code).set(d, { date: d, raw, currency: String(r.CURRENCY ?? ''), kind, label });
    }
  }
  let written = 0, empty = 0;
  for (const [code, points] of [...byCode.entries()].sort()) {
    const list = [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!list.length) { empty++; continue; }
    const symbol = `hk${code.slice(0, 5)}`;
    writeFileSync(path.join(outDir, `hk-indicators/${String(written + 1).padStart(3, '0')}-${symbol}.json`),
      JSON.stringify({ type: 'hk-indicators', record: { symbol, points: list } }));
    written++;
  }
  skipped.indicatorNoRows += empty;
  summary.types['hk-indicators'] = { records: written, emptyCodes: empty };
}

/* ------------------------------------------------ 分红事件（复刻 hkDividends.ts 纯解析部分） */
const dateOnly = (value) => {
  if (typeof value !== 'string') return '';
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
};
const asOfDate = (asOf) => { if (typeof asOf === 'string') return dateOnly(asOf); return new Date(asOf.getTime() + 8 * 3600e3).toISOString().slice(0, 10); };
function periodInfo(period) {
  const text = period.normalize('NFKC').replace(/\s+/g, '');
  const fiscalYear = text.match(/(?:^|\D)((?:19|20)\d{2})(?=\D|$)/)?.[1];
  if (/特别|特殊|special/i.test(text)) return { fiscalYear, kind: 'special' };
  const quarter = text.match(/第?([一二三四1-4])季(?:度)?/i)?.[1] ?? text.match(/Q([1-4])/i)?.[1];
  if (quarter) {
    const number = ({ 一: '1', 二: '2', 三: '3', 四: '4' })[quarter] ?? quarter;
    return { fiscalYear, kind: `q${number}` };
  }
  if (/中期|中报|半年|H1/i.test(text)) return { fiscalYear, kind: 'interim' };
  if (/末期|年终|全年|年度|年报|H2/i.test(text)) return { fiscalYear, kind: 'final' };
  return { fiscalYear, kind: 'unknown' };
}
const isInKind = (text) => /实物|實物|每\s*\d+(?:\.\d+)?\s*股\s*分派\s*\d*(?:\.\d+)?\s*股|分派.*(?:普通股|预托股份|預託股份|预留股份)|in[ -]?specie/i.test(text);
function parseHkDps(explain) {
  const text = String(explain ?? '').normalize('NFKC').replace(/,/g, '');
  if (isInKind(text)) return null;
  const perShares = Number(text.match(/每\s*(\d+(?:\.\d+)?)\s*股/)?.[1] ?? 1);
  if (!Number.isFinite(perShares) || perShares <= 0) return null;
  const amount = '(\\d+(?:\\.\\d+)?)';
  const currency = '(?:港币|港幣|港元|HKD|HK\\$)';
  const converted = text.match(new RegExp(`相当于(每股(?:派)?)?\\s*${currency}\\s*${amount}`, 'i'));
  const currencyFirst = text.match(new RegExp(`${currency}\\s*${amount}`, 'i'));
  const currencyLast = text.match(new RegExp(`每(?:股|\\s*\\d+(?:\\.\\d+)?\\s*股)派?\\s*${amount}\\s*${currency}`, 'i'));
  const value = converted ? Number(converted[2]) : Number(currencyFirst?.[1] ?? currencyLast?.[1]);
  const divisor = converted?.[1] ? 1 : perShares;
  return Number.isFinite(value) && value >= 0 ? value / divisor : null;
}
const kindSlot = (kind) => kind === 'interim' || kind === 'q2' ? 'h1' : kind === 'final' || kind === 'q4' ? 'closing' : kind;
function recordKey(record) {
  if (record.eventId) return record.eventId;
  const info = periodInfo(record.period);
  const kind = record.special ? 'special' : (record.kind ?? info.kind);
  const fiscalYear = record.fiscalYear ?? info.fiscalYear;
  return JSON.stringify([fiscalYear ?? record.period, kindSlot(kind), record.exDate,
    ...(kind === 'special' || kind === 'unknown' ? [record.noticeDate, record.dps] : [])]);
}
function uniqueRecords(records, asOf) {
  const unique = new Map();
  for (const record of records) {
    const exDate = dateOnly(record.exDate), noticeDate = dateOnly(record.noticeDate);
    if (!exDate || exDate > asOf || (noticeDate && noticeDate > asOf)) continue;
    const info = periodInfo(record.period);
    const next = { ...record, exDate, noticeDate, fiscalYear: record.fiscalYear ?? info.fiscalYear, kind: record.special ? 'special' : (record.kind ?? info.kind) };
    const key = recordKey(next), previous = unique.get(key);
    if (!previous || next.noticeDate > previous.noticeDate) unique.set(key, next);
  }
  const result = [...unique.values()];
  for (const record of result) {
    if (!record.special || record.fiscalYear || !record.noticeDate) continue;
    const matchingYears = new Set(result.filter(o => !o.special && o.fiscalYear && o.exDate === record.exDate && o.noticeDate === record.noticeDate).map(o => o.fiscalYear));
    if (matchingYears.size === 1) record.fiscalYear = [...matchingYears][0];
  }
  return result.sort((a, b) => b.exDate.localeCompare(a.exDate) || b.noticeDate.localeCompare(a.noticeDate));
}
function parseHkDividends(rows, asOf) {
  const cutoff = asOfDate(asOf);
  const candidates = new Map();
  for (const row of rows) {
    const exDate = dateOnly(row.EX_DIVIDEND_DATE), noticeDate = dateOnly(row.NOTICE_DATE);
    if (!exDate || exDate > cutoff || (noticeDate && noticeDate > cutoff)) continue;
    const explain = String(row.PLAN_EXPLAIN ?? '').normalize('NFKC');
    if (isInKind(explain)) continue;
    const period = String(row.ASSIGN_PERIOD ?? '');
    const info = periodInfo(period);
    const special = info.kind === 'special';
    const sourceId = row.DIVIDEND_ID ?? row.ASSIGN_ID ?? row.EVENT_ID ?? row.PLAN_ID ?? row.ID;
    const record = { exDate, noticeDate, dps: parseHkDps(explain), period, special, ...info };
    const security = String(row.SECURITY_CODE ?? row.SECUCODE ?? '');
    record.eventId = JSON.stringify([security, ...(sourceId != null ? ['id', String(sourceId), kindSlot(info.kind)] : ['event', recordKey(record)])]);
    const progress = String(row.ASSIGN_PROGRESS ?? '');
    const implemented = !/取消|终止|不实施|未实施|尚未|待实施|预披露|预案|不分配/.test(progress)
      && /实施分配|已实施|已除息|已派付|已派发|完成分配|完成派息/.test(progress);
    const previous = candidates.get(record.eventId);
    if (!previous || noticeDate > previous.record.noticeDate) candidates.set(record.eventId, { record, implemented });
  }
  return uniqueRecords([...candidates.values()].filter(c => c.implemented).map(c => c.record), cutoff);
}

function convertDividends(dataDir, outDir) {
  const byCode = new Map();
  let raw = 0;
  for (const { envelope } of batchFiles(dataDir, 'dividends')) {
    const result = envelope.payload?.result;
    if (envelope.payload?.success === false || !Array.isArray(result?.data)) continue;
    for (const row of result.data) {
      raw++;
      const code = String(row.SECURITY_CODE ?? '');
      if (!code) continue;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(row);
    }
  }
  let written = 0, empty = 0, notImplemented = 0, events = 0;
  for (const [code, rows] of [...byCode.entries()].sort()) {
    const records = parseHkDividends(rows, AS_OF);
    const kept = records.filter(r => r.exDate >= CUTOFF);
    notImplemented += rows.length - records.length > 0 ? 0 : 0;
    if (!kept.length) { empty++; continue; }
    skipped.dividendBeforeCutoff += records.length - kept.length;
    const symbol = `hk${code}`;
    writeFileSync(path.join(outDir, `hk-dividend-events/${String(written + 1).padStart(3, '0')}-${symbol}.json`),
      JSON.stringify({ type: 'hk-dividend-events', record: { symbol, rows: kept } }));
    written++; events += kept.length;
  }
  skipped.dividendNoRows = empty;
  skipped.dividendNotImplemented = notImplemented;
  summary.types['hk-dividend-events'] = { records: written, events, emptyCodes: empty, rawRows: raw };
}

/* ------------------------------------------------ 自检：与站点函数输出抽样比对 */
function selfCheck() {
  // parseHkDps 站点样例（来自 hkDividends.ts 行为与上传包真实文本）
  const cases = [
    ['每股派港币0.1元', 0.1],
    ['每股派人民币0.25元，相当于港币0.27元', 0.27],
    ['每10股派5.00港元', 0.5],
    ['每股派发现金红利0.5元', null], // 无币种 → null（站点同款：不猜币种）
  ];
  for (const [text, want] of cases) {
    const got = parseHkDps(text);
    if (got !== want) throw Error(`自检失败 parseHkDps("${text}") = ${got}，期望 ${want}`);
  }
  // 报告期归位样例：存在 STD==REPORT 行时按 STD 归位
  const rows = parseStatementRows([
    { STD_REPORT_DATE: '2025-12-31 00:00:00', REPORT_DATE: '2026-06-30 00:00:00', STD_ITEM_CODE: '004001001', ITEM_NAME: '营业额', AMOUNT: 999 },
    { STD_REPORT_DATE: '2025-12-31 00:00:00', REPORT_DATE: '2025-12-31 00:00:00', STD_ITEM_CODE: '004001002', STD_ITEM_NAME: '物业厂房及设备', AMOUNT: null },
  ]);
  if (rows.length !== 2 || rows[0].date !== '2025-12-31' || rows[1].amount !== null) throw Error('自检失败 parseStatementRows');
  // STD 系统性滞后一期（无 STD==REPORT 行且 REPORT 有 STD 没有的期）时按 REPORT_DATE 归位
  const lagged = parseStatementRows([
    { STD_REPORT_DATE: '2025-12-31 00:00:00', REPORT_DATE: '2026-06-30 00:00:00', STD_ITEM_CODE: '004001001', ITEM_NAME: '营业额', AMOUNT: 280847000000 },
    { STD_REPORT_DATE: '2025-06-30 00:00:00', REPORT_DATE: '2025-12-31 00:00:00', STD_ITEM_CODE: '004001001', ITEM_NAME: '营业额', AMOUNT: 229620507200 },
  ]).sort((a, b) => a.date.localeCompare(b.date));
  if (lagged.length !== 2 || lagged[0].date !== '2025-12-31' || lagged[0].amount !== 229620507200
    || lagged[1].date !== '2026-06-30' || lagged[1].amount !== 280847000000)
    throw Error('自检失败 parseStatementRows 滞后归位');
}

/* ------------------------------------------------ convert 子命令 */
function runConvert(dataDir, outDir) {
  if (!existsSync(dataDir)) fail(`数据目录不存在: ${dataDir}`);
  for (const sub of ['balance', 'income', 'cashflow', 'indicators', 'dividends'])
    if (!existsSync(path.join(dataDir, sub))) fail(`数据目录缺少子目录: ${sub}`);
  mkdirSync(path.join(outDir, 'hk-statements'), { recursive: true });
  mkdirSync(path.join(outDir, 'hk-indicators'), { recursive: true });
  mkdirSync(path.join(outDir, 'hk-dividend-events'), { recursive: true });
  selfCheck();
  convertStatements(dataDir, outDir, 'balance', 'balance');
  convertStatements(dataDir, outDir, 'income', 'profit');
  convertStatements(dataDir, outDir, 'cashflow', 'cashflow');
  convertIndicators(dataDir, outDir);
  convertDividends(dataDir, outDir);

  // 大小体检：单文件不得超过 3.5MB（路由上限 4MB）
  let maxSize = 0, maxFile = '';
  for (const dir of ['hk-statements', 'hk-indicators', 'hk-dividend-events']) {
    for (const f of readdirSync(path.join(outDir, dir))) {
      const size = statSync(path.join(outDir, dir, f)).size;
      if (size > maxSize) { maxSize = size; maxFile = `${dir}/${f}`; }
    }
  }
  summary.maxRecordBytes = maxSize; summary.maxRecordFile = maxFile;
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ ...summary, skipped }, null, 2));
  console.log(JSON.stringify({ ...summary, skipped }, null, 2));
}

/* ------------------------------------------------ import 子命令 */
function runImport(recordsDir) {
  if (!existsSync(recordsDir)) fail(`记录目录不存在: ${recordsDir}`);
  const env = Object.fromEntries(
    readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
  const BASE = (env.MARKET_BASE_URL || 'http://127.0.0.1:3111').replace(/\/$/, '');
  const ADMIN_ID = (env.MARKET_IMPORT_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  if (!ADMIN_ID) fail('.env.local 缺少 MARKET_IMPORT_ADMIN_IDS');
  const signSession = (secret, userId) => {
    const payload = Buffer.from(JSON.stringify({ v: 1, user: { id: userId, phone: '138****0000' }, expires: Date.now() + 30 * 864e5 })).toString('base64url');
    return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  };
  const cookie = `fin_session=${signSession(env.AUTH_SESSION_SECRET, ADMIN_ID)}`;
  const only = flag('--only', '').split(',').map(s => s.trim()).filter(Boolean);
  const types = flag('--type', 'hk-statements,hk-indicators,hk-dividend-events').split(',').map(s => s.trim()).filter(Boolean);
  const concurrency = Number(flag('--concurrency', '4'));
  const dryRun = args.includes('--dry-run');

  const post = async (body) => {
    const res = await fetch(`${BASE}/api/market/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-fin-csrf': '1', origin: env.APP_ORIGIN || BASE },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { ok: false, error: text.slice(0, 200) }; }
    return { status: res.status, json };
  };
  const importFile = async (file) => {
    const body = JSON.parse(readFileSync(file, 'utf8'));
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { status, json } = await post(body);
        if (status === 200 && json.ok) return { file, ok: true, result: json.result };
        if (status === 409 || status === 400) return { file, ok: false, status, error: json.error }; // 冲突/校验失败重试无意义
        if (attempt === 3) return { file, ok: false, status, error: json.error ?? `HTTP ${status}` };
      } catch (e) {
        if (attempt === 3) return { file, ok: false, error: String(e?.message ?? e) };
      }
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  };

  const files = [];
  for (const t of types) {
    const dir = path.join(recordsDir, t);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort())
      if (!only.length || only.some(s => f.includes(s))) files.push(path.join(dir, f));
  }
  if (dryRun) { console.log(`DRY-RUN：${files.length} 个记录待导入`); process.exit(0); }
  console.log(`导入 ${files.length} 个记录（concurrency=${concurrency}${only.length ? `, only=${only.join(',')}` : ''}）`);
  const results = [];
  let cursor = 0, done = 0, ok = 0, failCount = 0;
  const started = Date.now();
  const worker = async () => {
    while (cursor < files.length) {
      const r = await importFile(files[cursor++]);
      results.push(r); done++;
      if (r.ok) ok++; else failCount++;
      if (done % 50 === 0 || done === files.length)
        console.log(`  ${done}/${files.length} (${((done / files.length) * 100).toFixed(1)}%) ok=${ok} fail=${failCount} 用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  };
  return Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
    const failures = results.filter(r => !r.ok);
    const logPath = path.join(recordsDir, 'import-log.json');
    writeFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), total: files.length, ok, fail: failCount,
      failures: failures.map(f => ({ file: path.basename(f.file), status: f.status, error: f.error })) }, null, 2));
    console.log(`\n完成：${ok} 成功 / ${failCount} 失败，明细 ${logPath}`);
    if (failures.length) { console.log('失败样例：'); for (const f of failures.slice(0, 10)) console.log(`  ✗ ${path.basename(f.file)} [${f.status ?? 'ERR'}] ${f.error}`); process.exit(2); }
  });
}

/* ------------------------------------------------ 入口 */
if (command === 'convert') {
  if (positional.length < 2) fail('用法: hk-upload-import.mjs convert <dataDir> <outDir> [--as-of YYYY-MM-DD]');
  runConvert(positional[0], positional[1]);
} else if (command === 'import') {
  if (positional.length < 1) fail('用法: hk-upload-import.mjs import <recordsDir> [--only ...] [--type ...]');
  await runImport(positional[0]);
} else {
  fail(`未知命令: ${command ?? '(空)'}。可用: convert / import`);
}
