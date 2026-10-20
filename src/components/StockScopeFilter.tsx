'use client';

import { useEffect, useRef, useState } from 'react';

export interface StockScopeFlags { onlyWatched: boolean; excludeST: boolean; excludeLoss: boolean }
export default function StockScopeFilter({ value, onChange }: { value: StockScopeFlags; onChange: (value: StockScopeFlags) => void }) {
  const ref = useRef<HTMLDetailsElement>(null), [open, setOpen] = useState(false);
  const options = [{ key: 'onlyWatched', label: '仅自选' }, { key: 'excludeST', label: '排除 ST' }, { key: 'excludeLoss', label: '排除亏损' }] as const;
  const count = options.filter(item => value[item.key]).length;
  useEffect(() => {
    if (!open) return;
    const close = () => { if (ref.current) ref.current.open = false; setOpen(false); };
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <details ref={ref} className="relative shrink-0" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label="股票范围筛选" className={`input flex !min-h-8 !w-auto cursor-pointer list-none items-center gap-1 !py-1 !text-xs [&::-webkit-details-marker]:hidden ${count ? 'border-brand-300 bg-brand-50/60 font-medium text-brand-800' : ''}`}>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 flex-none fill-none stroke-current stroke-[1.4]"><path d="M1.5 2h9l-3.4 4v3.2l-2.2 1V6L1.5 2Z" /></svg>
      <span>范围筛选{count ? ` · ${count}` : ''}</span><span aria-hidden="true" className={`text-[9px] text-slate-400 ${open ? 'rotate-180' : ''}`}>▼</span>
    </summary>
    <div className="absolute left-0 top-full z-40 mt-1 w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
      {options.map(item => <label key={item.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50"><input type="checkbox" checked={value[item.key]} onChange={event => onChange({ ...value, [item.key]: event.target.checked })} className="h-3.5 w-3.5 accent-blue-600" />{item.label}</label>)}
      {count > 0 && <button type="button" onClick={() => onChange({ onlyWatched: false, excludeST: false, excludeLoss: false })} className="mt-1 w-full border-t border-slate-100 px-2 py-1 text-left text-[11px] text-slate-500 hover:text-brand-700">重置</button>}
    </div>
  </details>;
}
