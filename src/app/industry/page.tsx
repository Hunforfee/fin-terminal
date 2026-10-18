"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { pct, signedPct, toneClass, yi, fmtTime } from "@/lib/format";

interface TreeL3 {
  name: string;
  count: number;
}
interface TreeL2 {
  name: string;
  count: number;
  children: TreeL3[];
}
interface TreeL1 {
  name: string;
  count: number;
  children: TreeL2[];
}
interface TreeResp {
  version: string;
  stats: { l1: number; l2: number; l3: number; stocks: number };
  industries: TreeL1[];
}

interface Row {
  code: string;
  name: string;
  price: number | null;
  changePct: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  totalMarketCap: number | null;
  turnoverRate: number | null;
}

interface MembersResp {
  node: { name: string; level: number; l1: string; l2: string | null };
  count: number;
  declared?: number;
  rows: Row[];
  note?: string;
}

type SortKey =
  "totalMarketCap" | "changePct" | "pe" | "pb" | "roe" | "turnoverRate";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "pe", label: "PE-TTM" },
  { key: "pb", label: "PB" },
  { key: "roe", label: "ROE（估算）" },
  { key: "totalMarketCap", label: "总市值" },
];

function num(v: number | null, d = 2): string {
  if (v === null || !Number.isFinite(v)) return "--";
  return v.toFixed(d);
}

export default function IndustryPage() {
  return (
    <Suspense
      fallback={<div className="text-sm text-slate-500">正在加载行业…</div>}
    >
      <IndustryContent />
    </Suspense>
  );
}

function IndustryContent() {
  const searchParams = useSearchParams();
  const linkedNode = searchParams.get("node");
  const linkedLevel = searchParams.get("level");
  const [tree, setTree] = useState<TreeResp | null>(null);
  const [treeErr, setTreeErr] = useState<string | null>(null);

  const [l1, setL1] = useState<string | null>(null);
  const [l2, setL2] = useState<string | null>(null);
  const [l3, setL3] = useState<string | null>(null);

  const [data, setData] = useState<MembersResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("totalMarketCap");
  const [asc, setAsc] = useState(false);
  const [q, setQ] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  // 分类树（轻量，仅一次）
  useEffect(() => {
    let alive = true;
    fetch("/api/sw-industry?tree=1")
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.ok) {
          const t = j.data as TreeResp;
          setTree(t);
        } else setTreeErr(j.error ?? "分类树加载失败");
      })
      .catch((e) => alive && setTreeErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // 深链接从分类树还原完整路径，避免只显示名称而仍加载默认行业。
  useEffect(() => {
    if (!tree) return;
    for (const first of tree.industries) {
      if (linkedLevel === "1" && first.name === linkedNode) {
        setL1(first.name);
        setL2(null);
        setL3(null);
        return;
      }
      for (const second of first.children) {
        if (linkedLevel === "2" && second.name === linkedNode) {
          setL1(first.name);
          setL2(second.name);
          setL3(null);
          return;
        }
        const third = second.children.find((item) => item.name === linkedNode);
        if (third && (linkedLevel === "3" || !linkedLevel)) {
          setL1(first.name);
          setL2(second.name);
          setL3(third.name);
          return;
        }
      }
    }
    setL1(tree.industries[0]?.name ?? null);
    setL2(null);
    setL3(null);
  }, [tree, linkedNode, linkedLevel]);

  const curL1 = useMemo(
    () => tree?.industries.find((x) => x.name === l1) ?? null,
    [tree, l1],
  );
  const curL2 = useMemo(
    () => curL1?.children.find((x) => x.name === l2) ?? null,
    [curL1, l2],
  );

  // 选中节点：三级优先，其次二级，再次一级
  const target = useMemo(() => {
    if (l3) return { name: l3, level: 3 };
    if (l2) return { name: l2, level: 2 };
    if (l1) return { name: l1, level: 1 };
    return null;
  }, [l1, l2, l3]);
  const targetKey = target ? `${target.level}:${target.name}` : "";

  useEffect(() => {
    if (!target) return;
    const { name, level } = target;
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch(`/api/sw-industry?node=${encodeURIComponent(name)}&level=${level}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.ok) {
          setData(j.data as MembersResp);
          setUpdatedAt(new Date().toISOString());
        } else setErr(j.error ?? "成分股加载失败");
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const rows = useMemo(() => {
    if (!data) return [];
    const filtered = q.trim()
      ? data.rows.filter(
          (r) => r.name.includes(q.trim()) || r.code.includes(q.trim()),
        )
      : data.rows;
    return [...filtered].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      const na = va === null ? -Infinity : va;
      const nb = vb === null ? -Infinity : vb;
      return asc ? na - nb : nb - na;
    });
  }, [data, q, sortKey, asc]);

  const summary = useMemo(() => {
    if (!data || data.rows.length === 0) return null;
    const pes = data.rows
      .map((r) => r.pe)
      .filter((v): v is number => v !== null);
    const pbs = data.rows
      .map((r) => r.pb)
      .filter((v): v is number => v !== null);
    const med = (arr: number[]) => {
      if (arr.length === 0) return null;
      const s = [...arr].sort((x, y) => x - y);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const up = data.rows.filter((r) => (r.changePct ?? 0) > 0).length;
    return {
      peMed: med(pes),
      pbMed: med(pbs),
      up,
      down: data.rows.length - up,
      cap: data.rows.reduce((s, r) => s + (r.totalMarketCap ?? 0), 0),
      loss: data.rows.filter((r) => r.pe !== null && r.pe < 0).length,
    };
  }, [data]);

  function pickL1(name: string) {
    setL1(name);
    setL2(null);
    setL3(null);
  }
  function pickL2(name: string) {
    setL2((prev) => (prev === name ? null : name));
    setL3(null);
  }
  function pickL3(name: string) {
    setL3((prev) => (prev === name ? null : name));
  }
  function clickSort(k: SortKey) {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "pe" || k === "pb");
    }
  }

  const breadcrumb = [l1, l2, l3].filter(Boolean) as string[];

  return (
    <div className="w-full space-y-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="page-title flex items-center gap-3">
            行业研究
            <span className="rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700">
              申万 2021
            </span>
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {tree
              ? `${tree.stats.l1} 个一级 · ${tree.stats.l2} 个二级 · ${tree.stats.l3} 个三级行业，覆盖 ${tree.stats.stocks.toLocaleString()} 只 A 股`
              : "正在加载分类树…"}
          </p>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="筛选成分股名称 / 代码"
          className="w-40 rounded border border-slate-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 md:w-52"
        />
      </div>

      {treeErr && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {treeErr}
        </div>
      )}

      {/* 三级联动选择器 */}
      <div className="card-pad mb-3 space-y-4">
        {[
          {
            label: "一级",
            items: tree?.industries ?? [],
            active: l1,
            key: "l1" as const,
          },
          {
            label: "二级",
            items: curL1?.children ?? [],
            active: l2,
            key: "l2" as const,
          },
          {
            label: "三级",
            items: curL2?.children ?? [],
            active: l3,
            key: "l3" as const,
          },
        ].map((group) => (
          <div key={group.key} className="flex items-start gap-2">
            <span className="mt-1 w-8 shrink-0 text-[11px] font-medium text-slate-400">
              {group.label}
            </span>
            <div className="flex flex-wrap gap-1">
              {group.key !== "l1" && (
                <button
                  onClick={() => {
                    if (group.key === "l2") {
                      setL2(null);
                      setL3(null);
                    } else setL3(null);
                  }}
                  className={`min-h-9 rounded-md px-2.5 py-1.5 text-xs transition ${
                    group.active === null
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  全部
                </button>
              )}
              {group.items.map((it) => {
                const active = group.active === it.name;
                return (
                  <button
                    key={it.name}
                    onClick={() =>
                      group.key === "l1"
                        ? pickL1(it.name)
                        : group.key === "l2"
                          ? pickL2(it.name)
                          : pickL3(it.name)
                    }
                    title={`${it.name}（${it.count} 只）`}
                    className={`rounded px-2 py-0.5 text-xs transition ${
                      active
                        ? "bg-brand-600 text-white"
                        : "bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-brand-50 hover:text-brand-700"
                    }`}
                  >
                    {it.name}
                    <span
                      className={`ml-1 ${active ? "text-white/70" : "text-slate-400"}`}
                    >
                      {it.count}
                    </span>
                  </button>
                );
              })}
              {group.items.length === 0 && (
                <span className="px-1 py-0.5 text-xs text-slate-300">
                  {group.key === "l2"
                    ? "请先选择一级行业"
                    : "该二级行业无三级细分"}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 当前分类概览 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <div className="flex items-center gap-1 font-medium">
          {breadcrumb.map((b, i) => (
            <span key={b} className="flex items-center gap-1">
              {i > 0 && <span className="text-slate-300">/</span>}
              <span
                className={
                  i === breadcrumb.length - 1
                    ? "text-brand-700"
                    : "text-slate-500"
                }
              >
                {b}
              </span>
            </span>
          ))}
        </div>
        {summary && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>
              成分股 <b className="text-slate-800">{data?.count}</b> 只
              {data?.declared !== undefined && data.declared !== data.count && (
                <span className="ml-1 text-amber-600">
                  （分类收录 {data.declared} 只，
                  {data.declared - (data.count ?? 0)} 只暂无行情）
                </span>
              )}
            </span>
            <span>
              PE 中位{" "}
              <b className="text-slate-800">
                {summary.peMed === null ? "--" : summary.peMed.toFixed(1)}
              </b>
            </span>
            <span>
              PB 中位{" "}
              <b className="text-slate-800">
                {summary.pbMed === null ? "--" : summary.pbMed.toFixed(2)}
              </b>
            </span>
            <span>
              合计市值 <b className="text-slate-800">{yi(summary.cap)}</b>
            </span>
            {summary.loss > 0 && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 ring-1 ring-amber-200">
                含亏损股 {summary.loss} 只（PE 为负，不剔除）
              </span>
            )}
            {updatedAt && (
              <span className="text-[11px] text-slate-400">
                行情 {fmtTime(updatedAt)}
              </span>
            )}
          </div>
        )}
      </div>

      {data?.note && (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {data.note}
        </div>
      )}
      {err && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {err}
        </div>
      )}

      <div className="max-h-[680px] overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[740px] text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th className="w-12 px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">股票</th>
              <th className="px-3 py-2 font-medium">现价</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => clickSort(c.key)}
                  className="cursor-pointer select-none whitespace-nowrap px-3 py-2 font-medium hover:text-slate-900"
                >
                  {c.label}
                  <span className="ml-1 text-slate-400">
                    {sortKey === c.key ? (asc ? "↑" : "↓") : ""}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-12 text-center text-sm text-slate-500"
                >
                  正在拉取「{target?.name}」成分股行情…
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((r, i) => (
                <tr
                  key={r.code}
                  className="border-b border-slate-100 transition hover:bg-slate-50"
                >
                  <td className="px-3 py-2 text-xs tabular-nums text-slate-400">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/stock/${r.code}`}
                      className="flex items-baseline gap-2"
                    >
                      <span className="font-medium text-brand-700 hover:underline">
                        {r.name}
                      </span>
                      <span className="text-xs tabular-nums text-slate-400">
                        {r.code}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-700">
                    {num(r.price)}
                  </td>
                  <td
                    className={`px-3 py-2 tabular-nums ${r.pe !== null && r.pe < 0 ? "text-amber-600" : "text-slate-700"}`}
                  >
                    {num(r.pe, 1)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-700">
                    {num(r.pb)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-700">
                    {pct(r.roe, 1)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-700">
                    {yi(r.totalMarketCap)}
                  </td>
                </tr>
              ))}
            {!loading && rows.length === 0 && !err && (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-12 text-center text-sm text-slate-400"
                >
                  {data?.note ? "该分类暂无成分股" : "没有匹配的股票"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <details className="mt-3 text-xs leading-6 text-slate-500">
        <summary>分类与数据口径</summary>
        分类标准：<b>申万行业分类 2021 版</b>（一级 31 / 二级 131 / 三级
        335）。成分股按东方财富 F10 行业板块映射到申万三档，
        <b>不剔除亏损股</b>，PE 为负以橙色标注。ROE 由 PB/PE
        恒等式派生，亏损股该式不成立故显示 “--”。 申万二级「国有大型银行Ⅱ /
        股份制银行Ⅱ / 城商行Ⅱ /
        农商行Ⅱ」在数据源侧与「银行Ⅱ」合并，暂无独立成分股。
      </details>
    </div>
  );
}
