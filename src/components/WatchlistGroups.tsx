'use client';
import { useEffect, useState } from 'react';
import { useWatchlist } from './WatchlistProvider';
import Modal from './Modal';
import WatchlistImport from './WatchlistImport';
import { groupNameError, UNGROUPED, type WatchGroup } from '@/lib/watchlist';

function GroupRow({ group, count }: { group: WatchGroup; count: number }) {
  const wl = useWatchlist();
  const [name, setName] = useState(group.name);
  const [error, setError] = useState('');
  useEffect(() => {
    setName(group.name);
    setError('');
  }, [group.name]);
  return (
    <form
      className="border-b border-slate-100 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        const issue = groupNameError(name, wl.groups, group.id);
        if (issue) {
          setError(issue);
          return;
        }
        wl.renameGroup(group.id, name);
        setError('');
      }}
    >
      <div className="flex items-center gap-2">
        <input
          aria-label={`分组名称：${group.name}`}
          className="input min-w-0 flex-1"
          value={name}
          maxLength={20}
          onChange={(e) => {
            setName(e.target.value);
            setError('');
          }}
        />
        <span className="shrink-0 text-xs text-slate-400">{count} 只</span>
        <button
          type="submit"
          disabled={name.trim() === group.name}
          className="shrink-0 text-xs text-brand-600 disabled:text-slate-300"
        >
          保存
        </button>
        <button
          type="button"
          aria-label={`删除分组${group.name}并移回未分组`}
          title="标的移回未分组"
          onClick={() => wl.deleteGroup(group.id)}
          className="shrink-0 text-xs text-slate-500 hover:text-red-600"
        >
          解散
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}

export default function WatchlistGroups({
  active,
  onChange,
}: {
  active: string;
  onChange: (id: string) => void;
}) {
  const wl = useWatchlist();
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const count = (id: string) =>
    wl.items.filter((item) => item.groupId === id).length;
  return (
    <>
      <div
        aria-label="自选分组"
        className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-3 py-2.5 sm:px-5"
      >
        {[{ id: 'all', name: '全部自选' }, ...wl.groups].map((group) => (
          <button
            type="button"
            key={group.id}
            aria-pressed={active === group.id}
            onClick={() => onChange(group.id)}
            className={`max-w-full break-words rounded-md px-3 py-1.5 text-xs font-medium transition ${active === group.id ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {group.name}
            <span
              className={`ml-1.5 ${active === group.id ? 'text-white/70' : 'text-slate-400'}`}
            >
              {group.id === 'all' ? wl.items.length : count(group.id)}
            </span>
          </button>
        ))}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={!wl.ready}
            onClick={() => setImportOpen(true)}
            className="rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100"
          >
            批量导入
          </button>
          <button
            type="button"
            disabled={!wl.ready}
            onClick={() => {
              setName('');
              setError('');
              setOpen(true);
            }}
            className="shrink-0 rounded-md px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
          >
            管理分组
          </button>
        </div>
      </div>
      {importOpen && (
        <WatchlistImport
          groupId={active === 'all' ? UNGROUPED : active}
          onClose={() => setImportOpen(false)}
          onImported={onChange}
        />
      )}
      <Modal open={open} title="管理自选分组" onClose={() => setOpen(false)}>
        <div className="mb-1 flex items-center justify-between py-2 text-sm">
          <span>未分组</span>
          <span className="text-xs text-slate-400">{count(UNGROUPED)} 只</span>
        </div>
        {wl.groups
          .filter((g) => g.id !== UNGROUPED)
          .map((group) => (
            <GroupRow key={group.id} group={group} count={count(group.id)} />
          ))}
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const issue = groupNameError(name, wl.groups);
            if (issue) {
              setError(issue);
              return;
            }
            wl.createGroup(name);
            setName('');
            setError('');
          }}
        >
          <div className="flex gap-2">
            <input
              className="input min-w-0 flex-1"
              aria-label="新建分组名称"
              placeholder="新分组名称"
              value={name}
              maxLength={20}
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
            />
            <button type="submit" className="btn-primary shrink-0">
              新建
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-xs text-red-600">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </>
  );
}
