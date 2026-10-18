'use client';

import { useEffect, useId, useState } from 'react';

export interface NoteCompany {
  symbol: string;
  code: string;
  name: string;
}
const label = (company: NoteCompany | null) =>
  company ? `${company.name} ${company.code}` : '';

export default function NoteCompanyPicker({
  companies,
  value,
  onChange,
}: {
  companies: NoteCompany[];
  value: NoteCompany | null;
  onChange: (company: NoteCompany | null) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState(label(value));
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!expanded) setQuery(label(value));
  }, [value, expanded]);
  const search = query.trim().toLowerCase();
  const results = companies
    .filter((c) =>
      `${c.name} ${c.code} ${c.symbol}`.toLowerCase().includes(search),
    )
    .slice(0, 12);
  useEffect(() => {
    if (expanded)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, expanded, id]);
  function choose(company: NoteCompany) {
    onChange(company);
    setQuery(label(company));
    setExpanded(false);
  }
  return (
    <div className="relative">
      <input
        aria-label="笔记关联公司"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={id}
        aria-activedescendant={
          expanded && results[active] ? `${id}-${active}` : undefined
        }
        className="input focus-visible:!outline-none"
        placeholder="搜索公司名称或股票代码"
        value={query}
        autoComplete="off"
        onFocus={() => {
          setQuery('');
          setExpanded(true);
          setActive(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setExpanded(true);
          setActive(0);
          if (value) onChange(null);
        }}
        onBlur={() => {
          setExpanded(false);
          setQuery(label(value));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && expanded) {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(false);
            setQuery(label(value));
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setExpanded(true);
            setActive((index) =>
              Math.max(
                0,
                Math.min(
                  results.length - 1,
                  index + (e.key === 'ArrowDown' ? 1 : -1),
                ),
              ),
            );
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (expanded && results[active]) choose(results[active]);
          }
        }}
      />
      {expanded && (
        <div
          id={id}
          role="listbox"
          aria-label="可选公司"
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg sm:max-h-64"
        >
          {results.length ? (
            results.map((company, index) => (
              <div
                id={`${id}-${index}`}
                key={company.symbol}
                role="option"
                aria-selected={index === active}
                onPointerDown={(e) => {
                  e.preventDefault();
                  choose(company);
                }}
                onClick={() => choose(company)}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm ${index === active ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
              >
                <span>{company.name}</span>
                <span className="text-xs tabular-nums text-slate-400">
                  {company.code}
                </span>
              </div>
            ))
          ) : (
            <div className="px-3 py-4 text-sm text-slate-400">
              没有匹配的公司
            </div>
          )}
        </div>
      )}
    </div>
  );
}
