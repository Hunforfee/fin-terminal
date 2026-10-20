'use client';

import { useEffect, useRef, useState } from 'react';

export interface IndustryOption {
  name: string;
  count: number;
}

interface Props {
  options: IndustryOption[];
  included: string[];
  onIncludedChange: (next: string[]) => void;
}

/** Toggle one industry without closing the picker. */
function toggle(list: string[], name: string, checked: boolean): string[] {
  const next = list.filter(item => item !== name);
  return checked ? [...next, name] : next;
}

/** Industry picker; keeps the popover open so several rows can be ticked. */
export default function IndustryMultiSelect({ options, included, onIncludedChange }: Props) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const ref = useRef<HTMLDetailsElement>(null);
  const count = included.length;
  const allSelected = options.length > 0 && options.every(option => included.includes(option.name));
  /** <details> owns the real open state; React state only mirrors it, so close both. */
  const close = () => { if (ref.current) ref.current.open = false; setOpen(false); };
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const keyword = query.trim();
  const visible = keyword ? options.filter(option => option.name.includes(keyword)) : options;
  return <details ref={ref} className="relative shrink-0" onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary aria-label="行业筛选" title="可多选行业" className={`input flex !min-h-8 !w-auto cursor-pointer list-none items-center gap-1 !py-1 !text-xs [&::-webkit-details-marker]:hidden ${count > 0 ? 'border-brand-300 bg-brand-50/60 font-medium text-brand-800' : ''}`}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 flex-none fill-none stroke-current stroke-[1.4]"><path d="M1.5 2h9l-3.4 4v3.2l-2.2 1V6L1.5 2Z" /></svg>
      <span>{allSelected ? '全部行业' : count ? `行业 ${count}` : '选择行业'}</span>
      {count > 0 && <span aria-hidden="true" className="rounded bg-brand-100 px-1 text-[10px] tabular-nums text-brand-700">{count}</span>}
      <span aria-hidden="true" className={`text-[9px] text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
    </summary>
    <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
      <input aria-label="搜索行业" placeholder="搜索行业" value={query} onChange={event => setQuery(event.target.value)} className="input !min-h-7 w-full !py-1 !text-xs" />
      <div className="mt-2 flex items-center justify-start px-1 text-xs">
        <button type="button" disabled={!options.length} onClick={() => onIncludedChange(allSelected ? [] : options.map(option => option.name))} className="text-brand-700 disabled:opacity-50">{allSelected ? '取消全选' : '全选'}</button>
      </div>
      <div className="mt-2 max-h-56 space-y-0.5 overflow-auto">
        {visible.map(option => {
          const checked = included.includes(option.name);
          return <label key={option.name} className={`flex cursor-pointer items-center gap-2 rounded border px-1.5 py-1 text-xs ${checked ? 'border-brand-200 bg-brand-50/40' : 'border-transparent hover:bg-slate-50'}`}>
            <input type="checkbox" checked={checked} onChange={event => onIncludedChange(toggle(included, option.name, event.target.checked))} className="h-3.5 w-3.5 flex-none accent-blue-600" />
            <span className="min-w-0 flex-1 truncate text-slate-700">{option.name}</span>
            <span className="flex-none text-[10px] tabular-nums text-slate-400">{option.count}</span>
          </label>;
        })}
        {!visible.length && <p className="px-1 py-2 text-[11px] text-slate-400">没有匹配的行业</p>}
      </div>
    </div>
  </details>;
}
