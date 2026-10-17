'use client';

/**
 * 仿理杏仁「选择财务指标」弹窗：
 * 顶部已选指标排序区（chip 可删、一键清空）→ 报表 Tab（资产负债表/利润表/现金流量表/财务指标）
 * → 搜索框 + 分组复选列表 → 底部「恢复默认设置 / n/36 / 取消 / 确定」。
 */

import { useEffect, useMemo, useState } from 'react';
import type { StatementCatalog } from '@/lib/datasource/sinaStatements';
import type { IndicatorDef } from '@/lib/datasource/sinaFinancial';
import {
  checkExpr,
  formulaKey,
  FORMULA_PREFIX as FORMULA_KEY_PREFIX,
  type Formula,
} from '@/lib/financeFormulas';

export const MAX_FIELDS = 36;

export interface FieldMeta {
  key: string;
  label: string;
  group: string;
  /** 'balance' | 'profit' | 'cashflow' | 'indicator' */
  statement: string;
  unit: string;
}

export interface PickerCatalog {
  statements: StatementCatalog[];
  indicators: IndicatorDef[];
  indicatorGroups: Record<string, { label: string; desc: string }>;
}

interface Props {
  open: boolean;
  catalog: PickerCatalog | null;
  selected: string[];
  defaultSelected: string[];
  onClose: () => void;
  onConfirm: (keys: string[]) => void;
  /** 弹窗标题，默认「选择财务指标」 */
  title?: string;
  /** 「恢复系统默认设置」的额外回调（在重置草稿之外） */
  onResetAll?: () => void;
  /** 自定义公式指标 */
  formulas?: Formula[];
  onAddFormula?: (f: Formula) => void;
  onDeleteFormula?: (id: string) => void;
  /** 可供公式引用的全部字段（label + key），用于插入下拉 */
  formulaSourceFields?: { key: string; label: string }[];
}

type TabId = 'balance' | 'profit' | 'cashflow' | 'indicator' | 'formula';

const TABS: { id: TabId; label: string }[] = [
  { id: 'balance', label: '资产负债表' },
  { id: 'profit', label: '利润表' },
  { id: 'cashflow', label: '现金流量表' },
  { id: 'indicator', label: '财务指标' },
  { id: 'formula', label: '自定义指标' },
];

export function allFieldMetas(catalog: PickerCatalog | null): Map<string, FieldMeta> {
  const map = new Map<string, FieldMeta>();
  if (!catalog) return map;
  for (const st of catalog.statements) {
    for (const g of st.groups) {
      for (const f of g.fields) {
        map.set(f.key, { key: f.key, label: f.label, group: g.label, statement: st.id, unit: f.unit });
      }
    }
  }
  for (const ind of catalog.indicators) {
    map.set(ind.key, {
      key: ind.key,
      label: ind.label,
      group: catalog.indicatorGroups[ind.group]?.label ?? ind.group,
      statement: 'indicator',
      unit: ind.unit,
    });
  }
  return map;
}

export default function FieldPicker({
  open,
  catalog,
  selected,
  defaultSelected,
  onClose,
  onConfirm,
  title = '选择财务指标',
  onResetAll,
  formulas = [],
  onAddFormula,
  onDeleteFormula,
  formulaSourceFields = [],
}: Props) {
  const [tab, setTab] = useState<TabId>('balance');
  const [draft, setDraft] = useState<string[]>(selected);
  const [query, setQuery] = useState('');
  // 自定义公式表单
  const [fName, setFName] = useState('');
  const [fExpr, setFExpr] = useState('');
  const [fUnit, setFUnit] = useState<Formula['unit']>('');
  const [fError, setFError] = useState<string | null>(null);
  // 字段搜索插入
  const [fSearch, setFSearch] = useState('');
  const [fListOpen, setFListOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(selected);
      setQuery('');
      setTab('balance');
    }
  }, [open, selected]);

  const metas = useMemo(() => allFieldMetas(catalog), [catalog]);

  // 公式表达式实时校验
  const exprCheck = useMemo(() => {
    if (!fExpr.trim()) return null;
    return checkExpr(fExpr, formulaSourceFields.map((x) => x.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fExpr, formulaSourceFields]);

  // 字段搜索：按 label 或 key 过滤
  const fSearchList = useMemo(() => {
    const q = fSearch.trim().toLowerCase();
    if (!q) return formulaSourceFields.slice(0, 60);
    return formulaSourceFields
      .filter((f) => f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q))
      .slice(0, 60);
  }, [fSearch, formulaSourceFields]);

  const addFormula = () => {
    const name = fName.trim() || `自定义指标 ${formulas.length + 1}`;
    const check = checkExpr(fExpr, formulaSourceFields.map((x) => x.key));
    if (!check.ok) {
      setFError(check.error ?? '表达式无效');
      return;
    }
    const f: Formula = { id: `f${Date.now()}`, name, expr: fExpr.trim(), unit: fUnit };
    onAddFormula?.(f);
    setDraft((d) =>
      d.length < MAX_FIELDS && !d.includes(formulaKey(f.id)) ? [...d, formulaKey(f.id)] : d,
    );
    setFName('');
    setFExpr('');
    setFUnit('');
    setFError(null);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: { group: string; fields: FieldMeta[] }[] = [];
    if (tab === 'formula') {
      const fields = formulas
        .filter((f) => !q || f.name.toLowerCase().includes(q) || f.expr.toLowerCase().includes(q))
        .map((f) => ({
          key: formulaKey(f.id),
          label: f.name,
          group: '自定义公式',
          statement: 'formula',
          unit: f.unit,
        }));
      if (fields.length) out.push({ group: '自定义公式', fields });
      return out;
    }
    if (tab === 'indicator') {
      const inds = catalog?.indicators ?? [];
      const groups = catalog?.indicatorGroups ?? {};
      for (const g of Object.keys(groups)) {
        const fields = inds
          .filter((i) => i.group === g && (!q || i.label.toLowerCase().includes(q)))
          .map((i) => ({ key: i.key, label: i.label, group: groups[g].label, statement: 'indicator', unit: i.unit }));
        if (fields.length) out.push({ group: groups[g].label, fields });
      }
      return out;
    }
    const st = catalog?.statements.find((s) => s.id === tab);
    if (!st) return out;
    for (const g of st.groups) {
      const fields = g.fields.filter((f) => !q || f.label.toLowerCase().includes(q));
      if (fields.length) {
        out.push({
          group: g.label,
          fields: fields.map((f) => ({ key: f.key, label: f.label, group: g.label, statement: st.id, unit: f.unit })),
        });
      }
    }
    return out;
  }, [tab, query, catalog, formulas]);

  if (!open) return null;

  const toggle = (key: string) => {
    setDraft((d) => {
      if (d.includes(key)) return d.filter((k) => k !== key);
      if (d.length >= MAX_FIELDS) return d;
      return [...d, key];
    });
  };

  const full = draft.length >= MAX_FIELDS;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[6vh]" onClick={onClose}>
      <div
        className="w-full max-w-5xl rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-800">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-xl leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            ×
          </button>
        </div>

        <div className="px-5 py-4">
          {/* 已选指标排序区 */}
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">指标排序</h3>
              {draft.length > 0 && (
                <button onClick={() => setDraft([])} className="text-xs text-red-500 hover:underline">
                  ✕ 清空已选
                </button>
              )}
            </div>
            <div className="min-h-[72px] rounded border border-slate-200 bg-slate-50/60 p-2">
              {draft.length === 0 ? (
                <div className="flex h-14 items-center justify-center text-xs text-slate-400">
                  在下方勾选要展示的科目或指标（最多 {MAX_FIELDS} 项）
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {draft.map((key, idx) => {
                    const meta = metas.get(key);
                    const label =
                      meta?.label ?? formulas.find((x) => formulaKey(x.id) === key)?.name ?? key;
                    return (
                      <span
                        key={key}
                        className="inline-flex items-center gap-1 rounded bg-brand-600 px-2 py-1 text-xs text-white"
                        title={
                          key.startsWith('fx_')
                            ? `${label} = ${formulas.find((x) => formulaKey(x.id) === key)?.expr ?? ''}`
                            : meta
                              ? `${meta.group} · ${key}`
                              : key
                        }
                      >
                        <span className="opacity-60">{idx + 1}.</span>
                        {label}
                        <button
                          onClick={() => toggle(key)}
                          className="ml-0.5 rounded-full px-1 leading-none hover:bg-white/20"
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 报表 Tab + 搜索 */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded border border-slate-200">
              {TABS.map((t) => {
                const count =
                  t.id === 'indicator'
                    ? catalog?.indicators.length ?? 0
                    : t.id === 'formula'
                      ? formulas.length
                      : catalog?.statements.find((s) => s.id === t.id)?.total ?? 0;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`px-3 py-1.5 text-xs transition ${
                      tab === t.id ? 'bg-brand-600 font-medium text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {t.label}
                    <span className="ml-1 opacity-60">{count}</span>
                  </button>
                );
              })}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索财务科目和指标"
              className="input ml-auto w-56 text-xs"
            />
          </div>

          {/* 自定义指标：新建公式表单 */}
          {tab === 'formula' && (
            <div className="mb-3 rounded border border-brand-100 bg-brand-50/40 p-3">
              <div className="mb-2 text-xs text-slate-500">
                用已有字段通过 <b>+ - * / ( )</b> 组合出新指标，例：
                <code className="mx-1 rounded bg-white px-1 py-0.5">bs_货币资金 / bs_流动负债合计</code>
                结果按报告期逐期计算。
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={fName}
                  onChange={(e) => setFName(e.target.value)}
                  placeholder="指标名称（如：现金对流动负债覆盖）"
                  className="input w-52 text-xs"
                />
                <select
                  value={fUnit}
                  onChange={(e) => setFUnit(e.target.value as Formula['unit'])}
                  className="input w-24 text-xs"
                  title="展示单位"
                >
                  <option value="">单位：数值</option>
                  <option value="pct">单位：%</option>
                  <option value="yuan">单位：元</option>
                  <option value="wan">单位：万元</option>
                </select>
                <div className="relative w-44">
                  <input
                    value={fSearch}
                    onChange={(e) => {
                      setFSearch(e.target.value);
                      setFListOpen(true);
                    }}
                    onFocus={() => setFListOpen(true)}
                    onBlur={() => setTimeout(() => setFListOpen(false), 150)}
                    placeholder="搜索字段插入…"
                    className="input w-44 text-xs"
                  />
                  {fListOpen && (
                    <div className="absolute z-10 mt-1 max-h-56 w-[260px] overflow-y-auto rounded border border-slate-200 bg-white shadow-lg">
                      {fSearchList.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-slate-400">无匹配字段</div>
                      ) : (
                        fSearchList.map((f) => (
                          <button
                            key={f.key}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setFExpr((prev) => (prev && !prev.endsWith(' ') ? `${prev} ` : prev) + f.key);
                              setFSearch('');
                              setFListOpen(false);
                            }}
                            className="block w-full truncate px-3 py-1.5 text-left text-xs text-slate-600 hover:bg-brand-50 hover:text-brand-700"
                            title={f.key}
                          >
                            {f.label}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <span className="text-slate-300">=</span>
                <input
                  value={fExpr}
                  onChange={(e) => {
                    setFExpr(e.target.value);
                    setFError(null);
                  }}
                  placeholder="表达式，如 bs_货币资金 / bs_流动负债合计"
                  className="input min-w-[240px] flex-1 text-xs"
                />
                <button
                  onClick={addFormula}
                  disabled={!fExpr.trim()}
                  className="rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700 disabled:opacity-40"
                >
                  添加公式
                </button>
              </div>
              {(fError || exprCheck?.error) && (
                <div className="mt-1.5 text-xs text-red-500">⚠ {fError ?? exprCheck?.error}</div>
              )}
              {!fError && exprCheck?.ok && (
                <div className="mt-1.5 text-xs text-emerald-600">
                  ✓ 表达式有效，引用 {exprCheck.keys.length} 个字段
                </div>
              )}
            </div>
          )}

          {/* 分组复选列表 */}
          <div className="max-h-[46vh] overflow-y-auto rounded border border-slate-100 p-3">
            {visible.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-400">
                {tab === 'formula' ? '还没有自定义公式，在上方添加一个试试' : '没有匹配的科目'}
              </div>
            ) : (
              visible.map((g) => (
                <div key={g.group} className="mb-4">
                  <div className="mb-1.5 flex items-center gap-1 text-sm font-medium text-slate-700">
                    <span className="text-brand-600">一、</span>
                    {g.group}
                  </div>
                  <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
                    {g.fields.map((f) => {
                      const checked = draft.includes(f.key);
                      const disabled = !checked && full;
                      return (
                        <label
                          key={f.key}
                          className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs ${
                            disabled ? 'cursor-not-allowed text-slate-300' : 'text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggle(f.key)}
                            className="h-3.5 w-3.5 accent-brand-600"
                          />
                          <span
                            className="truncate"
                            title={
                              tab === 'formula'
                                ? `${f.label} = ${formulas.find((x) => formulaKey(x.id) === f.key)?.expr ?? ''}`
                                : f.label
                            }
                          >
                            {f.label}
                          </span>
                          {tab === 'formula' && !formulas.find((x) => x.id === f.key.slice(FORMULA_KEY_PREFIX.length))?.preset && (
                            <button
                              onClick={(ev) => {
                                ev.preventDefault();
                                ev.stopPropagation();
                                const id = f.key.slice(FORMULA_KEY_PREFIX.length);
                                onDeleteFormula?.(id);
                                setDraft((d) => d.filter((k) => k !== f.key));
                              }}
                              title="删除该公式"
                              className="ml-auto shrink-0 rounded px-1 text-red-400 hover:bg-red-50 hover:text-red-600"
                            >
                              ×
                            </button>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 底部操作条 */}
        <div className="flex items-center gap-3 rounded-b-lg border-t border-slate-100 bg-slate-50 px-5 py-3">
          <button
            onClick={() => {
              setDraft(defaultSelected);
              onResetAll?.();
            }}
            className="rounded bg-amber-400 px-3 py-1.5 text-xs font-medium text-amber-950 hover:bg-amber-300"
          >
            恢复系统默认设置
          </button>
          <span className={`text-xs ${full ? 'text-red-500' : 'text-slate-400'}`}>
            最多可选择{MAX_FIELDS}项（剩下{Math.max(0, MAX_FIELDS - draft.length)}项可选）
          </span>
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="rounded bg-slate-500 px-4 py-1.5 text-xs text-white hover:bg-slate-600">
              取消
            </button>
            <button
              onClick={() => onConfirm(draft)}
              disabled={draft.length === 0}
              className="rounded bg-brand-600 px-4 py-1.5 text-xs text-white hover:bg-brand-700 disabled:opacity-40"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
