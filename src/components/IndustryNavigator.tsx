'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export interface TreeL3 {
  name: string;
  count: number;
}

export interface TreeL2 {
  name: string;
  count: number;
  children: TreeL3[];
}

export interface TreeL1 {
  name: string;
  count: number;
  children: TreeL2[];
}

export interface IndustrySelection {
  l1: string;
  l2?: string | null;
  l3?: string | null;
}

interface Props {
  industries: TreeL1[];
  selection: IndustrySelection | null;
  onSelect: (selection: IndustrySelection) => void;
  className?: string;
}

interface IndustryRow {
  name: string;
  count: number;
  level: 1 | 2 | 3;
  selection: IndustrySelection;
  parentPath: string;
  hasChildren: boolean;
}

export default function IndustryNavigator({
  industries,
  selection,
  onSelect,
  className = '',
}: Props) {
  const [query, setQuery] = useState('');
  // 展开状态可独立于选中项：用户手动收起的分支记在 collapsed 里，选中项变化不会强行展开。
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const headingId = useId();
  const rowsRef = useRef<HTMLDivElement>(null);
  const keyword = query.trim().toLocaleLowerCase('zh-CN');
  const allRows = useMemo(() => {
    const rows: IndustryRow[] = [];
    for (const first of industries) {
      rows.push({
        ...first,
        level: 1,
        selection: { l1: first.name, l2: null, l3: null },
        parentPath: '',
        hasChildren: first.children.length > 0,
      });
      for (const second of first.children) {
        rows.push({
          ...second,
          level: 2,
          selection: { l1: first.name, l2: second.name, l3: null },
          parentPath: first.name,
          hasChildren: second.children.length > 0,
        });
        for (const third of second.children) {
          rows.push({
            ...third,
            level: 3,
            selection: { l1: first.name, l2: second.name, l3: third.name },
            parentPath: `${first.name} / ${second.name}`,
            hasChildren: false,
          });
        }
      }
    }
    return rows;
  }, [industries]);
  // 一级分支展开中：等于当前选中的一级，且未被手动收起。
  const openFirst = (l1: string) => selection?.l1 === l1 && !collapsed.includes(l1);
  // 二级分支展开中：等于当前选中的二级，且未被手动收起。
  const openSecond = (key: string) => {
    const [l1, l2] = key.split('/');
    return selection?.l1 === l1 && (selection?.l2 ?? null) === l2 && !collapsed.includes(key);
  };
  const visibleRows = useMemo(
    () => allRows.filter((row) => keyword
      ? row.name.toLocaleLowerCase('zh-CN').includes(keyword)
      : row.level === 1 || (
        row.level === 2
          ? openFirst(row.selection.l1)
          : openFirst(row.selection.l1) && openSecond(`${row.selection.l1}/${row.selection.l2}`)
      )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRows, keyword, selection, collapsed],
  );
  // 引导竖线按「父级分组」渲染：同组子项共用一个容器，竖线画在容器上（inset-y-0），
  // 因此组内天然连成一条实线；父级收起时子项整体消失，竖线随之消失。
  // 层级配色 T1 蓝绿青：挂一级 brand-600，挂二级 emerald-500，更深层（若有四级）沿用 cyan-500。
  // LEVEL_GUIDE[level] = 该level 子项左侧引导线的颜色类；一级行自身不画线。
  const LEVEL_GUIDE: Record<2 | 3 | 4, string> = {
    2: 'bg-brand-600',
    3: 'bg-emerald-500',
    4: 'bg-cyan-500',
  };
  const groups = useMemo(() => visibleRows
    .filter(row => row.level === 1)
    .map(first => ({
      first,
      seconds: visibleRows
        .filter(row => row.level === 2 && row.selection.l1 === first.selection.l1)
        .map(second => ({
          second,
          thirds: visibleRows.filter(row => row.level === 3
            && row.selection.l1 === first.selection.l1
            && row.selection.l2 === second.selection.l2),
        })),
    })), [visibleRows]);

  const counts = useMemo(() => ({
    second: industries.reduce((sum, first) => sum + first.children.length, 0),
    third: industries.reduce((sum, first) => sum + first.children.reduce((subtotal, second) => subtotal + second.children.length, 0), 0),
  }), [industries]);

  useEffect(() => {
    if (keyword) return;
    const container = rowsRef.current;
    const current = container?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    if (!container?.clientHeight || !current) return;
    const bounds = container.getBoundingClientRect();
    const row = current.getBoundingClientRect();
    if (row.top < bounds.top) container.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom;
  }, [selection?.l1, selection?.l2, selection?.l3, keyword, industries]);

  const focusRows = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const rows = Array.from(rowsRef.current?.querySelectorAll<HTMLButtonElement>('[data-industry-row]') ?? []);
    const index = rows.indexOf(event.target);
    if (index < 0) return;
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1)
      : event.key === 'ArrowUp' ? Math.max(index - 1, 0)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? rows.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  const renderRow = (row: IndustryRow) => {
    const sameFirst = row.selection.l1 === selection?.l1;
    const sameSecond = sameFirst && (row.selection.l2 ?? null) === (selection?.l2 ?? null);
    const current = sameSecond && (row.selection.l3 ?? null) === (selection?.l3 ?? null);
    const ancestor = sameFirst && (
      row.level === 1 || (row.level === 2 && (row.selection.l2 ?? null) === (selection?.l2 ?? null))
    );
    const expanded = row.level === 1
      ? openFirst(row.selection.l1)
      : row.level === 2 && openSecond(`${row.selection.l1}/${row.selection.l2}`);
    return (
      <button
        type="button"
        data-industry-row
        aria-current={current ? 'page' : undefined}
        aria-expanded={!keyword && row.hasChildren ? expanded : undefined}
        aria-label={`${row.name}，${row.level}级行业，${row.count}只成分股${row.parentPath ? `，${row.parentPath}` : ''}`}
        title={`${[row.parentPath, row.name].filter(Boolean).join(' / ')} · ${row.count}只`}
        onClick={() => {
          setQuery('');
          // 有下级的行：再次点击同一个父分类即收起它的子分类。
          if (!keyword && row.hasChildren && expanded) {
            const key = row.level === 1 ? row.selection.l1 : `${row.selection.l1}/${row.selection.l2}`;
            setCollapsed(prev => [...new Set([...prev, key])]);
            return;
          }
          if (!keyword && row.hasChildren) {
            const key = row.level === 1 ? row.selection.l1 : `${row.selection.l1}/${row.selection.l2}`;
            setCollapsed(prev => prev.filter(item => item !== key));
          }
          onSelect(row.selection);
        }}
        style={!keyword ? { paddingLeft: 8 + (row.level - 1) * 10 } : undefined}
        className={`my-px flex h-7 w-full items-center gap-1.5 rounded px-2 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400 ${current ? 'bg-brand-100 font-semibold text-brand-700' : ancestor ? 'bg-slate-50 font-medium text-slate-700 hover:bg-brand-50' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
      >
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${keyword ? 'leading-[14px]' : ''}`}>
            {row.name}
          </span>
          {keyword && (
            <span className="block truncate text-[10px] font-normal leading-[11px] text-slate-400">
              {row.parentPath || '一级行业'}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="shrink-0 text-right text-[10px] font-normal tabular-nums text-slate-400">
          {row.count}
        </span>
      </button>
    );
  };

  return (
    <nav
      aria-labelledby={headingId}
      className={`flex h-full min-h-0 w-full flex-col bg-white ${className}`}
    >
      <div className="shrink-0 px-2.5 pb-2 pt-2.5">
        <h2 id={headingId} className="text-xs font-semibold text-slate-700">
          行业分类
        </h2>
        <input
          type="search"
          aria-label="搜索行业"
          placeholder="搜索行业"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (rowsRef.current) rowsRef.current.scrollTop = 0;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('');
              event.preventDefault();
            } else if (event.key === 'ArrowDown') {
              const first = rowsRef.current?.querySelector<HTMLButtonElement>('[data-industry-row]');
              if (first) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
          className="mt-2 h-7 w-full min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2 text-xs text-slate-700 outline-none placeholder:text-slate-400 focus:border-brand-300 focus:bg-white focus:ring-2 focus:ring-brand-100"
        />
      </div>
      <div
        ref={rowsRef}
        onKeyDown={focusRows}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1 [scrollbar-gutter:stable]"
      >
        {visibleRows.length === 0 ? (
          <p role="status" className="px-2 py-3 text-xs text-slate-400">
            未找到行业
          </p>
        ) : (
          <ul>
            {/* 搜索态：扁平结果，不画引导线（分组已失去意义） */}
            {keyword ? visibleRows.map(row => <li key={JSON.stringify(row.selection)}>{renderRow(row)}</li>) : groups.map(group => (
              <li key={`g:${group.first.selection.l1}`}>
                {renderRow(group.first)}
                {openFirst(group.first.selection.l1) && (
                  <div className="relative">
                    <span aria-hidden="true" className={`pointer-events-none absolute bottom-0 left-[13px] top-0 z-10 w-[1.5px] rounded-full ${LEVEL_GUIDE[2]}`} />
                    {group.seconds.map(entry => (
                      <div key={`s:${entry.second.selection.l2}`} className="relative">
                        {renderRow(entry.second)}
                        {openSecond(`${entry.second.selection.l1}/${entry.second.selection.l2}`) && entry.thirds.length > 0 && (
                          <div className="relative">
                            <span aria-hidden="true" className={`pointer-events-none absolute bottom-0 left-[23px] top-0 z-10 w-[1.5px] rounded-full ${LEVEL_GUIDE[3]}`} />
                            {entry.thirds.map(row => (
                              <div key={`t:${row.selection.l3}`} className="relative">
                                {renderRow(row)}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="shrink-0 border-t border-slate-100 px-2.5 py-2 text-[10px] tabular-nums text-slate-400">
        {industries.length} 一级 · {counts.second} 二级 · {counts.third} 三级
      </div>
    </nav>
  );
}
