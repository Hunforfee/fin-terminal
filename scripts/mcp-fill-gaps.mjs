#!/usr/bin/env node
/**
 * MCP 数据补齐工具（WorkBuddy 侧执行）。
 *
 * 网站自身抓取失败时会按证券登记缺口台账（market-fill-gaps:v1:<symbol>），
 * 本脚本负责：读取缺口 → 经 MCP 取数 → 写回导入接口 → 触发覆盖复核。
 *
 * 用法:
 *   node scripts/mcp-fill-gaps.mjs session                          # 自签管理员会话并验证
 *   node scripts/mcp-fill-gaps.mjs list [--json]                    # 列出全部已登记缺口
 *   node scripts/mcp-fill-gaps.mjs status <symbol>                  # 单只缺口详情
 *   node scripts/mcp-fill-gaps.mjs template <type>                  # 打印导入数据文件模板
 *   node scripts/mcp-fill-gaps.mjs import <file.json> [--dry-run]   # 按数据文件导入（可多 record）
 *   node scripts/mcp-fill-gaps.mjs resolve [symbol ...]             # 触发覆盖复核（省略=全部缺口）
 *
 * 环境（从 .env.local 读取）:
 *   MARKET_BASE_URL          默认 http://127.0.0.1:3111
 *   AUTH_SESSION_SECRET      会话签名密钥（≥32 字节）
 *   MARKET_IMPORT_ADMIN_IDS  管理员白名单（取第一个作为脚本身份）
 *   APP_ORIGIN               CSRF 同源校验
 *   MARKET_READONLY_TOKEN    只读通道令牌（list/status 用）
 *
 * 导入数据文件 schema（JSON，{records:[...]}，每条 = POST /api/market/import 的 body）:
 *   kline:              {type:'kline', record:{symbol, source:'tdx', candles:[{date,open,high,low,close}], listingDate?}}
 *   finance:            {type:'finance', record:{symbol:'600004', statement:'profit'|'balance'|'cashflow',
 *                        unit:'wan', currency:'CNY', basis:'cumulative', reportDates:[...], announceDates?,
 *                        items:[{name, vals:[...]}]}}
 *   financial-history:  {type:'financial-history', record:{symbol:'600004', unit:'wan', currency:'CNY',
 *                        reportDates:[...], items:[{code, vals:[...]}]}}
 *   share-history:      {type:'share-history', record:{symbol:'600004', unit:'shares', rows:[{date, shares}]}}
 *   dividend-plans:     {type:'dividend-plans', record:{symbol:'600004', plans:[{reportDate, announceDate, exDate,
 *                        perShare, perShareStock?, implemented, cancelled?, special?}]}}
 *   dividend-impl:      {type:'dividend-impl', record:{symbol:'600004', rows:[{exDate, perShare, perShareStock?,
 *                        precisionPerShare?, cashSource?}]}}
 *   hk-statements:      {type:'hk-statements', record:{symbol:'hk00016', statement:'profit'|'balance'|'cashflow',
 *                        rows:[{date, itemCode, itemName, amount}],
 *                        completeReports?:[{date,itemCodes:[...]}], overwrite?: true}} // amount=账本币种元，null 表示未知
 *   hk-statements 默认仅补充项目，不表示整期完整。完整报表必须附原始来源的完整 itemCodes 清单，
 *   对应日期的输入 rows 必须逐项覆盖该清单且至少一个金额有效；旧导入的完整度需重新核验。
 *   completeReports 是管理员对来源覆盖的声明，不可用已抓到的少量项目冒充来源的完整目录。
 *   overwrite=true 仅用于全量快照修正历史口径缺陷（冲突金额以上传快照为准，留 incident）。
 *   hk-indicators:      {type:'hk-indicators', record:{symbol:'hk00016',
 *                        points:[{date, raw:{字段:数值}, currency, kind, label}]}}   // 与站点 source-hk-indicators:v1 同键位
 *   hk-dividend-events: {type:'hk-dividend-events', record:{symbol:'hk00016',
 *                        rows:[{exDate, noticeDate?, dps, period, special, fiscalYear?, kind?, eventId?}]}}  // dps=港元/股 税前
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const command = args[0];

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const BASE = (env.MARKET_BASE_URL || 'http://127.0.0.1:3111').replace(/\/$/, '');
const ADMIN_ID = (env.MARKET_IMPORT_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean)[0];
const READONLY = env.MARKET_READONLY_TOKEN || '';

const fail = (message) => { console.error(`✗ ${message}`); process.exit(1); };

/** 自签 fin_session：payload {v:1,user:{id,phone},expires} + HMAC-SHA256  base64url。 */
function signSession(secret, userId) {
  const payload = Buffer.from(JSON.stringify({
    v: 1, user: { id: userId, phone: '138****0000' }, expires: Date.now() + 30 * 864e5,
  })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function sessionCookie() {
  const secret = env.AUTH_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) fail('.env.local 缺少 AUTH_SESSION_SECRET（≥32 字节）');
  if (!ADMIN_ID) fail('.env.local 缺少 MARKET_IMPORT_ADMIN_IDS');
  return `fin_session=${signSession(secret, ADMIN_ID)}`;
}

async function api(method, urlPath, { body, auth = 'admin' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth === 'admin') {
    headers.cookie = sessionCookie();
    headers['x-fin-csrf'] = '1';
    headers.origin = env.APP_ORIGIN || BASE;
  } else if (auth === 'readonly') {
    if (!READONLY || READONLY.length < 32) fail('.env.local 缺少 MARKET_READONLY_TOKEN（≥32 字符）');
    headers['x-fin-readonly-token'] = READONLY;
  }
  const response = await fetch(`${BASE}${urlPath}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  return { ok: response.ok, status: response.status, data: parsed };
}

const TEMPLATES = {
  kline: { type: 'kline', record: { symbol: 'hk00012', source: 'tdx', candles: [{ date: '2021-01-04', open: 1.0, high: 1.0, low: 1.0, close: 1.0 }] } },
  finance: { type: 'finance', record: { symbol: '600004', statement: 'profit', unit: 'wan', currency: 'CNY', basis: 'cumulative', reportDates: ['2024-12-31'], announceDates: [null], items: [{ name: '营业总收入', vals: [1000] }] } },
  'financial-history': { type: 'financial-history', record: { symbol: '600004', unit: 'wan', currency: 'CNY', reportDates: ['2024-12-31', '2023-12-31'], items: [{ code: 'npParent', vals: [1000, 900] }] } },
  'share-history': { type: 'share-history', record: { symbol: '600004', unit: 'shares', rows: [{ date: '2024-12-31', shares: 1000000000 }] } },
  'dividend-plans': { type: 'dividend-plans', record: { symbol: '600004', plans: [{ reportDate: '2024-12-31', announceDate: '2025-03-01', exDate: '2025-06-01', perShare: 0.1, implemented: true, special: false }] } },
  'dividend-impl': { type: 'dividend-impl', record: { symbol: '600004', rows: [{ exDate: '2025-06-01', perShare: 0.1, cashSource: 'import' }] } },
  'hk-statements': { type: 'hk-statements', record: { symbol: 'hk00016', statement: 'profit', rows: [{ date: '2026-06-30', itemCode: 'TOTAL_OPERATE_INCOME', itemName: '营业总收入', amount: 1000000000 }] } },
  'hk-dividend-events': { type: 'hk-dividend-events', record: { symbol: 'hk00016', rows: [{ exDate: '2026-09-01', noticeDate: '2026-08-20', dps: 0.5, period: '2026-06-30', special: false, kind: 'interim', eventId: 'hk00016:2026-09-01' }] } },
};

if (command === 'session') {
  const r = await api('GET', '/api/market/import');
  if (!r.data.authorized) fail(`会话未通过鉴权：${r.data.error ?? JSON.stringify(r.data)}`);
  console.log(`✓ 管理员会话有效 user=${r.data.userId}`);
} else if (command === 'list' || command === 'status') {
  const key = command === 'status' ? `market-fill-gaps:v1:${normalizeSymbol(args[1])}` : null;
  const path_ = key
    ? `/api/market/db?key=${encodeURIComponent(key)}`
    : `/api/market/db?prefix=${encodeURIComponent('market-fill-gaps:v1:')}&payload=1&limit=20`;
  const r = await api('GET', path_, { auth: 'readonly' });
  if (command === 'status') {
    if (!r.ok) fail(`缺口不存在或查询失败：${JSON.stringify(r.data)}`);
    console.log(JSON.stringify(r.data.record?.payload ?? r.data, null, 2));
  } else {
    const gaps = (r.data.records ?? []).map(x => x.payload ?? x).filter(Boolean);
    if (!gaps.length) { console.log('当前没有已登记的缺口'); process.exit(0); }
    if (args.includes('--json')) { console.log(JSON.stringify(gaps, null, 2)); process.exit(0); }
    console.log(`\n已登记缺口 ${gaps.length} 只（上限 20，更多请用 status 逐只查看）：\n`);
    for (const g of gaps) {
      console.log(`  ${g.symbol}  [${g.market}] ${g.error ?? ''}`);
      console.log(`    MCP 可补齐: ${g.mcp?.length ? g.mcp.join(', ') : '—'}`);
      console.log(`    仅网站重试: ${g.manual?.length ? g.manual.join(', ') : '—'}`);
      console.log(`    尝试 ${g.attempts} 次 · ${g.updatedAt}`);
    }
  }
} else if (command === 'template') {
  const type = args[1];
  if (!TEMPLATES[type]) fail(`未知类型 ${type}；可用：${Object.keys(TEMPLATES).join(' / ')}`);
  console.log(JSON.stringify(TEMPLATES[type], null, 2));
} else if (command === 'import') {
  const file = args[1];
  if (!file) fail('用法: node scripts/mcp-fill-gaps.mjs import <file.json> [--dry-run]');
  const dry = args.includes('--dry-run');
  let payload;
  try { payload = JSON.parse(readFileSync(path.resolve(file), 'utf8')); }
  catch (e) { fail(`数据文件解析失败: ${e.message}`); }
  const records = Array.isArray(payload) ? payload : payload.records;
  if (!Array.isArray(records) || !records.length) fail('数据文件需要 {records:[...]} 或数组');
  let ok = 0, failCount = 0;
  for (const record of records) {
    const type = record.type;
    if (!TEMPLATES[type]) { console.log(`  ✗ 未知类型 ${type}`); failCount++; continue; }
    if (dry) { console.log(`  [dry-run] ${type} ${record.record?.symbol ?? record.record?.code ?? ''}`); ok++; continue; }
    const r = await api('POST', '/api/market/import', { body: { type, record: record.record } });
    if (r.data.ok) { console.log(`  ✓ ${type} ${record.record?.symbol ?? ''}: ${JSON.stringify(r.data.result).slice(0, 160)}`); ok++; }
    else { console.log(`  ✗ ${type} ${record.record?.symbol ?? ''}: ${r.data.error ?? r.status}`); failCount++; }
  }
  console.log(`\n导入完成：成功 ${ok} · 失败 ${failCount}`);
  if (failCount) process.exitCode = 1;
} else if (command === 'resolve') {
  const symbols = args.slice(1).filter(Boolean);
  const r = await api('POST', '/api/market/gaps/resolve', { body: symbols.length ? { symbols } : {} });
  if (!r.data.ok) fail(`复核请求失败：${r.data.error ?? r.status}`);
  console.log(`复核 ${r.data.total} 只：清除 ${r.data.cleared} · 仍缺 ${r.data.remaining}`);
  for (const item of r.data.resolved ?? []) {
    if (item.status === 'cleared') console.log(`  ✓ ${item.symbol} 覆盖已达标，缺口已清除`);
    else if (item.status === 'remaining') console.log(`  ◌ ${item.symbol} 仍缺 — MCP: ${item.remaining?.mcp?.join(', ') || '—'} | manual: ${item.remaining?.manual?.join(', ') || '—'}`);
    else console.log(`  ✗ ${item.symbol} ${item.error}`);
  }
} else {
  console.log('用法: session | list [--json] | status <symbol> | template <type> | import <file.json> [--dry-run] | resolve [symbol ...]');
  process.exit(1);
}

function normalizeSymbol(input) {
  if (!input) fail('缺少 symbol');
  const s = String(input).trim().toLowerCase().replace(/[.\s]/g, '');
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) return s;
  if (/^hk\d{5}$/.test(s)) return s;
  if (/^\d{5}$/.test(s)) return `hk${s}`;
  return s;
}
