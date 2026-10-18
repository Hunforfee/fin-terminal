'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import WatchlistButton from '@/components/WatchlistButton';
import { normalizeStockCode } from '@/lib/datasource/codes';
import { useSearchParams } from 'next/navigation';
import { INDUSTRIES } from '@/lib/universe';
import { pct, price, yi } from '@/lib/format';
import { compareResearchValues } from '@/lib/researchColumns';

interface Row {
  code: string;
  name: string;
  industry: string;
  price: number | null;
  changePct: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  totalMarketCap: number | null;
}

interface Criteria {
  industry: string;
  peMin: string;
  peMax: string;
  pbMin: string;
  pbMax: string;
  roeMin: string;
  capMin: string;
  capMax: string;
}

const EMPTY: Criteria = {
  industry: '',
  peMin: '',
  peMax: '',
  pbMin: '',
  pbMax: '',
  roeMin: '',
  capMin: '',
  capMax: '',
};

const PRESETS: { label: string; value: Partial<Criteria> }[] = [
  { label: '低估值（PE 0-20）', value: { peMin: '0', peMax: '20' } },
  { label: '高 ROE（≥15%）', value: { roeMin: '15' } },
  { label: '破净（PB<1）', value: { pbMax: '1' } },
  { label: '大盘蓝筹（市值≥1000亿）', value: { capMin: '1000' } },
];

function buildQuery(c: Criteria): string {
  const p = new URLSearchParams();
  if (c.industry) p.set('industry', c.industry);
  if (c.peMin) p.set('peMin', c.peMin);
  if (c.peMax) p.set('peMax', c.peMax);
  if (c.pbMin) p.set('pbMin', c.pbMin);
  if (c.pbMax) p.set('pbMax', c.pbMax);
  if (c.roeMin) p.set('roeMin', c.roeMin);
  if (c.capMin) p.set('marketCapMin', c.capMin);
  if (c.capMax) p.set('marketCapMax', c.capMax);
  p.set('limit', '300');
  return p.toString();
}

function ScreenerInner() {
  const sp = useSearchParams();
  const [criteria, setCriteria] = useState<Criteria>({
    ...EMPTY,
    industry: sp.get('industry') ?? '',
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: keyof Row; desc: boolean }>({
    key: 'totalMarketCap',
    desc: true,
  });

  const query = buildQuery(criteria);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setErr(null);
    setRows([]);
    setTotal(0);
    const timer = setTimeout(() => {
      fetch(`/api/screen?${query}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return;
          if (j.ok) {
            setRows(j.data.rows);
            setTotal(j.data.total);
            setErr(null);
          } else setErr(j.error ?? '筛选失败');
        })
        .catch((e) => alive && setErr(String(e)))
        .finally(() => alive && setLoading(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const set = (k: keyof Criteria, v: string) =>
    setCriteria((c) => ({ ...c, [k]: v }));

  const sorted = [...rows].sort((a, b) => {
    return compareResearchValues(
      a[sort.key],
      b[sort.key],
      sort.desc ? 'desc' : 'asc',
    );
  });

  const exportCsv = () => {
    const head = [
      '代码',
      '名称',
      '行业',
      '最新价',
      '涨跌幅%',
      'PE',
      'PB',
      'ROE%',
      '总市值(亿)',
    ];
    const lines = sorted.map((r) =>
      [
        r.code,
        r.name,
        r.industry,
        r.price ?? '',
        r.changePct ?? '',
        r.pe ?? '',
        r.pb ?? '',
        r.roe?.toFixed(2) ?? '',
        r.totalMarketCap ?? '',
      ]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([`\uFEFF${head.join(',')}\n${lines.join('\n')}`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `screener-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const head = (key: keyof Row, label: string) => (
    <th
      className="th hover:text-slate-800"
      aria-sort={
        sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'
      }
    >
      <button
        type="button"
        onClick={() =>
          setSort((s) => ({
            key,
            desc: s.key === key ? !s.desc : typeof rows[0]?.[key] === 'number',
          }))
        }
      >
        {label}
        {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );

  return (
    <div className="space-y-3">
      <div>
        <h1 className="page-title">条件选股</h1>
        <p className="mt-1 text-xs text-slate-500">
          候选池为 {INDUSTRIES.length}{' '}
          个行业的龙头股样本，实时抓取行情后按条件过滤。ROE 由 PB ÷ PE 派生。
        </p>
      </div>

      {/* 筛选面板 */}
      <div className="card-pad space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => setCriteria({ ...EMPTY, ...p.value })}
              className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-brand-300 hover:text-brand-600"
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setCriteria(EMPTY)}
            className="rounded border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50"
          >
            清空条件
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="行业">
            <select
              className="input"
              value={criteria.industry}
              onChange={(e) => set('industry', e.target.value)}
            >
              <option value="">全部行业</option>
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </Field>
          <RangeField
            label="PE(TTM)"
            a={criteria.peMin}
            b={criteria.peMax}
            setA={(v) => set('peMin', v)}
            setB={(v) => set('peMax', v)}
          />
          <RangeField
            label="PB"
            a={criteria.pbMin}
            b={criteria.pbMax}
            setA={(v) => set('pbMin', v)}
            setB={(v) => set('pbMax', v)}
          />
          <Field label="ROE 估算值下限(%)">
            <input
              className="input"
              type="number"
              placeholder="如 15"
              value={criteria.roeMin}
              onChange={(e) => set('roeMin', e.target.value)}
            />
          </Field>
          <RangeField
            label="总市值(亿)"
            a={criteria.capMin}
            b={criteria.capMax}
            setA={(v) => set('capMin', v)}
            setB={(v) => set('capMax', v)}
          />
        </div>
      </div>

      {/* 结果 */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600">
          {loading ? '筛选中…' : `命中 ${total} 只`}
          {err && <span className="ml-2 text-red-600">{err}</span>}
        </div>
        {rows.length > 0 && (
          <button onClick={exportCsv} className="btn">
            导出 CSV
          </button>
        )}
      </div>

      <div className="card max-h-[680px] overflow-auto">
        <table
          aria-label="条件选股结果"
          className="dense-data-table min-w-[760px] w-full"
        >
          <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50">
            <tr>
              {head('name', '公司')}
              {head('industry', '行业')}
              {head('price', '最新价')}
              {head('pe', 'PE(TTM)')}
              {head('pb', 'PB')}
              {head('roe', 'ROE（估算）')}
              {head('totalMarketCap', '总市值')}
              <th className="th text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {loading && (
              <tr>
                <td colSpan={8} className="td !py-8 text-center text-slate-500">
                  筛选中…
                </td>
              </tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="td py-8 text-center text-slate-400">
                  没有符合条件的标的，试试放宽区间
                </td>
              </tr>
            )}
            {sorted.map((r) => (
              <tr key={r.code} className="hover:bg-slate-50/60">
                <td className="td">
                  <Link
                    href={`/stock/${r.code}`}
                    prefetch={false}
                    title={`${r.code} · ${r.industry}`}
                    className="hover:text-brand-600"
                  >
                    <div className="font-medium text-slate-900">{r.name}</div>
                  </Link>
                </td>
                <td className="td text-xs text-slate-500">{r.industry}</td>
                <td className="td font-medium">{price(r.price)}</td>
                <td
                  className={`td ${r.pe != null && r.pe < 0 ? '!text-amber-700' : ''}`}
                >
                  {r.pe != null && Number.isFinite(r.pe)
                    ? r.pe.toFixed(2)
                    : '—'}
                </td>
                <td className="td">
                  {r.pb != null && Number.isFinite(r.pb)
                    ? r.pb.toFixed(2)
                    : '—'}
                </td>
                <td className="td">{pct(r.roe)}</td>
                <td className="td">{yi(r.totalMarketCap)}</td>
                <td className="td text-right">
                  <WatchlistButton
                    code={normalizeStockCode(r.code)?.symbol ?? r.code}
                    name={r.name}
                    compact
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function RangeField({
  label,
  a,
  b,
  setA,
  setB,
}: {
  label: string;
  a: string;
  b: string;
  setA: (v: string) => void;
  setB: (v: string) => void;
}) {
  return (
    <div>
      <span className="label mb-1 block">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          className="input"
          type="number"
          placeholder="最小"
          value={a}
          onChange={(e) => setA(e.target.value)}
        />
        <span className="text-slate-400">~</span>
        <input
          className="input"
          type="number"
          placeholder="最大"
          value={b}
          onChange={(e) => setB(e.target.value)}
        />
      </div>
    </div>
  );
}

export default function ScreenerPage() {
  return (
    <Suspense
      fallback={<div className="card-pad text-sm text-slate-400">加载中…</div>}
    >
      <ScreenerInner />
    </Suspense>
  );
}
