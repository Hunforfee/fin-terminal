'use client';

import { useState } from 'react';
import Modal from './Modal';
import { useWatchlist } from './WatchlistProvider';
import { groupNameError, UNGROUPED } from '@/lib/watchlist';

export default function ScreenerGroupImport({ symbols, selected, onClose, onImported }: {
  symbols: string[];
  selected: string[];
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const watchlist = useWatchlist();
  const [scope, setScope] = useState(selected.length ? 'selected' : 'all');
  const [target, setTarget] = useState(UNGROUPED);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const creating = target === 'new';
  const codes = [...new Set(scope === 'all' ? symbols : selected.filter(symbol => symbols.includes(symbol)))];
  const targetMissing = !creating && !watchlist.groups.some(group => group.id === target);
  function submit() {
    if (!watchlist.ready || !codes.length) return;
    const issue = creating ? groupNameError(newName, watchlist.groups) : targetMissing ? '分组已删除，请重新选择' : null;
    if (issue) { setError(issue); return; }
    const receipt = watchlist.importMany(codes, target, creating ? newName.trim() : undefined);
    if (!receipt) { setError('分组已变化，请重新选择目标分组'); return; }
    const name = creating ? newName.trim() : watchlist.groups.find(group => group.id === target)!.name;
    onImported(`已${creating ? '新建分组并' : ''}加入「${name}」${receipt.added} 家${receipt.skipped ? `，跳过 ${receipt.skipped} 家已存在或已归组股票` : ''}`);
  }
  return <Modal open title="添加到分组" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); submit(); }} className="space-y-4 text-sm">
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium">添加范围</legend>
        <label className="flex items-center gap-2"><input type="radio" name="screener-import-scope" checked={scope === 'all'} onChange={() => setScope('all')} />全部筛选结果（{symbols.length} 家，包含所有分页）</label>
        <label className="flex items-center gap-2"><input type="radio" name="screener-import-scope" checked={scope === 'selected'} disabled={!selected.length} onChange={() => setScope('selected')} />已勾选股票（{selected.length} 家）</label>
      </fieldset>
      <label className="block space-y-2"><span className="font-medium">目标分组</span><select className="input" value={target} onChange={event => { setTarget(event.target.value); setError(''); }}>
        {watchlist.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        {targetMissing && <option value={target}>原分组已删除</option>}
        <option value="new">＋ 新建分组</option>
      </select></label>
      {creating && <label className="block space-y-2"><span className="font-medium">新分组名称</span><input autoFocus className="input" placeholder="输入新分组名称" maxLength={20} value={newName} onChange={event => { setNewName(event.target.value); setError(''); }} /></label>}
      <p className="text-xs leading-5 text-slate-500">自动跳过组内重复股票，保留已有分组关系。添加到「未分组」时，已属于其他分组的股票会跳过。</p>
      {error && <p role="alert" className="text-xs text-amber-700">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>取消</button><button type="submit" className="btn-primary" disabled={!watchlist.ready || !codes.length || targetMissing}>{creating ? '新建并添加' : '添加'} {codes.length} 家</button></div>
    </form>
  </Modal>;
}
