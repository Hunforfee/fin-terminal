/** 补抓财务数据：利润表(6年) + 研报一致预期(评级/目标价) + 估值 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENDPOINT = 'http://tdx-connector.agent-gateway.auth-proxy.local/txmcp';
const OUT_DIR = '/workspace/fin-terminal/src/data/analyses/_raw';

let sessionId = null;
let rpcId = 0;

function parseBody(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch {} }
  for (const line of t.split('\n')) {
    if (line.startsWith('data:')) {
      const p = line.slice(5).trim();
      if (p && p !== '[DONE]') { try { return JSON.parse(p); } catch {} }
    }
  }
  return null;
}
async function rpc(method, params, isNotify = false) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const body = { jsonrpc: '2.0', method, params };
  if (!isNotify) body.id = ++rpcId;
  const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  return parseBody(await res.text());
}
async function init() {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fin-terminal-batch', version: '1.0.0' } });
  await rpc('notifications/initialized', {}, true);
  if (!sessionId) throw new Error('初始化未获得 session id');
}
async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r?.error) throw new Error(`${name}: ${r.error.message}`);
  const txt = r?.result?.content?.find((c) => c.type === 'text')?.text;
  if (!txt) throw new Error(`${name}: 无文本返回`);
  try { return JSON.parse(txt); } catch {}
  const start = txt.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < txt.length; i++) {
      const ch = txt[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(txt.slice(start, i + 1)); } catch { break; } } }
    }
  }
  return { _raw: txt.slice(0, 500) };
}

const codes = process.argv.slice(2);
await init();
console.log('session ok');

for (const code of codes) {
  const out = { code, fetchedAt: new Date().toISOString() };
  try { out.income = await callTool('tdx_api_data', { entry: 'TdxShareCW.ph_agf10_cw_lyb', fixedTag: '00101', code }); }
  catch (e) { out.incomeError = String(e.message || e); }
  try { out.expect = await callTool('tdx_api_data', { entry: 'CWServ.tdxf10_gg_ybpj', fixedTag: 'yzyq', code }); }
  catch (e) { out.expectError = String(e.message || e); }
  try { out.valuation = await callTool('tdx_api_data', { entry: 'TdxShareCW.ph_agf10_gzfx', code, extraOne: '1Y', extraTwo: 'PE' }); }
  catch (e) { out.valuationError = String(e.message || e); }
  await writeFile(join(OUT_DIR, `${code}.fin.json`), JSON.stringify(out, null, 2), 'utf8');
  console.log(`${code}: income=${out.income?.ok ? 'ok' : 'ERR'} expect=${out.expect?.ok ? 'ok' : 'ERR'} valuation=${out.valuation?.ok ? 'ok' : 'ERR'}`);
}
