'use client';

import { personalStorage } from '@/lib/personalStorage';

import { useEffect, useMemo, useRef, useState } from 'react';
import FinanceCompareChart, {
  type CompanySeries,
} from '@/components/FinanceCompareChart';
import FieldPicker, {
  allFieldMetas,
  type FieldMeta,
  type PickerCatalog,
} from '@/components/FieldPicker';
import {
  INDICATORS,
  type IndicatorGroup,
} from '@/lib/datasource/sinaFinancial';
import {
  checkExpr,
  evalFormula,
  formulaKey,
  hidePreset,
  mergedFormulas,
  saveFormulas,
  type Formula,
} from '@/lib/financeFormulas';
import type { SearchHit } from '@/lib/datasource/types';
import { STOCKS } from '@/lib/universe';
import { normalizeStockCode } from '@/lib/datasource/codes';
import {
  financeStorageKey,
  sanitizeFields,
  takeLegacyHkModules,
} from '@/lib/financePreferences';

interface CompanyFinancials {
  currency?: string;
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

const GROUPS: IndicatorGroup[] = [
  'profit',
  'growth',
  'solvency',
  'cashflow',
  'pershare',
];
const GROUP_LABEL: Record<IndicatorGroup, string> = {
  profit: '盈利能力',
  growth: '成长性',
  solvency: '偿债能力',
  cashflow: '现金流',
  pershare: '每股指标',
};

/** 默认模块（与精选 21 项指标一致；配置指标中可任意改配） */
const DEFAULT_MODULES: Module[] = [
  {
    id: 'm-overview',
    name: '关键指标',
    fields: [
      'roe',
      'netMargin',
      'revenueGrowth',
      'profitGrowth',
      'ocfPerShare',
      'debtRatio',
    ],
  },
  ...GROUPS.map((g) => ({
    id: `m-${g}`,
    name: GROUP_LABEL[g],
    fields: INDICATORS.filter((i) => i.group === g).map((i) => i.key),
  })),
];

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
  const stockCode = normalizeStockCode(code)?.code ?? code;
  const self = STOCKS.find((s) => s.code === stockCode);
  const pool = self
    ? STOCKS.filter((s) => s.industry === self.industry && s.code !== stockCode)
    : [];
  const rest = STOCKS.filter((s) => s.code !== stockCode && !pool.includes(s));
  return [...pool, ...rest].map((s) => ({ code: s.code, name: s.name }));
}

function loadModules(storageKey = LS_MODULES): Module[] {
  try {
    const raw = personalStorage.getItem(storageKey);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        const valid = arr
          .filter(
            (m) =>
              m &&
              typeof m.id === 'string' &&
              typeof m.name === 'string' &&
              Array.isArray(m.fields),
          )
          .map((m) => ({
            id: m.id,
            name: m.name,
            fields: m.fields.slice(0, 36),
          }));
        if (valid.length > 0) return valid;
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_MODULES;
}

/**
 * 财务体检（理杏仁式）：
 * 左侧指标导航可拖动排序，右侧同时展示模块内的全部趋势图。
 * 每个模块从三大报表 178 个披露科目 + 21 项财务指标中自由配置。
 */
export default function FinanceExplorer({ code }: { code: string }) {
  const modulesKey = financeStorageKey(LS_MODULES, code);
  const activeKey = financeStorageKey(LS_ACTIVE, code);
  const [loadedStorageKey, setLoadedStorageKey] = useState('');
  const [modules, setModules] = useState<Module[]>(DEFAULT_MODULES);
  const [activeId, setActiveId] = useState<string>(DEFAULT_MODULES[0].id);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [compareCode, setCompareCode] = useState<string>('');
  const [compareName, setCompareName] = useState<string | null>(null);
  /** 对比公司搜索：关键词 / 候选列表 / 下拉展开 */
  const [compareQuery, setCompareQuery] = useState('');
  const [compareHits, setCompareHits] = useState<SearchHit[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const compareBoxRef = useRef<HTMLDivElement>(null);
  const [granularity, setGranularity] = useState<'annual' | 'semi' | 'quarter'>(
    'annual',
  );
  const [years, setYears] = useState<5 | 10>(10);
  const [customData, setCustomData] = useState<CustomData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PickerCatalog | null>(null);
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [visibleLabels, setVisibleLabels] = useState(true);
  const moduleMenuRef = useRef<HTMLDetailsElement>(null);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const bootedRef = useRef(false);

  const active = modules.find((m) => m.id === activeId) ?? modules[0];

  const peerList = useMemo(() => peersOf(code), [code]);
  // 对比公司搜索：300ms 防抖调 /api/search，只保留股票
  useEffect(() => {
    if (!compareOpen) return;
    const q = compareQuery.trim();
    if (!q) {
      setCompareHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((j) => {
          if (j.ok && Array.isArray(j.data))
            setCompareHits(j.data.filter((h: SearchHit) => h.kind === 'stock').slice(0, 8));
        })
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [compareQuery, compareOpen]);

  // 点击组件外部收起下拉
  useEffect(() => {
    if (!compareOpen) return;
    const dismiss = (e: PointerEvent) => {
      if (compareBoxRef.current && !compareBoxRef.current.contains(e.target as Node))
        setCompareOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [compareOpen]);

  const pickCompare = (h: SearchHit) => {
    setCompareCode(h.code);
    setCompareName(h.name);
    setCompareQuery('');
    setCompareHits([]);
    setCompareOpen(false);
  };

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const menu = moduleMenuRef.current;
      if (
        menu?.open &&
        event.target instanceof Node &&
        !menu.contains(event.target)
      )
        menu.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const menu = moduleMenuRef.current;
      if (event.key === 'Escape' && menu?.open) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  // 初始化：localStorage + URL 参数
  useEffect(() => {
    try {
      const isHk = modulesKey.endsWith('.hk');
      let ms = loadModules(modulesKey);
      if (isHk && !personalStorage.getItem(modulesKey)) {
        // 旧全局键里可能存有港股配置（PR#6 之前 A股/港股共用一个键），搬迁过来
        const legacy = takeLegacyHkModules(LS_MODULES);
        if (legacy) ms = legacy as unknown as typeof ms;
      } else if (!isHk) {
        // 清洗残留的港股科目 key（旧全局键污染），否则显示裸 key 且无数据
        ms = ms.map((m) => ({ ...m, fields: sanitizeFields(m.fields, false) }));
      }
      setModules(ms);
      const savedActive = personalStorage.getItem(activeKey);
      const url = new URLSearchParams(window.location.search);
      if (url.get('picker') === '1') setPickerOpen(true);
      setActiveId(
        savedActive && ms.some((m) => m.id === savedActive)
          ? savedActive
          : ms[0].id,
      );
      setFormulas(mergedFormulas());
    } catch {
      /* ignore */
    }
    bootedRef.current = true;
    setLoadedStorageKey(modulesKey);
  }, [modulesKey, activeKey]);

  // 持久化
  useEffect(() => {
    if (!bootedRef.current || loadedStorageKey !== modulesKey) return;
    try {
      personalStorage.setItem(modulesKey, JSON.stringify(modules));
      personalStorage.setItem(activeKey, activeId);
    } catch {
      /* ignore */
    }
  }, [modules, activeId, loadedStorageKey, modulesKey, activeKey]);

  // 进入页面即拉字段目录（bs/pl/cf 科目的 label/unit 需要）
  useEffect(() => {
    setCatalog(null);
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
    const allKeys = Array.from(fieldMetas.keys()).filter(
      (k) => !k.startsWith('fx_'),
    );
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
  const fieldsSig = useMemo(
    () => [...fetchFields].sort().join(','),
    [fetchFields],
  );
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
    fetch('/api/finance-compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codes: codes,
        years,
        granularity,
        fields: fieldsSig.split(','),
      }),
    })
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

  const toSeries = (
    c: CompanyFinancials | null,
    key: string,
  ): CompanySeries => {
    const labels = c?.periodLabels ?? [];
    let values: (number | null)[];
    if (key.startsWith('fx_')) {
      const f = formulas.find((x) => formulaKey(x.id) === key);
      values = f
        ? evalFormula(f.expr, c?.series ?? {}, c?.periods.length ?? 0, {
            nullAsZero: f.nullAsZero,
            positiveDenominator: f.positiveDenominator,
          })
        : [];
    } else {
      values = c?.series?.[key] ?? [];
    }
    return {
      code: c?.code ?? '',
      periods: c?.periods ?? [],
      name: `${c?.name ?? ''}${['wan', 'yuan'].includes(fieldMetas.get(key)?.unit ?? '') ? `（${c?.currency ?? 'CNY'}）` : ''}`,
      // 年报视图下把「2021H2」显示为「2021」
      periodLabels:
        granularity === 'annual'
          ? labels.map((l) => l.replace(/H2$/, ''))
          : labels,
      values,
    };
  };

  /* ---------- 模块操作 ---------- */
  const renameCommit = () => {
    setRenaming(false);
    const name = renameDraft.trim();
    if (!name) return;
    setModules((ms) =>
      ms.map((m) => (m.id === active.id ? { ...m, name } : m)),
    );
  };

  const renameStart = () => {
    setRenameDraft(active.name);
    setRenaming(true);
  };

  const addModule = () => {
    const id = `m-${Date.now()}`;
    setModules((ms) => [
      ...ms,
      { id, name: `新模块 ${ms.length + 1}`, fields: [] },
    ]);
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
    setModules((ms) =>
      ms.map((m) => (m.id === active.id ? { ...m, fields: keys } : m)),
    );
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
    const f = key.startsWith('fx_')
      ? formulas.find((x) => formulaKey(x.id) === key)
      : undefined;
    return {
      key,
      label: meta?.label ?? key,
      groupLabel: meta ? `${meta.group}` : '',
      unit: meta?.unit ?? '',
      hover: f
        ? `${f.name} = ${f.expr}${f.description ? '\n' + f.description : ''}`
        : undefined,
    };
  });

  const scrollTo = (key: string) => {
    setSelectedField(key);
    sectionRefs.current[key]?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'start',
    });
  };

  return (
    <div className="space-y-3">
      {/* 顶栏：主/对比公司 + 报告期粒度（紧凑） */}
      <div className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="font-medium text-slate-800">
            {primary?.name ?? code}
          </span>
          <span className="font-mono text-xs text-slate-400">{code}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="hidden text-xs text-slate-500 sm:inline">
            对比公司：
          </span>
          <div ref={compareBoxRef} className="relative">
            {compareCode ? (
              // 已选：芯片 + 一键清除
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 py-1 pl-2.5 pr-1 text-sm text-orange-700">
                <span className="font-medium">{compareName ?? compareCode}</span>
                <span className="font-mono text-xs text-orange-400">{compareCode}</span>
                <button
                  type="button"
                  aria-label="清除对比公司"
                  title="清除对比公司"
                  onClick={() => {
                    setCompareCode('');
                    setCompareName(null);
                  }}
                  className="flex h-5 w-5 items-center justify-center rounded-md text-orange-500 transition hover:bg-orange-100 hover:text-orange-700"
                >
                  ✕
                </button>
              </span>
            ) : (
              <>
                <input
                  type="text"
                  role="combobox"
                  aria-expanded={compareOpen && compareHits.length > 0}
                  aria-label="搜索对比公司"
                  placeholder="搜索对比公司…"
                  value={compareQuery}
                  onChange={(e) => {
                    setCompareQuery(e.target.value);
                    setCompareOpen(true);
                  }}
                  onFocus={() => setCompareOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setCompareOpen(false);
                    if (
                      e.key === 'Enter' &&
                      compareOpen &&
                      compareHits[0]
                    )
                      pickCompare(compareHits[0]);
                  }}
                  className="input !w-44 text-sm md:!w-52"
                />
                {compareOpen && compareHits.length > 0 && (
                  <ul
                    role="listbox"
                    className="absolute left-0 top-full z-30 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
                  >
                    {compareHits.map((h) => (
                      <li key={h.symbol}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          onClick={() => pickCompare(h)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-slate-50"
                        >
                          <span className="font-medium text-slate-800">{h.name}</span>
                          <span className="font-mono text-xs text-slate-400">{h.code}</span>
                          <span className="ml-auto text-xs text-slate-400">{h.market}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          {compare && (
            <span className="chip bg-orange-100 text-orange-700">对比公司</span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1 rounded-lg bg-slate-50 p-1">
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
              aria-pressed={granularity === k}
              title={
                k === 'annual'
                  ? '仅年度报告（12-31）'
                  : k === 'semi'
                    ? '半年报口径（H1 + H2）'
                    : '全部季度报告（Q1/H1/Q3/年报）'
              }
              className={`min-h-10 rounded-md px-2.5 py-1 text-xs transition sm:min-h-8 ${
                granularity === k
                  ? 'bg-slate-200 font-medium text-slate-800'
                  : 'text-slate-500 hover:bg-slate-100'
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
              aria-pressed={years === k}
              title={`展示最近 ${k} 个自然年的报告期`}
              className={`min-h-10 rounded-md px-2.5 py-1 text-xs transition sm:min-h-8 ${
                years === k
                  ? 'bg-brand-50 font-medium text-brand-700'
                  : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 分析模块条（理杏仁式）+ 重命名 / 配置指标 */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
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
                  onClick={() => {
                    setActiveId(m.id);
                    setSelectedField(null);
                  }}
                  aria-pressed={m.id === active.id}
                  className={`relative min-h-10 px-3 py-1.5 text-[13px] transition sm:min-h-8 ${
                    m.id === active.id
                      ? 'font-semibold text-brand-700'
                      : 'text-slate-600 hover:text-brand-600'
                  }`}
                >
                  {m.name}
                  <span className="ml-1 text-xs font-normal text-slate-400">
                    {m.fields.length}项
                  </span>
                  {m.id === active.id && (
                    <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t bg-brand-600" />
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setPickerOpen(true)}
            className="btn !min-h-10 !py-1 !text-xs sm:!min-h-8"
          >
            配置指标
          </button>
          <details ref={moduleMenuRef} className="relative">
            <summary
              aria-label="管理分析模块"
              className="btn !min-h-10 list-none !px-2.5 !py-1 text-base sm:!min-h-8 [&::-webkit-details-marker]:hidden"
            >
              ···
            </summary>
            <div className="absolute right-0 top-full z-30 mt-2 min-w-36 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
              <button
                onClick={(e) => {
                  addModule();
                  e.currentTarget.closest('details')?.removeAttribute('open');
                }}
                className="block w-full rounded px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
              >
                新增模块
              </button>
              <button
                onClick={(e) => {
                  renameStart();
                  e.currentTarget.closest('details')?.removeAttribute('open');
                }}
                className="block w-full rounded px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50"
              >
                重命名模块
              </button>
              {modules.length > 1 && (
                <button
                  onClick={(e) => {
                    removeModule();
                    e.currentTarget.closest('details')?.removeAttribute('open');
                  }}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50"
                >
                  删除当前模块
                </button>
              )}
            </div>
          </details>
        </div>
      </div>

      {err && (
        <div className="card-pad text-sm text-red-600">加载失败：{err}</div>
      )}
      {loading && !data && (
        <div className="card-pad text-sm text-slate-400">财报数据加载中…</div>
      )}

      {data && (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[172px_minmax(0,1fr)]">
          <aside
            className="min-w-0 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto"
            aria-label="指标导航"
          >
            <div className="hidden px-2 pb-2 text-xs font-semibold text-slate-600 lg:block">
              {active.name} · {entries.length} 项指标
            </div>
            <div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:gap-0 lg:overflow-visible">
              {entries.map((e, index) => {
                const selected =
                  (entries.some((x) => x.key === selectedField)
                    ? selectedField
                    : entries[0]?.key) === e.key;
                return (
                  <button
                    key={e.key}
                    draggable
                    onDragStart={() => setDragIdx(index)}
                    onDragEnter={() => setOverIdx(index)}
                    onDragOver={(ev) => ev.preventDefault()}
                    onDragEnd={() => {
                      if (dragIdx !== null && overIdx !== null)
                        reorder(dragIdx, overIdx);
                      setDragIdx(null);
                      setOverIdx(null);
                    }}
                    onClick={() => scrollTo(e.key)}
                    aria-current={selected ? 'location' : undefined}
                    title={e.hover}
                    className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-md border-l-[3px] px-2 py-1.5 text-left text-[13px] leading-snug transition sm:min-h-8 lg:w-full ${selected ? 'border-brand-600 bg-brand-100 font-semibold text-brand-700' : 'border-transparent font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-950'} ${dragIdx === index ? 'opacity-40' : ''} ${overIdx === index && dragIdx !== null && dragIdx !== index ? 'ring-1 ring-brand-300' : ''}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${selected ? 'bg-brand-600' : 'bg-slate-400'}`}
                    />
                    <span className="whitespace-nowrap lg:whitespace-normal">
                      {e.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* 模块内指标按导航顺序纵向展示 */}
          <div className="min-w-0 space-y-3">
            {!primary || primary.periods.length === 0 ? (
              <div className="card-pad text-sm text-slate-500">
                未获取到 {primary?.name ?? code} 的财报数据。可能是非 A
                股标的或数据源暂时不可用。
              </div>
            ) : entries.length === 0 ? (
              <div className="card-pad text-sm text-slate-500">
                当前模块未配置任何指标。点击右上角「配置指标」开始勾选。
              </div>
            ) : (
              entries.map((e) => {
                const pS = toSeries(primary, e.key);
                const cS = compare ? toSeries(compare, e.key) : null;
                const hasData = pS.values.some((v) => v !== null);
                const hasCompare =
                  cS !== null && cS.values.some((v) => v !== null);
                return (
                  <div
                    key={e.key}
                    ref={(el) => {
                      sectionRefs.current[e.key] = el;
                    }}
                    className="card scroll-mt-24 p-3"
                  >
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-1">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {e.label}
                      </h3>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 break-words text-[11px] text-slate-500">
                          {e.key === 'fx_p-interest-coverage'
                            ? '倍 · 费用化利息口径（东方财富）'
                            : `${unitText(e.unit)} · ${primary?.source.includes('hkf10') ? `东方财富（${primary.currency ?? '原币'}）` : '新浪财经（披露口径）'}`}
                        </span>
                        <button
                          type="button"
                          aria-label={`${visibleLabels ? '隐藏' : '显示'}所有图表的节点数据`}
                          aria-pressed={visibleLabels}
                          onClick={() => setVisibleLabels((prev) => !prev)}
                          className={`min-h-10 shrink-0 rounded-md px-2 py-1 text-xs font-medium transition sm:min-h-8 ${visibleLabels ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-brand-700'}`}
                        >
                          {visibleLabels ? '隐藏数据' : '显示数据'}
                        </button>
                      </div>
                    </div>
                    {hasData ? (
                      <FinanceCompareChart
                        indicator={{ unit: e.unit }}
                        reportLabel={primary.periods.at(-1)}
                        primary={pS}
                        compare={hasCompare ? cS : null}
                        height={220}
                        showLabels={visibleLabels}
                      />
                    ) : (
                      <div className="py-10 text-center text-sm text-slate-400">
                        该科目暂未披露
                      </div>
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
        formulas={
          modulesKey.endsWith('.hk')
            ? formulas.filter(
                (f) =>
                  checkExpr(
                    f.expr,
                    Array.from(fieldMetas.keys()).filter(
                      (k) => !k.startsWith('fx_'),
                    ),
                  ).ok,
              )
            : formulas
        }
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
            ms.map((m) => ({
              ...m,
              fields: m.fields.filter((k) => k !== formulaKey(id)),
            })),
          );
        }}
        formulaSourceFields={
          fieldMetas.size > 0
            ? Array.from(fieldMetas.values())
                .filter((m) => !m.key.startsWith('fx_'))
                .map((m) => ({ key: m.key, label: `${m.label}（${m.key}）` }))
            : []
        }
        onClose={() => setPickerOpen(false)}
        onConfirm={confirmFields}
        title={`配置指标 · ${active?.name ?? ''}`}
        onResetAll={resetAll}
      />
    </div>
  );
}
