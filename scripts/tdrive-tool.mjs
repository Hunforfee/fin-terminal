#!/usr/bin/env node
/**
 * tdrive 平台网盘命令行工具——经本地网关直连 MCP，无需任何登录态。
 * 供 deploy/backup-and-sync.sh 使用；agent 会话内也可直接用 mcp__netdrive__tdrive.* 工具。
 *
 * 用法：
 *   node scripts/tdrive-tool.mjs upload <本地文件> <目录id> [网盘上的文件名]
 *   node scripts/tdrive-tool.mjs list   <目录id> [--prefix 文件名前缀]
 *      输出：fid \t 名称 \t 大小（每行一个文件，按名称升序）
 *   node scripts/tdrive-tool.mjs prune  <目录id> <保留份数> [--prefix 文件名前缀]
 *      按名称倒序（名称含时间戳，即最新在前）保留前 N 份，其余永久删除
 *   node scripts/tdrive-tool.mjs delete <文件id> [更多文件id...]
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

const ENDPOINT = 'http://netdrive.agent-gateway.auth-proxy.local/mcp';

let rpcId = 0;

function parseBody(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try { return JSON.parse(t); } catch { /* fallthrough */ }
  }
  for (const line of t.split('\n')) {
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
  const body = { jsonrpc: '2.0', method, params };
  if (!isNotify) body.id = ++rpcId;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  return parseBody(await res.text());
}

async function init() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fin-terminal-tdrive-tool', version: '1.0.0' },
  });
  await rpc('notifications/initialized', {}, true);
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r?.error) throw new Error(`${name}: ${r.error.message}`);
  const content = r?.result?.content || [];
  const txt = content.find((c) => c.type === 'text')?.text ?? '';
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = { _raw: txt }; }
  if (r?.result?.isError || parsed?.error_code) {
    throw new Error(`${name}: ${parsed?.error_msg ?? txt.slice(0, 200)}`);
  }
  return parsed;
}

async function withRetry(fn, label, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      if (i === tries) throw new Error(`${label}: ${e.message}`);
      const wait = /频繁|rate|limit/i.test(e.message) ? 6000 * i : 2000 * i;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** 列出目录下所有文件（自动翻页；dir_list 每页上限 20） */
async function listAllFiles(dirId) {
  const out = [];
  let cursor;
  do {
    const r = await callTool('tdrive.dir_list', {
      dir_id: dirId,
      limit: 20,
      entry_kind: 2, // 只要文件
      order_by: 2,   // 按名称
      ascending: true,
      ...(cursor ? { cursor } : {}),
    });
    const entries = r.entries ?? r.data?.entries ?? r.files ?? [];
    for (const e of entries) {
      out.push({
        fid: e.file_id ?? e.id,
        name: e.name ?? e.file_name,
        size: e.size ?? e.file_size ?? 0,
      });
    }
    cursor = r.next_cursor ?? r.data?.next_cursor;
  } while (cursor);
  return out;
}

async function cmdUpload(file, dirId, name) {
  const { size } = await stat(file);
  name = name || basename(file);
  const up = await withRetry(
    () => callTool('tdrive.file_upload', {
      dir_id: dirId,
      file_name: name,
      file_size: size,
      conflict_strategy: 'overwrite',
    }),
    `file_upload ${name}`,
  );
  const domain = up.domain ?? up.data?.domain;
  const path = up.path ?? up.data?.path;
  const headers = up.headers ?? up.data?.headers ?? {};
  const confirmKey = up.confirm_key ?? up.data?.confirm_key;
  const taskId = up.task_id ?? up.data?.task_id;
  if (!domain || !path || !confirmKey || !taskId) {
    throw new Error(`file_upload 返回结构异常: ${JSON.stringify(up).slice(0, 300)}`);
  }
  await withRetry(async () => {
    const res = await fetch(`https://${domain}${path}`, {
      method: 'PUT',
      headers,
      body: createReadStream(file),
      duplex: 'half',
      signal: AbortSignal.timeout(600000),
    });
    if (!res.ok) throw new Error(`PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }, `PUT ${name}`);
  const done = await withRetry(
    () => callTool('tdrive.file_upload_complete', {
      dir_id: dirId,
      file_name: name,
      file_size: size,
      confirm_key: confirmKey,
      task_id: taskId,
    }),
    `complete ${name}`,
  );
  const fid = done.file_id ?? done.data?.file_id ?? done.id ?? '';
  console.log(`UPLOADED\t${fid}\t${name}\t${size}`);
}

async function cmdList(dirId, prefix) {
  const files = await listAllFiles(dirId);
  for (const f of files) {
    if (prefix && !f.name.startsWith(prefix)) continue;
    console.log(`${f.fid}\t${f.name}\t${f.size}`);
  }
}

async function cmdPrune(dirId, keep, prefix) {
  const files = (await listAllFiles(dirId))
    .filter((f) => !prefix || f.name.startsWith(prefix))
    .sort((a, b) => (a.name < b.name ? 1 : -1)); // 名称含时间戳：倒序 = 最新在前
  const stale = files.slice(keep);
  if (stale.length === 0) {
    console.log(`PRUNE\tnothing\t共 ${files.length} 份，保留 ${keep}`);
    return;
  }
  for (const f of stale) {
    await withRetry(() => callTool('tdrive.file_delete', { file_id: f.fid }), `delete ${f.name}`);
    console.log(`DELETED\t${f.fid}\t${f.name}`);
  }
  console.log(`PRUNE\tdone\t删除 ${stale.length} 份，保留 ${files.length - stale.length} 份`);
}

async function cmdDelete(fids) {
  for (const fid of fids) {
    await withRetry(() => callTool('tdrive.file_delete', { file_id: fid }), `delete ${fid}`);
    console.log(`DELETED\t${fid}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help') {
    console.log('用法: tdrive-tool.mjs upload|list|prune|delete ...（见文件头注释）');
    process.exit(cmd ? 0 : 1);
  }
  await init();
  switch (cmd) {
    case 'upload': {
      const [file, dirId, name] = rest;
      if (!file || !dirId) throw new Error('用法: upload <本地文件> <目录id> [文件名]');
      await cmdUpload(file, dirId, name);
      break;
    }
    case 'list': {
      const [dirId, ...flags] = rest;
      if (!dirId) throw new Error('用法: list <目录id> [--prefix 前缀]');
      const pi = flags.indexOf('--prefix');
      await cmdList(dirId, pi >= 0 ? flags[pi + 1] : '');
      break;
    }
    case 'prune': {
      const [dirId, keep, ...flags] = rest;
      if (!dirId || !keep) throw new Error('用法: prune <目录id> <保留份数> [--prefix 前缀]');
      const pi = flags.indexOf('--prefix');
      await cmdPrune(dirId, parseInt(keep, 10), pi >= 0 ? flags[pi + 1] : '');
      break;
    }
    case 'delete': {
      if (rest.length === 0) throw new Error('用法: delete <文件id> [更多文件id...]');
      await cmdDelete(rest);
      break;
    }
    default:
      throw new Error(`未知命令: ${cmd}`);
  }
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
