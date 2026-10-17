'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useWatchlist } from '@/components/WatchlistProvider';
import { pct, price, signedPct, toneClass, yi } from '@/lib/format';
import type { Quote } from '@/lib/datasource/types';

export interface QuoteTableProps {
  codes: string[];
  /** 是否显示“移出自选”按钮 */
  removable?: boolean;
  emptyText?: React.ReactNode;
}

type SortKey = 'code' | 'price' | 'changePct' | 'pe' | 'pb' | 'roe' | 'cap';

/**
 * 行情表格（客户端拉取）。
 * 自选页与首页共用：传入代码数组即可，排序在前端做，避免每点一次都回源。
 */
export default function QuoteTable({ codes, removable = false, emptyText = '暂无标的' }: QuoteTableProps) {
  const wl = useWatchlist();
  const [rows, setRows] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'changePct', desc: true });

  useEffect(() => {
    if (codes.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`/api/quote?codes=${codes.join(',')}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.ok) {
          setRows(j.data as Quote[]);
          setErr(null);
        } else {
          setErr(j.error ?? '获取失败');
        }
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [codes.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const val = (q: Quote, key: SortKey): number => {
    switch (key) {
      case 'price':
        return q.price ?? -Infinity;
      case 'changePct':
        return q.changePct ?? -Infinity;
      case 'pe':
        return q.pe ?? -Infinity;
      case 'pb':
        return q.pb ?? -Infinity;
      case 'roe':
        return q.pb && q.pe ? q.pb / q.pe : -Infinity;
      case 'cap':
        return q.totalMarketCap ?? -Infinity;
      default:
        return Number(q.code);
    }
  };

  const sorted = [...rows].sort((a, b) => {
    const d = val(a, sort.key) - val(b, sort.key);
    return sort.desc ? -d : d;
  });

  const head = (key: SortKey, label: string) => (
    <th
      className="th cursor-pointer select-none hover:text-slate-800"
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}
    >
      {label}
      {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </th>
  );

  if (codes.length === 0) {
    return <div className="card-pad text-sm text-slate-400">{emptyText}</div>;
  }
  if (loading) {
    return <div className="card-pad text-sm text-slate-400">加载中…</div>;
  }
  if (err) {
    return <div className="card-pad text-sm text-red-600">加载失败：{err}</div>;
  }

  return (
    <div className="card overflow-x-auto">
      <table className="min-w-full">
        <thead className="border-b border-slate-100 bg-slate-50/60">
          <tr>
            {head('code', '名称/代码')}
            {head('price', '最新价')}
            {head('changePct', '涨跌幅')}
            {head('pe', 'PE(TTM)')}
            {head('pb', 'PB')}
            {head('roe', 'ROE')}
            {head('cap', '总市值')}
            {removable && <th className="th text-right">操作</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {sorted.map((q) => {
            const roe = q.pb && q.pe ? (q.pb / q.pe) * 100 : null;
            return (
              <tr key={q.symbol} className="hover:bg-slate-50/60">
                <td className="td">
                  <Link
                    href={q.kind === 'index' ? `/index/${q.code}` : `/stock/${q.code}`}
                    prefetch={false}
                    className="hover:text-brand-600"
                  >
                    <div className="font-medium text-slate-900">{q.name}</div>
                    <div className="font-mono text-xs text-slate-400">{q.code}</div>
                  </Link>
                </td>
                <td className={`td font-medium ${toneClass(q.change)}`}>{price(q.price)}</td>
                <td className={`td ${toneClass(q.changePct)}`}>{signedPct(q.changePct)}</td>
                <td className="td">{q.pe ? q.pe.toFixed(2) : '--'}</td>
                <td className="td">{q.pb ? q.pb.toFixed(2) : '--'}</td>
                <td className="td">{roe ? pct(roe) : '--'}</td>
                <td className="td">{yi(q.totalMarketCap)}</td>
                {removable && (
                  <td className="td text-right">
                    <button
                      onClick={() => wl.remove(q.code)}
                      className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-red-50 hover:text-red-600"
                    >
                      移除
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

