'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type LogRow = { at: string; action: string; userId?: string; detail?: unknown };
type Status = { authorized: boolean; userId: string | null; adminConfigured: boolean; log: LogRow[] };
type Result = { symbol: string; type: string; ok: boolean; message: string };

const TYPE_NAMES: Record<string, string> = {
  kline: 'K线', finance: '财务', 'dividend-plans': '分红预案', 'dividend-impl': '已实施分红',
};

export default function AdminMarketImportPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/market/import', { cache: 'no-store' });
      const j = await r.json();
      setStatus({ authorized: j.authorized, userId: j.userId, adminConfigured: j.adminConfigured, log: j.log ?? [] });
    } catch { setStatus(null); }
    setLoaded(true);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const uploadOne = async (file: File): Promise<Result> => {
    const base = file.name.replace(/\.json$/i, '');
    const [type, ...codeParts] = base.split('_');
    try {
      const parsed = JSON.parse(await file.text());
      const record = parsed?.samples?.[Object.keys(parsed.samples ?? {})[0]] ?? parsed; // 兼容样例聚合文件
      const realType = record?.type ?? type;
      const r = await fetch('/api/market/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: realType, record }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const extra = Array.isArray(j.conflicts) ? `：${JSON.stringify(j.conflicts[0])}…` : '';
        return { symbol: codeParts.join('_') || base, type: realType, ok: false, message: (j.error ?? `HTTP ${r.status}`) + extra };
      }
      const d = j.result ?? {};
      const msg = d.skipped ? '内容未变化，跳过'
        : d.imported !== undefined ? `导入 ${d.imported} 根（${d.from}~${d.to}）`
        : d.totalDates !== undefined ? `写入 ${d.totalDates} 个报告期`
        : `写入 ${d.count ?? '?'} 条`;
      return { symbol: d.symbol ?? d.code ?? codeParts.join('_'), type: realType, ok: true, message: msg };
    } catch (e) {
      return { symbol: base, type, ok: false, message: e instanceof Error ? e.message : '解析失败' };
    }
  };

  const start = async () => {
    if (!files.length || running) return;
    setRunning(true); setResults([]); setProgress({ done: 0, total: files.length });
    const out: Result[] = [];
    for (let i = 0; i < files.length; i++) {
      out.push(await uploadOne(files[i]));
      setResults([...out]);
      setProgress({ done: i + 1, total: files.length });
    }
    setRunning(false);
    void refresh();
  };

  if (!loaded) return <main className="mx-auto max-w-3xl p-8 text-sm text-neutral-500">加载中…</main>;
  if (!status?.adminConfigured)
    return <main className="mx-auto max-w-3xl p-8"><h1 className="mb-3 text-lg font-semibold">市场数据导入</h1>
      <p className="rounded bg-red-50 p-3 text-sm text-red-700">服务器未配置导入管理员白名单（MARKET_IMPORT_ADMIN_IDS），导入功能已禁用。</p></main>;
  if (!status.authorized)
    return <main className="mx-auto max-w-3xl p-8"><h1 className="mb-3 text-lg font-semibold">市场数据导入</h1>
      <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">当前账号不在白名单。你的稳定用户 ID：<code className="font-mono">{status.userId ?? '（未登录）'}</code>，请先登录，再由服务器管理员将该 ID 加入 MARKET_IMPORT_ADMIN_IDS。</p></main>;

  const okCount = results.filter(r => r.ok).length;
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8 text-sm">
      <div>
        <h1 className="text-lg font-semibold">市场数据导入</h1>
        <p className="mt-1 text-neutral-500">管理员：{status.userId}。选择按「<code>类型_代码.json</code>」命名的导出文件，逐个上传入库。</p>
      </div>
      <section className="space-y-3 rounded border p-4">
        <input ref={fileRef} type="file" multiple accept=".json" disabled={running}
          onChange={e => setFiles(Array.from(e.target.files ?? []))}
          className="block w-full text-sm" />
        {files.length > 0 && <p className="text-neutral-500">已选 {files.length} 个文件</p>}
        <button onClick={start} disabled={running || !files.length}
          className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-40">
          {running ? `导入中 ${progress.done}/${progress.total}…` : '开始导入'}
        </button>
        {results.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">结果：成功 {okCount} / 失败 {results.length - okCount}</p>
            <div className="max-h-72 overflow-auto rounded bg-neutral-50 p-2 font-mono text-xs">
              {results.map((r, i) => (
                <div key={i} className={r.ok ? 'text-emerald-700' : 'text-red-700'}>
                  {r.ok ? '✓' : '✗'} [{TYPE_NAMES[r.type] ?? r.type}] {r.symbol} — {r.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      {status.log.length > 0 && (
        <section className="space-y-1 rounded border p-4">
          <p className="font-medium">最近导入记录（服务端留痕）</p>
          <div className="max-h-64 overflow-auto font-mono text-xs text-neutral-600">
            {status.log.map((l, i) => <div key={i}>{l.at} — {l.userId} — {l.action}{l.detail ? ` — ${JSON.stringify(l.detail).slice(0, 140)}` : ''}</div>)}
          </div>
        </section>
      )}
    </main>
  );
}
