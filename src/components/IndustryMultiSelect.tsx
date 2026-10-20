'use client';

import { useEffect, useRef, useState } from 'react';

export interface IndustryOption {
  name: string;
  count: number;
}

interface Props {
  options: IndustryOption[];
  included: string[];
  excluded: string[];
  onIncludedChange: (next: string[]) => void;
  onExcludedChange: (next: string[]) => void;
}

/** Toggling a side clears the other, so an industry can never be both included and excluded. */
function toggle(list: string[], name: string, checked: boolean): string[] {
  const next = list.filter(item => item !== name);
  return checked ? [...next, name] : next;
}

const summarize = (included: string[], excluded: string[]) => {
  const parts: string[] = [];
  if (included.length) parts.push(`行业 ${included.length}`);
  if (excluded.length) parts.push(`排除 ${excluded.length}`);
  return parts.length ? parts.join(' · ') : '全部行业';
};

/** Include/exclude industry picker; keeps the popover open so several rows can be ticked. */
export default function IndustryMultiSelect({ options, included, excluded, onIncludedChange, onExcludedChange }: Props) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const ref = useRef<HTMLDetailsElement>(null);
  const count = included.length + excluded.length;
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
    <summary aria-label="行业筛选" title="可多选行业，或排除某些行业" className={`input flex !min-h-8 !w-auto cursor-pointer list-none items-center gap-1 !py-1 !text-xs [&::-webkit-details-marker]:hidden ${count > 0 ? 'border-brand-300 bg-brand-50/60 font-medium text-brand-800' : ''}`}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 flex-none fill-none stroke-current stroke-[1.4]"><path d="M1.5 2h9l-3.4 4v3.2l-2.2 1V6L1.5 2Z" /></svg>
      <span>{summarize(included, excluded)}</span>
      {count > 0 && <span aria-hidden="true" className="rounded bg-brand-100 px-1 text-[10px] tabular-nums text-brand-700">{count}</span>}
      <span aria-hidden="true" className={`text-[9px] text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
    </summary>
    <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
      <input aria-label="搜索行业" placeholder="搜索行业" value={query} onChange={event => setQuery(event.target.value)} className="input !min-h-7 w-full !py-1 !text-xs" />
      <div className="mt-2 max-h-56 space-y-2 overflow-auto">
        {([
          { key: 'in' as const, label: '只看这些行业', hint: '不勾选表示不限行业', list: included, apply: onIncludedChange, active: 'border-brand-200 bg-brand-50/40' },
          { key: 'out' as const, label: '排除这些行业', hint: '排除优先于包含', list: excluded, apply: onExcludedChange, active: 'border-amber-200 bg-amber-50/40' },
        ]).map(group => <fieldset key={group.key}>
          <legend className="px-1 text-[11px] font-medium text-slate-500">{group.label}</legend>
          <p className="px-1 text-[10px] text-slate-400">{group.hint}</p>
          <div className="mt-1 grid grid-cols-1 gap-0.5">
            {visible.map(option => {
              const checked = group.list.includes(option.name);
              return <label key={`${group.key}:${option.name}`} className={`flex cursor-pointer items-center gap-2 rounded border px-1.5 py-1 text-xs ${checked ? group.active : 'border-transparent hover:bg-slate-50'}`}>
                <input type="checkbox" checked={checked} onChange={event => {
                  const next = toggle(group.list, option.name, event.target.checked);
                  group.apply(next);
                  // Selecting on one side drops the industry from the other side.
                  if (group.key === 'in' && event.target.checked) onExcludedChange(excluded.filter(item => item !== option.name));
                  if (group.key === 'out' && event.target.checked) onIncludedChange(included.filter(item => item !== option.name));
                }} className="h-3.5 w-3.5 flex-none accent-blue-600" />
                <span className="min-w-0 flex-1 truncate text-slate-700">{option.name}</span>
                <span className="flex-none text-[10px] tabular-nums text-slate-400">{option.count}</span>
              </label>;
            })}
            {!visible.length && <p className="px-1 py-2 text-[11px] text-slate-400">没有匹配的行业</p>}
          </div>
        </fieldset>)}
      </div>
      {count > 0 && <button type="button" onClick={() => { onIncludedChange([]); onExcludedChange([]); }} className="mt-2 block w-full rounded border-t border-slate-100 px-1 pt-2 text-left text-[11px] text-slate-400 hover:text-brand-700">清空行业条件</button>}
    </div>
  </details>;
}