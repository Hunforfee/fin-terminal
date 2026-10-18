'use client';

import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { useWatchlist } from './WatchlistProvider';
import { groupNameError, UNGROUPED } from '@/lib/watchlist';
import {
  parseImportTables,
  readImportFile,
  textImportTable,
  uniqueImportRows,
  type ImportMarket,
  type ImportRow,
  type ImportTable,
} from '@/lib/watchlistImport';

interface CheckedRow extends ImportRow {
  verified: boolean;
}
export default function WatchlistImport({
  groupId,
  onClose,
  onImported,
}: {
  groupId: string;
  onClose: () => void;
  onImported: (id: string) => void;
}) {
  const wl = useWatchlist();
  const [target, setTarget] = useState(groupId);
  const [newGroup, setNewGroup] = useState(false);
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [market, setMarket] = useState<ImportMarket>('auto');
  const [paste, setPaste] = useState('');
  const [tables, setTables] = useState<ImportTable[]>([]);
  const [rows, setRows] = useState<CheckedRow[]>([]);
  const [rejected, setRejected] = useState<ImportRow[]>([]);
  const [duplicates, setDuplicates] = useState(0);
  const [moveExisting, setMoveExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{
    added: number;
    moved: number;
    skipped: number;
    groupId: string;
  } | null>(null);
  const job = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      job.current++;
      abort.current?.abort();
    },
    [],
  );
  function reset() {
    job.current++;
    abort.current?.abort();
    setRows([]);
    setRejected([]);
    setDuplicates(0);
    setError('');
    setBusy(false);
  }
  async function analyze(input: ImportTable[], preference: ImportMarket) {
    reset();
    const id = job.current;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    try {
      const parsed = uniqueImportRows(parseImportTables(input, preference));
      if (!parsed.candidates.length && !parsed.rejected.length)
        throw new Error('未找到股票代码');
      setRejected(parsed.rejected);
      setDuplicates(parsed.duplicates);
      const checked: CheckedRow[] = [];
      for (let i = 0; i < parsed.candidates.length; i += 100) {
        setProgress(
          `核对股票 ${Math.min(i + 100, parsed.candidates.length)} / ${parsed.candidates.length}`,
        );
        const batch = parsed.candidates.slice(i, i + 100);
        try {
          const response = await fetch(
            `/api/quote?codes=${encodeURIComponent(batch.map((row) => row.symbol).join(','))}`,
            { signal: controller.signal },
          );
          const json = await response.json();
          if (id !== job.current) return;
          if (!response.ok || !json.ok || !Array.isArray(json.data))
            throw new Error('行情核对失败');
          const quotes = new Map<
            string,
            { symbol: string; name: string; kind: string }
          >(
            json.data
              .filter((q: { symbol?: string }) => typeof q?.symbol === 'string')
              .map((q: { symbol: string; name: string; kind: string }) => [
                q.symbol.toLowerCase(),
                q,
              ]),
          );
          checked.push(
            ...batch.map((row) => {
              const q = quotes.get(row.symbol!);
              const verified =
                q?.kind === 'stock' && !!q.name && !/^\d+$/.test(q.name);
              return {
                ...row,
                name: verified ? q!.name : row.name,
                verified,
                reason: verified ? null : '未找到可核验的股票',
              };
            }),
          );
        } catch {
          if (id !== job.current) return;
          checked.push(
            ...batch.map((row) => ({
              ...row,
              verified: false,
              reason: '行情暂不可用，请重新识别',
            })),
          );
        }
        if (id !== job.current) return;
        setRows([...checked]);
      }
    } catch (cause) {
      if (id === job.current)
        setError(cause instanceof Error ? cause.message : '文件无法识别');
    } finally {
      if (id === job.current) setBusy(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    reset();
    setTables([]);
    setBusy(true);
    setProgress('读取文件…');
    const id = job.current;
    try {
      if (files.length > 10) throw new Error('一次最多选择 10 个文件');
      const input: ImportTable[] = [];
      for (const file of Array.from(files)) {
        input.push(...(await readImportFile(file)));
        if (id !== job.current) return;
      }
      setTables(input);
      await analyze(input, market);
    } catch (cause) {
      if (id === job.current) {
        setError(cause instanceof Error ? cause.message : '文件无法读取');
        setBusy(false);
      }
    }
  }
  const destination = wl.groups.some((g) => g.id === target)
    ? target
    : UNGROUPED;
  const valid = rows.filter((row) => row.verified);
  const added = valid.filter((row) => !wl.has(row.symbol!)).length;
  const existing = valid.length - added;
  const moved = moveExisting
    ? valid.filter(
        (row) =>
          wl.has(row.symbol!) &&
          (newGroup || wl.groupOf(row.symbol!) !== destination),
      ).length
    : 0;
  const failed = [...rejected, ...rows.filter((row) => !row.verified)];
  function commit() {
    if (busy || added + moved === 0) return;
    if (newGroup) {
      const issue = groupNameError(newName, wl.groups);
      if (issue) {
        setError(issue);
        return;
      }
    }
    const result = wl.importMany(
      valid.map((row) => row.symbol!),
      destination,
      moveExisting,
      newGroup ? newName : undefined,
    );
    if (!result) {
      setError('分组已变化，请重新选择目标分组');
      return;
    }
    setReceipt(result);
    onImported(result.groupId);
  }
  return (
    <Modal open title="批量导入股票" onClose={onClose}>
      {receipt ? (
        <div className="space-y-5">
          <div className="text-base font-semibold text-slate-900">导入完成</div>
          <div
            role="status"
            className="rounded-lg bg-brand-50 p-4 text-sm text-brand-700"
          >
            新增 {receipt.added} 只 · 移组 {receipt.moved} 只 · 已有跳过{' '}
            {receipt.skipped} 只
          </div>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-500" htmlFor="import-group">
              导入分组
            </label>
            <select
              id="import-group"
              aria-label="导入目标分组"
              value={newGroup ? 'new' : destination}
              onChange={(e) => {
                setNewGroup(e.target.value === 'new');
                if (e.target.value !== 'new') setTarget(e.target.value);
                setError('');
              }}
              className="input min-w-0 flex-1"
            >
              {wl.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value="new">＋ 新建分组</option>
            </select>
          </div>
          {newGroup && (
            <input
              className="input"
              aria-label="导入新分组名称"
              value={newName}
              maxLength={20}
              onChange={(e) => {
                setNewName(e.target.value);
                setError('');
              }}
              placeholder="新分组名称"
            />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="segmented">
              <button
                type="button"
                aria-pressed={mode === 'file'}
                onClick={() => {
                  if (mode !== 'file') {
                    reset();
                    setTables([]);
                    setMode('file');
                  }
                }}
                className={`segment !min-h-8 !px-3 !text-xs ${mode === 'file' ? 'segment-active' : ''}`}
              >
                上传文件
              </button>
              <button
                type="button"
                aria-pressed={mode === 'paste'}
                onClick={() => {
                  if (mode !== 'paste') {
                    reset();
                    setTables([]);
                    setMode('paste');
                  }
                }}
                className={`segment !min-h-8 !px-3 !text-xs ${mode === 'paste' ? 'segment-active' : ''}`}
              >
                粘贴代码
              </button>
            </div>
            <select
              aria-label="无市场代码的识别方式"
              value={market}
              onChange={(e) => {
                const value = e.target.value as ImportMarket;
                setMarket(value);
                if (tables.length) void analyze(tables, value);
              }}
              className="min-h-8 max-w-full rounded-md border border-slate-200 px-2 text-xs"
            >
              <option value="auto">自动识别市场</option>
              <option value="A">无市场代码按 A 股</option>
              <option value="HK">无市场代码按港股</option>
            </select>
          </div>
          {mode === 'file' ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4">
              <input
                type="file"
                aria-label="上传同花顺导出文件"
                accept=".txt,.csv,.tsv,.xls,.xlsx"
                multiple
                disabled={busy}
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = '';
                }}
                className="block w-full min-w-0 text-xs text-slate-500 file:mr-2 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-2 file:text-xs file:font-medium file:text-brand-700"
              />
              <div className="mt-2 text-[11px] text-slate-400">
                同花顺 TXT / CSV / XLS / XLSX · 每个文件不超过 5 MB
              </div>
            </div>
          ) : (
            <textarea
              aria-label="待导入股票代码"
              className="input min-h-28 font-mono text-xs"
              value={paste}
              onChange={(e) => {
                reset();
                setTables([]);
                setPaste(e.target.value);
              }}
              placeholder={
                '粘贴同花顺复制的数据，或股票代码列表\n600519\n000001\nhk00700'
              }
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <span
              role="status"
              className="min-w-0 break-words text-xs text-slate-500"
            >
              {busy ? progress : tables.map((t) => t.source).join('、')}
            </span>
            <button
              type="button"
              disabled={
                busy || (mode === 'paste' ? !paste.trim() : !tables.length)
              }
              onClick={() => {
                const input =
                  mode === 'paste' ? [textImportTable(paste)] : tables;
                setTables(input);
                void analyze(input, market);
              }}
              className="shrink-0 text-xs text-brand-600 disabled:text-slate-300"
            >
              {rows.length ? '重新识别' : '识别股票'}
            </button>
          </div>
          {(rows.length > 0 || failed.length > 0 || duplicates > 0) && (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                <span>
                  可新增 <b className="text-brand-700">{added}</b>
                </span>
                <span>已有自选 {existing}</span>
                <span>文件内重复 {duplicates}</span>
                <span className={failed.length ? 'text-amber-700' : ''}>
                  未识别 {failed.length}
                </span>
              </div>
              {valid.length > 0 && (
                <div className="max-h-52 overflow-auto rounded-lg border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">股票</th>
                        <th className="px-3 py-2 font-medium">代码</th>
                        <th className="px-3 py-2 font-medium">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {valid.map((row) => (
                        <tr
                          key={row.symbol}
                          className="border-t border-slate-100"
                        >
                          <td className="px-3 py-2">{row.name}</td>
                          <td className="px-3 py-2 font-mono">{row.symbol}</td>
                          <td className="px-3 py-2 text-slate-500">
                            {!wl.has(row.symbol!)
                              ? '新增'
                              : moveExisting &&
                                  (newGroup ||
                                    wl.groupOf(row.symbol!) !== destination)
                                ? '移入分组'
                                : '已有跳过'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {failed.length > 0 && (
                <details className="text-xs text-slate-500">
                  <summary>查看未识别的 {failed.length} 行</summary>
                  <div className="mt-2 max-h-32 space-y-2 overflow-auto">
                    {failed.map((row, i) => (
                      <div key={i} className="break-words">
                        <span className="font-mono">
                          {row.rawCode || '空代码'}
                        </span>{' '}
                        · {row.reason}
                        <span className="ml-1 text-slate-400">
                          （{row.source} 第 {row.row} 行）
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {existing > 0 && (
                <label className="flex items-start gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    aria-label="将已有自选移入目标分组"
                    checked={moveExisting}
                    onChange={(e) => setMoveExisting(e.target.checked)}
                    className="mt-0.5 accent-blue-600"
                  />
                  将已有自选移入目标分组
                </label>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              disabled={busy || added + moved === 0}
              onClick={commit}
              className="btn-primary"
            >
              导入 {added + moved} 只
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
