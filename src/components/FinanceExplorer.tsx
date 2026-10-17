'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import FinanceCompareChart, { type CompanySeries } from '@/components/FinanceCompareChart';
import FieldPicker, { allFieldMetas, type FieldMeta, type PickerCatalog } from '@/components/FieldPicker';
import { INDICATORS, type IndicatorGroup } from '@/lib/datasource/sinaFinancial';
import {
  checkExpr,
  evalFormula,
  formulaKey,
  hidePreset,
  mergedFormulas,
  saveFormulas,
  type Formula,
} from '@/lib/financeFormulas';
import { STOCKS } from '@/lib/universe';

interface CompanyFinancials {
  code: string;
  name: string;
  periods: string[];
  periodLabels: string[];
  series: Record<string, (number | null)[]>;
  source: string;
}

type CustomData = { companies: CompanyFinancials[] };

/** 分析模块：名称可自定义，fields 顺序即展示顺序 */
interface Module {
  id: string;
  name: string;
  fields: string[];
}

const GROUPS: IndicatorGroup[] = ['profit', 'growth', 'solvency', 'cashflow', 'pershare'];
const GROUP_LABEL: Record<IndicatorGroup, string> = {
  profit: '盈利能力',
  growth: '成长性',
  solvency: '偿债能力',
  cashflow: '现金流',
  pershare: '每股指标',
};

/** 默认模块（与精选 21 项指标一致；数据显示设置中可任意改配） */
const DEFAULT_MODULES: Module[] = GROUPS.map((g) => ({
  id: `m-${g}`,
  name: GROUP_LABEL[g],
  fields: INDICATORS.filter((i) => i.group === g).map((i) => i.key),
}));

const LS_MODULES = 'fin.financeModules';
const LS_ACTIVE = 'fin.financeModules.active';

function unitText(unit: string): string {
  if (!unit) return '派生值';
  if (unit === 'pct') return '%';
  if (unit === 'yuan') return '元';
  if (unit === 'ratio') return '倍';
  if (unit === 'wan') return '万元（大额自动折算为亿）';
  return unit;
}

/** 同行业的可选对比对象（含自身所属行业优先） */
function peersOf(code: string): { code: string; name: string }[] {
  const self = STOCKS.find((s) => s.code === code);
  const pool = self ? STOCKS.filter((s) => s.industry === self.industry && s.code !== code) : [];
  const rest = STOCKS.filter((s) => s.code !== code && !pool.includes(s));
  return [...pool, ...rest].map((s) => ({ code: s.code, name: s.name }));
}

function loadModules(): Module[] {
  try {
    const raw = localStorage.getItem(LS_MODULES);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        return arr
          .filter((m) => m && typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.fields))
          .map((m) => ({ id: m.id, name: m.name, fields: m.fields.slice(0, 36) }));
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_MODULES;
}

/**
 * 财务体检（理杏仁式）：
 * 顶部分析模块条（可重命名 / 数据显示设置 / 新增），左侧指标列表可拖拽排序，图表顺序跟随。
 * 每个模块从三大报表 178 个披露科目 + 21 项财务指标中自由配置。
 */
export default function FinanceExplorer({ code }: { code: string }) {
  const [modules, setModules] = useState<Module[]>(DEFAULT_MODULES);
  const [activeId, setActiveId] = useState<string>(DEFAULT_MODULES[0].id);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [compareCode, setCompareCode] = useState<string>('');
  const [granularity, setGranularity] = useState<'annual' | 'semi' | 'quarter'>('semi');
  const [years, setYears] = useState<5 | 10>(10);
  const [customData, setCustomData] = useState<CustomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PickerCatalog | null>(null);
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const bootedRef = useRef(false);

  const active = modules.find((m) => m.id === activeId) ?? modules[0];

  const peerList = useMemo(() => peersOf(code), [code]);

  // 初始化：localStorage + URL 参数
  useEffect(() => {
    try {
      const ms = loadModules();
      setModules(ms);
      const savedActive = localStorage.getItem(LS_ACTIVE);
      const url = new URLSearchParams(window.location.search);
      if (url.get('picker') === '1') setPickerOpen(true);
      if (savedActive && ms.some((m) => m.id === savedActive)) setActiveId(savedActive);
      setFormulas(mergedFormulas());
    } catch {
      /* ignore */
    }
    bootedRef.current = true;
  }, []);

  // 持久化
  useEffect(() => {
    if (!bootedRef.current) return;
    try {
      localStorage.setItem(LS_MODULES, JSON.stringify(modules));
      localStorage.setItem(LS_ACTIVE, activeId);
    } catch {
      /* ignore */
    }
  }, [modules, activeId]);

  // 进入页面即拉字段目录（bs/pl/cf 科目的 label/unit 需要）
  useEffect(() => {
    let alive = true;
    fetch(`/api/finance-fields?code=${code}`)
      .then((r) => r.json())
      .then((j) => {
        if (alive && j.ok) setCatalog(j.data as PickerCatalog);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  // 字段元数据（指标来自本地 INDICATORS，报表科目来自 catalog，公式来自本地存储）
  const fieldMetas = useMemo(() => {
    const map = allFieldMetas(catalog);
    for (const i of INDICATORS) {
      if (!map.has(i.key)) {
        map.set(i.key, {
          key: i.key,
          label: i.label,
          group: GROUP_LABEL[i.group],
          statement: 'indicator',
          unit: i.unit,
        });
      }
    }
    for (const f of formulas) {
      map.set(formulaKey(f.id), {
        key: formulaKey(f.id),
        label: f.name,
        group: '自定义公式',
        statement: 'formula',
        unit: f.unit,
      });
    }
    return map;
  }, [catalog, formulas]);

  // 公式字段不直接请求：但其依赖字段必须一并请求，否则公式无数据可算
  const fetchFields = useMemo(() => {
    const base = active.fields.filter((k) => !k.startsWith('fx_'));
    const allKeys = Array.from(fieldMetas.keys()).filter((k) => !k.startsWith('fx_'));
    const deps = new Set<string>();
    for (const key of active.fields) {
      if (!key.startsWith('fx_')) continue;
      const f = formulas.find((x) => formulaKey(x.id) === key);
      if (!f) continue;
      const check = checkExpr(f.expr, allKeys);
      if (check.ok) check.keys.forEach((k) => deps.add(k));
    }
    return Array.from(new Set([...base, ...deps]));
  }, [active.fields, fieldMetas, formulas]);

  // 数据加载：字段集合（无序）变化才重新抓取，拖拽排序不触发
  const fieldsSig = useMemo(() => [...fetchFields].sort().join(','), [fetchFields]);
  useEffect(() => {
    if (active.fields.length === 0) {
      setCustomData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    setCustomData(null);
    const codes = compareCode ? `${code},${compareCode}` : code;
    fetch(
      '/api/finance-compare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: codes, years, granularity, fields: fieldsSig.split(',') }) },
    )
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.ok) setCustomData(j.data as CustomData);
        else setErr(j.error ?? '财务数据获取失败');
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [code, compareCode, granularity, years, fieldsSig, fetchFields.length]);

  // 公式改了但模块里引用了公式字段时，重算即可（数据本身不变），依赖 formulas 触发重渲染
  const data = customData;
  const primary = data?.companies?.[0];
  const compare = data?.companies?.[1] ?? null;

  const toSeries = (c: CompanyFinancials | null, key: string): CompanySeries => {
    const labels = c?.periodLabels ?? [];
    let values: (number | null)[];
    if (key.startsWith('fx_')) {
      const f = formulas.find((x) => formulaKey(x.id) === key);
      values = f
        ? evalFormula(f.expr, c?.series ?? {}, c?.periods.length ?? 0, { nullAsZero: f.nullAsZero })
        : [];
    } else {
      values = c?.series?.[key] ?? [];
    }
    return {
      code: c?.code ?? '',
      name: c?.name ?? '',
      // 年报视图下把「2021H2」显示为「2021」
      periodLabels: granularity === 'annual' ? labels.map((l) => l.replace(/H2$/, '')) : labels,
      values,
    };
  };

  /* ---------- 模块操作 ---------- */
  const renameCommit = () => {
    setRenaming(false);
    const name = renameDraft.trim();
    if (!name) return;
    setModules((ms) => ms.map((m) => (m.id === active.id ? { ...m, name } : m)));
  };

  const renameStart = () => {
    setRenameDraft(active.name);
    setRenaming(true);
  };

  const addModule = () => {
    const id = `m-${Date.now()}`;
    setModules((ms) => [...ms, { id, name: `新模块 ${ms.length - DEFAULT_MODULES.length + 1}`, fields: [] }]);
    setActiveId(id);
    setPickerOpen(true);
  };

  const removeModule = () => {
    const next = modules.filter((m) => m.id !== active.id);
    if (next.length === 0) {
      setModules(DEFAULT_MODULES);
      setActiveId(DEFAULT_MODULES[0].id);
      return;
    }
    setModules(next);
    setActiveId(next[0].id);
  };

  const resetAll = () => {
    setModules(DEFAULT_MODULES);
    setActiveId(DEFAULT_MODULES[0].id);
    setPickerOpen(false);
  };

  const confirmFields = (keys: string[]) => {
    setPickerOpen(false);
    setModules((ms) => ms.map((m) => (m.id === active.id ? { ...m, fields: keys } : m)));
  };

  /* ---------- 左侧列表拖拽排序 ---------- */
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    setModules((ms) =>
      ms.map((m) => {
        if (m.id !== active.id) return m;
        const fields = [...m.fields];
        const [moved] = fields.splice(from, 1);
        fields.splice(to, 0, moved);
        return { ...m, fields };
      }),
    );
  };

  const entries = active.fields.map((key) => {
    const meta = fieldMetas.get(key);
    // 自定义公式：悬停显示公式内容
    const f = key.startsWith('fx_') ? formulas.find((x) => formulaKey(x.id) === key) : undefined;
    return {
      key,
      label: meta?.label ?? key,
      groupLabel: meta ? `${meta.group}` : '',
      unit: meta?.unit ?? '',
      hover: f ? `${f.name} = ${f.expr}` : undefined,
    };
  });

  const scrollTo = (key: string) => {
    sectionRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="space-y-4">
      {/* 顶栏：主/对比公司 + 报告期粒度（紧凑） */}
      <div className="card flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="font-medium text-slate-800">{primary?.name ?? code}</span>
          <span className="font-mono text-xs text-slate-400">{code}</span>
          <span className="chip bg-blue-100 text-blue-700">主公司</span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="hidden text-xs text-slate-500 sm:inline">对比公司：</span>
          <select
            className="input w-40 py-1 text-xs md:w-48"
            value={compareCode}
            onChange={(e) => setCompareCode(e.target.value)}
          >
            <option value="">不对比</option>
            {peerList.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}（{p.code}）
              </option>
            ))}
          </select>
          {compare && <span className="chip bg-orange-100 text-orange-700">对比公司</span>}
        </div>

        <div className="ml-auto flex items-center gap-1">
          {(
            [
              ['annual', '年报'],
              ['semi', '中报'],
              ['quarter', '季报'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setGranularity(k)}
              title={
                k === 'annual'
                  ? '仅年度报告（12-31）'
                  : k === 'semi'
                    ? '半年报口径（H1 + H2）'
                    : '全部季度报告（Q1/H1/Q3/年报）'
              }
              className={`rounded px-2.5 py-1 text-xs transition ${
                granularity === k ? 'bg-slate-200 font-medium text-slate-800' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-slate-200" />
          {(
            [
              [5, '近5年'],
              [10, '近10年'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setYears(k)}
              title={`展示最近 ${k} 个自然年的报告期`}
              className={`rounded px-2.5 py-1 text-xs transition ${
                years === k ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 分析模块条（理杏仁式）+ 重命名 / 数据显示设置 */}
      <div className="card flex items-center gap-1 overflow-x-auto px-1 py-0">
        <div className="flex min-w-0 flex-1 items-center">
          {modules.map((m) => (
            <div key={m.id} className="relative shrink-0">
              {renaming && m.id === activeId ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={renameCommit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') renameCommit();
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                  className="mx-1 my-1 w-28 rounded border border-brand-400 px-2.5 py-1.5 text-sm outline-none"
                />
              ) : (
                <button
                  onClick={() => setActiveId(m.id)}
                  className={`relative px-3.5 py-2 text-sm transition md:px-4 ${
                    m.id === active.id
                      ? 'font-semibold text-brand-700'
                      : 'text-slate-600 hover:text-brand-600'
                  }`}
                >
                  {m.name}
                  <span className="ml-1 text-xs font-normal text-slate-400">{m.fields.length}项</span>
                  {m.id === active.id && (
                    <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t bg-brand-600" />
                  )}
                </button>
              )}
            </div>
          ))}
          <button
            onClick={addModule}
            title="新增分析模块"
            className="shrink-0 rounded px-2 py-1 text-lg leading-none text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
          >
            +
          </button>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 px-2 py-1">
          {renaming ? null : (
            <>
              <button
                onClick={renameStart}
                className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-brand-400 hover:text-brand-700"
              >
                重命名
              </button>
              <button
                onClick={() => setPickerOpen(true)}
                className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-500 transition hover:bg-red-50"
              >
                数据显示设置
              </button>
              {modules.length > 1 && (
                <button
                  onClick={removeModule}
                  title="删除当前模块"
                  className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-400 transition hover:border-red-300 hover:text-red-500"
                >
                  删除
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {err && <div className="card-pad text-sm text-red-600">加载失败：{err}</div>}
      {loading && !data && <div className="card-pad text-sm text-slate-400">财报数据加载中…（首次抓取约需 3-8 秒）</div>}

      {data && (
        <div className="grid gap-3 lg:grid-cols-[150px_1fr]">
          {/* 左侧指标列表：理杏仁式蓝色块；移动端横向滚动 chips */}
          <div className="lg:sticky lg:top-16 lg:h-fit">
            <div className="hidden pb-1.5 pl-1 text-xs text-slate-400 lg:block">
              可选单位点击 · 拖 ⠿ 排序
            </div>
            <ul className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
              {entries.length === 0 && (
                <li className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">
                  暂无指标，请点「数据显示设置」勾选
                </li>
              )}
              {entries.map((e, idx) => (
                <li
                  key={e.key}
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragEnter={() => setOverIdx(idx)}
                  onDragOver={(ev) => ev.preventDefault()}
                  onDragEnd={() => {
                    if (dragIdx !== null && overIdx !== null) reorder(dragIdx, overIdx);
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                  onClick={() => scrollTo(e.key)}
                  className={`flex shrink-0 cursor-grab items-center gap-1 rounded px-2 py-1.5 text-xs leading-snug transition active:cursor-grabbing ${
                    dragIdx === idx ? 'opacity-40' : ''
                  } ${
                    overIdx === idx && dragIdx !== null && dragIdx !== idx
                      ? 'lg:border-t-2 lg:border-brand-300'
                      : ''
                  } ${
                    idx % 2 === 0
                      ? 'bg-brand-500 text-white hover:bg-brand-600'
                      : 'bg-brand-400 text-white hover:bg-brand-600'
                  }`}
                  title={e.hover ?? `${e.label}（点击跳转，拖动排序）`}
                >
                  <span
                    className="hidden select-none text-white/50 hover:text-white lg:inline"
                    title="拖动排序"
                  >
                    ⠿
                  </span>
                  <span className="max-w-[110px] truncate lg:max-w-none">{e.label}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* 右侧多图堆叠（顺序 = 左侧列表顺序） */}
          <div className="min-w-0 space-y-3">
            {!primary || primary.periods.length === 0 ? (
              <div className="card-pad text-sm text-slate-500">
                未获取到 {primary?.name ?? code} 的财报数据。可能是非 A 股标的或数据源暂时不可用。
              </div>
            ) : entries.length === 0 ? (
              <div className="card-pad text-sm text-slate-500">
                当前模块未配置任何指标。点击右上角「数据显示设置」开始勾选。
              </div>
            ) : (
              entries.map((e) => {
                const pS = toSeries(primary, e.key);
                const cS = compare ? toSeries(compare, e.key) : null;
                const hasData = pS.values.some((v) => v !== null);
                const hasCompare = cS !== null && cS.values.some((v) => v !== null);
                return (
                  <div
                    key={e.key}
                    ref={(el) => {
                      sectionRefs.current[e.key] = el;
                    }}
                    className="card scroll-mt-20 p-3 md:p-4"
                  >
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-1">
                      <h3 className="text-sm font-semibold text-brand-600">{e.label}</h3>
                      <span className="text-[11px] text-slate-400">
                        {unitText(e.unit)} · 新浪财经（披露口径）
                      </span>
                    </div>
                    {hasData ? (
                      <FinanceCompareChart
                        indicator={{ unit: e.unit }}
                        primary={pS}
                        compare={hasCompare ? cS : null}
                        height={280}
                      />
                    ) : (
                      <div className="py-10 text-center text-sm text-slate-400">该科目暂未披露</div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <FieldPicker
        open={pickerOpen}
        catalog={catalog}
        selected={active?.fields ?? []}
        defaultSelected={DEFAULT_MODULES[0].fields}
        formulas={formulas}
        onAddFormula={(f) => {
          const next = [...formulas, f];
          setFormulas(next);
          saveFormulas(next.filter((x) => !x.preset));
        }}
        onDeleteFormula={(id) => {
          const target = formulas.find((x) => x.id === id);
          if (target?.preset) {
            // 预设公式：删除 = 隐藏
            hidePreset(id);
          } else {
            saveFormulas(formulas.filter((x) => x.id !== id && !x.preset));
          }
          setFormulas(formulas.filter((x) => x.id !== id));
          // 同步从所有模块中移除该公式字段
          setModules((ms) =>
            ms.map((m) => ({ ...m, fields: m.fields.filter((k) => k !== formulaKey(id)) })),
          );
        }}
        formulaSourceFields={fieldMetas.size > 0 ? Array.from(fieldMetas.values()).filter((m) => !m.key.startsWith('fx_')).map((m) => ({ key: m.key, label: `${m.label}（${m.key}）` })) : []}
        onClose={() => setPickerOpen(false)}
        onConfirm={confirmFields}
        title={`数据显示设置 · ${active?.name ?? ''}`}
        onResetAll={resetAll}
      />

      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>数据来自新浪财经三大报表与财务指标页（交易所披露口径），每报告期更新。模块配置保存在本地浏览器。</span>
        <Link href={`/stock/${code}`} className="text-brand-600 hover:underline">
          ← 返回个股行情页
        </Link>
      </div>
    </div>
  );
}

