'use client';
import { useState } from 'react';
import { useWatchlist } from './WatchlistProvider';
import Modal from './Modal';
import { groupNameError, UNGROUPED } from '@/lib/watchlist';

export default function WatchlistButton({
  code,
  name,
  compact = false,
  label,
}: {
  code: string;
  name: string;
  compact?: boolean;
  label?: string;
}) {
  const wl = useWatchlist();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const saved = wl.has(code);
  function save(event: React.FormEvent) {
    event.preventDefault();
    if (creating) {
      const problem = groupNameError(newName, wl.groups);
      if (problem) {
        setError(problem);
        return;
      }
    }
    if (!wl.setGroups(code, groups, creating ? newName : undefined)) {
      setError('分组已变化，请重新选择');
      return;
    }
    setOpen(false);
  }
  return (
    <>
      <button
        type="button"
        disabled={!wl.ready}
        aria-haspopup="dialog"
        aria-label={`${saved ? '调整' : '添加'}${name}${saved ? '的自选分组' : '到自选'}`}
        title={
          saved
            ? `当前分组：${wl.groups
                .filter((g) => wl.groupsOf(code).includes(g.id))
                .map((g) => g.name)
                .join('、')}`
            : undefined
        }
        className={`${compact ? 'rounded-md px-2 py-1 text-xs' : 'chip border'} ${saved ? 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'} disabled:opacity-50`}
        onClick={() => {
          setGroups(saved ? wl.groupsOf(code) : [UNGROUPED]);
          setCreating(false);
          setNewName('');
          setError('');
          setOpen(true);
        }}
      >
        {label ?? (saved ? '已自选' : '加自选')}
      </button>
      <Modal
        open={open}
        title={saved ? `调整分组 · ${name}` : `加入自选 · ${name}`}
        onClose={() => setOpen(false)}
      >
        <form onSubmit={save} className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs text-slate-500">
              选择分组（可多选）
            </legend>
            {wl.groups.map((g) => (
              <label
                key={g.id}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm ${groups.includes(g.id) ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-slate-200 hover:bg-slate-50'}`}
              >
                <input
                  type="checkbox"
                  name="watch-group"
                  value={g.id}
                  checked={
                    g.id === UNGROUPED
                      ? !creating && !groups.some((id) => id !== UNGROUPED)
                      : groups.includes(g.id)
                  }
                  onChange={() => {
                    setGroups((prev) =>
                      g.id === UNGROUPED
                        ? [UNGROUPED]
                        : prev.includes(g.id)
                          ? prev.filter((id) => id !== g.id)
                          : [...prev.filter((id) => id !== UNGROUPED), g.id],
                    );
                    if (g.id === UNGROUPED) setCreating(false);
                    setError('');
                  }}
                  className="accent-blue-600"
                />
                <span className="min-w-0 flex-1 break-words">{g.name}</span>
                <span className="text-xs text-slate-400">
                  {wl.items.filter((item) => item.groupId === g.id).length}
                </span>
              </label>
            ))}
          </fieldset>
          {creating ? (
            <input
              autoFocus
              aria-label="新分组名称"
              maxLength={20}
              className="input"
              placeholder="输入分组名称"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setError('');
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="text-sm text-brand-600 hover:underline"
            >
              ＋ 新建分组
            </button>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
            {saved && (
              <button
                type="button"
                className="mr-auto text-sm text-red-600"
                onClick={() => {
                  wl.remove(code);
                  setOpen(false);
                }}
              >
                删除自选
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => setOpen(false)}
            >
              取消
            </button>
            <button className="btn-primary" type="submit">
              {saved ? '保存' : '加入自选'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
