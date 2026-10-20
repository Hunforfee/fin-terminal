/**
 * 将 fin-terminal 项目源码同步到项目公共存储空间（tdrive）。
 * 通过本地网关直连 MCP（initialize → tools/call），逐个目录创建、逐个文件上传。
 *
 * 用法：
 *   node scripts/sync-to-drive.mjs test      # 单文件试跑（README.md），打印返回结构
 *   node scripts/sync-to-drive.mjs           # 全量同步（覆盖式，可重复执行）
 *
 * 排除：node_modules / .next / .git / 项目根 data/（运行时账号数据）/ .env.local（含密钥）/ tsconfig.tsbuildinfo
 * 注意：src/data/ 等项目内层级的 data 目录会正常同步（AI 分析数据属于项目资产）
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'http://netdrive.agent-gateway.auth-proxy.local/mcp';
const DRIVE_ROOT = 'YJjGWVHPgpWE';
const TOP_DIR = 'fin-terminal';
const CONCURRENCY = 2;

const EXCLUDE_DIRS_ANY = new Set([
  'node_modules',
  '.next',
]);
// 仅项目根层级的 data/（运行时账号数据，含密码哈希与个人自选股）
const EXCLUDE_DIRS_ROOT = new Set(['data']);
const EXCLUDE_FILES = new Set([
  'tsconfig.tsbuildinfo',
  '.env.local', // 含真实 AUTH_SESSION_SECRET，禁止外发
]);


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
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const body = { jsonrpc: '2.0', method, params };
  if (!isNotify) body.id = ++rpcId;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  return parseBody(await res.text());
}

async function init() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fin-terminal-sync', version: '1.0.0' },
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
  // 业务错误：result.isError 或解析体内含 error_code（如 120409 文件名冲突）
  if (r?.result?.isError || parsed?.error_code) {
    throw new Error(`${name}: ${parsed?.error_msg ?? txt.slice(0, 200)}`);
  }
  return parsed;
}

async function putFile(domain, path, headers, localPath) {
  const url = `https://${domain}${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: createReadStream(localPath),
    duplex: 'half',
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      if (i === tries) throw new Error(`${label}: ${e.message}`);
      // 限流类错误（“调用过于频繁”）拉长退避时间
      const wait = /频繁|rate|limit/i.test(e.message) ? 6000 * i : 2000 * i;
      await sleep(wait);
    }
  }
}

/** 确保目录存在，返回 dir_id（先列目录查找，找不到再创建） */
async function ensureDir(parentId, name, cache) {
  const key = `${parentId}/${name}`;
  if (cache.has(key)) return cache.get(key);
  const find = async () => {
    const list = await callTool('tdrive.dir_list', { dir_id: parentId, limit: 200 });
    const entries = list.entries ?? list.data?.entries ?? list.files ?? [];
    const hit = entries.find((x) => x.name === name && (x.kind === 2 || x.is_dir));
    return hit ? (hit.file_id ?? hit.id) : null;
  };
  let id = await withRetry(find, `dir_list ${parentId}/${name}`);
  if (!id) {
    const created = await withRetry(
      () => callTool('tdrive.dir_create', { parent_dir_id: parentId, name }),
      `dir_create ${parentId}/${name}`,
    );
    id = created.file_id ?? created.id ?? created.data?.file_id;
  }
  if (!id) id = await withRetry(find, `dir_list retry ${parentId}/${name}`);
  if (!id) throw new Error(`无法确定目录 id: ${name}`);
  cache.set(key, id);
  return id;
}

/** 上传单个文件 */
async function uploadFile(dirId, localPath, fileName) {
  const { size } = await stat(localPath);
  const up = await withRetry(
    () => callTool('tdrive.file_upload', {
      dir_id: dirId,
      file_name: fileName,
      file_size: size,
      conflict_strategy: 'overwrite',
    }),
    `file_upload ${fileName}`,
  );
  const domain = up.domain ?? up.data?.domain;
  const path = up.path ?? up.data?.path;
  const headers = up.headers ?? up.data?.headers ?? {};
  const confirmKey = up.confirm_key ?? up.data?.confirm_key;
  const taskId = up.task_id ?? up.data?.task_id;
  if (!domain || !path || !confirmKey || !taskId) {
    throw new Error(`file_upload 返回结构异常: ${JSON.stringify(up).slice(0, 300)}`);
  }
  await withRetry(() => putFile(domain, path, headers, localPath), `PUT ${fileName}`);
  const done = await withRetry(
    () => callTool('tdrive.file_upload_complete', {
      dir_id: dirId,
      file_name: fileName,
      file_size: size,
      confirm_key: confirmKey,
      task_id: taskId,
    }),
    `complete ${fileName}`,
  );
  return done;
}

/** 递归收集需同步的文件（相对路径） */
async function collect(absDir, base, out) {
  for (const entry of await readdir(absDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    const abs = join(absDir, entry.name);
    const rel = relative(base, abs);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS_ANY.has(entry.name)) continue;
      if (absDir === base && EXCLUDE_DIRS_ROOT.has(entry.name)) continue;
      await collect(abs, base, out);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      out.push({ abs, rel: rel.split(sep).join('/') });
    }
  }
  return out;
}

async function main() {
  const mode = process.argv[2];
  await init();
  console.log('session ok');

  // 顶层目录
  const topId = await ensureDir(DRIVE_ROOT, TOP_DIR, new Map());
  console.log('top dir id:', topId);

  if (mode === 'test') {
    const file = join(ROOT, 'README.md');
    const r = await uploadFile(topId, file, 'README.md');
    console.log('test upload result:', JSON.stringify(r).slice(0, 500));
    return;
  }

  const files = await collect(ROOT, ROOT, []);
  console.log(`待同步文件: ${files.length} 个`);

  // 预创建所有目录
  const dirCache = new Map();
  const dirs = [...new Set(files.map((f) => f.rel.split('/').slice(0, -1).join('/')))].filter(Boolean).sort();
  for (const d of dirs) {
    let parentId = topId;
    for (const part of d.split('/')) parentId = await ensureDir(parentId, part, dirCache);
  }
  console.log(`目录就绪: ${dirs.length} 个`);

  // 并发上传
  let ok = 0, fail = 0;
  const queue = [...files];
  const failures = [];
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      const parts = f.rel.split('/');
      const name = parts.pop();
      let dirId = topId;
      if (parts.length) {
        // 逐级取（目录已预创建，走缓存）
        for (const p of parts) dirId = (await ensureDir(dirId, p, dirCache));
      }
      try {
        await uploadFile(dirId, f.abs, name);
        ok++;
        if (ok % 25 === 0) console.log(`进度 ${ok}/${files.length}`);
      } catch (e) {
        fail++;
        failures.push(`${f.rel}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n完成: 成功 ${ok}，失败 ${fail}`);
  if (failures.length) console.log('失败明细:\n' + failures.slice(0, 20).join('\n'));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('同步失败:', e); process.exit(1); });
