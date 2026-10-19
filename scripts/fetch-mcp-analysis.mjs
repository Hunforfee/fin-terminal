/**
 * 批量抓取 MCP 数据（通达信 F10 深度资料 + 券商研报）。
 * 通过 MCP Streamable HTTP 协议直连本地网关，省去逐只调用。
 *
 * 用法：node scripts/fetch-mcp-analysis.mjs [code1 code2 ...]
 * 输出：src/data/analyses/_raw/{code}.mcp.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src/data/analyses/_raw');
const ENDPOINT = 'http://tdx-connector.agent-gateway.auth-proxy.local/txmcp';

let sessionId = null;
let rpcId = 0;

/** 解析 SSE 或纯 JSON 响应 */
function parseBody(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try { return JSON.parse(t); } catch { return null; }
  }
  // SSE: 逐行找 data:
  const lines = t.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try { return JSON.parse(payload); } catch { /* skip */ }
      }
    }
  }
  return null;
}

async function rpc(method, params, isNotify = false) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const body = { jsonrpc: '2.0', method, params };
  if (!isNotify) body.id = ++rpcId;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  return parseBody(text);
}

async function init() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fin-terminal-batch', version: '1.0.0' },
  });
  await rpc('notifications/initialized', {}, true);
  if (!sessionId) throw new Error('初始化未获得 session id');
}

/** 调用工具，返回解析后的 JSON（工具 content 里是文本） */
async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r?.error) throw new Error(`${name}: ${r.error.message}`);
  const content = r?.result?.content || [];
  const txt = content.find((c) => c.type === 'text')?.text;
  if (!txt) throw new Error(`${name}: 无文本返回`);
  try { return JSON.parse(txt); } catch { /* 文本含中文摘要 + JSON，提取 JSON 段 */ }
  // 找到第一个 '{' 起始的完整 JSON（用括号配平截取）
  const start = txt.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < txt.length; i++) {
      const ch = txt[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(txt.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return { _raw: txt };
}

async function grab(code, name) {
  const out = { code, name, fetchedAt: new Date().toISOString() };
  // 1) F10 公司概要
  try {
    out.overview = await callTool('tdx_api_data', {
      entry: 'TdxSharePCCW.tdxf10_gg_zxts',
      fixedTag: 'gsgy',
      code,
    });
  } catch (e) { out.overviewError = String(e.message || e); }
  // 2) 研报
  try {
    out.reports = await callTool('wenda_report_query', {
      name,
      bdate: '20260101',
      edate: '20261019',
      keywords: '评级,目标价,深度',
    });
  } catch (e) { out.reportsError = String(e.message || e); }
  return out;
}

const codes = process.argv.slice(2);
if (codes.length === 0) {
  console.error('请传入股票代码，如: node scripts/fetch-mcp-analysis.mjs 600519 000858');
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
await init();
console.log('session ok:', sessionId ? 'yes' : 'no');

for (const item of codes) {
  const [code, name] = item.includes(':') ? item.split(':') : [item, item];
  try {
    const data = await grab(code, name);
    const file = join(OUT_DIR, `${code}.mcp.json`);
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    const ovKeys = data.overview ? 'ok' : `ERR(${data.overviewError || ''})`;
    const repCount = Array.isArray(data.reports?.data) ? data.reports.data.length - 1 : 0;
    console.log(`${code} ${name}: overview=${ovKeys} reports=${repCount}`);
  } catch (e) {
    console.error(`${code} 失败:`, e.message);
  }
}
