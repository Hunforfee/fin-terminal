'use client';

import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';

/** 预生成深度解析的数据结构（由 /api/analysis 下发，避免打进客户端包） */
interface ViewPoint {
  point: string;
  detail: string;
}
interface Competitor {
  name: string;
  code?: string;
  note: string;
}
interface PreAnalysis {
  code: string;
  fullName?: string;
  industry: string;
  position?: string;
  summary: string;
  moat?: ViewPoint[];
  competitors?: Competitor[];
  bullCase?: ViewPoint[];
  bearCase?: ViewPoint[];
  ratingSummary?: { buy: number; hold: number; sell: number };
  targetPriceRange?: { min: number; max: number };
  source: string;
  generatedAt: string;
}

const YUANBAO_URL = 'https://yuanbao.tencent.com/';

const DEFAULT_PROMPT =
  '请深入分析{name}（{code}），包括但不限于公司的业务结构、核心竞争力、行业格局与竞争地位、财务质量（收入/利润/现金流/资产负债）、主要风险，并推测未来 1-3 年的利润区间及关键驱动因素。要求使用最新数据，反复核对，确保信息来源真实可靠；引用数据注明来源与日期，无法核实的明确标注。';

interface ReportSegment {
  name: string;
  income: number | null;
  incomeRatio: number | null;
  profitRatio: number | null;
  grossMargin: number | null;
}
interface ReportGroup {
  label: string;
  date: string | null;
  items: ReportSegment[];
}
interface ReportBusiness {
  summary: string | null;
  scope: string | null;
  industry: string | null;
  review: string | null;
  reviewDate: string | null;
  groups: ReportGroup[];
  source: string;
}
interface ReportProfile {
  holder: string | null;
  holderRatio: number | null;
  controller: string | null;
  industry: string | null;
  industryPath: string | null;
}
interface ReportItem {
  title: string;
  url: string;
  date: string | null;
  orgName: string | null;
  rating: string | null;
  targetPrice: number | null;
}
interface Report {
  name: string;
  code: string;
  market: string;
  /** 预生成的深度解析（服务端下发），未覆盖的标的为 null */
  pre: PreAnalysis | null;
  profile: ReportProfile | null;
  business: ReportBusiness | null;
  reports: ReportItem[];
  searchOk: boolean;
  generatedAt: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 要点列表：标题 + 说明的紧凑卡片，用于护城河/多空观点 */
function PointList({
  items,
  tone,
}: {
  items: ViewPoint[];
  tone: 'brand' | 'bull' | 'bear';
}) {
  const dot =
    tone === 'bull'
      ? 'bg-emerald-500'
      : tone === 'bear'
        ? 'bg-rose-400'
        : 'bg-brand-500';
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2">
          <span
            className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}
          />
          <p className="text-[12.5px] leading-5 text-slate-700">
            <span className="font-medium text-slate-900">{it.point}</span>
            <span className="text-slate-500"> —— </span>
            {it.detail}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default function AiAnalysisPanel({
  name,
  code,
  market = 'A',
}: {
  name: string;
  code: string;
  market?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [compTab, setCompTab] = useState(0);
  const nonce = useRef(0);

  useEffect(() => {
    if (!open || report) return;
    const id = ++nonce.current;
    setLoading(true);
    setErr(null);
    fetch(
      `/api/analysis?code=${encodeURIComponent(code)}&name=${encodeURIComponent(
        name,
      )}&market=${market}`,
    )
      .then((r) => r.json())
      .then((d) => {
        if (id !== nonce.current) return;
        if (d?.error) setErr(d.error);
        else setReport(d);
        setLoading(false);
      })
      .catch((e) => {
        if (id !== nonce.current) return;
        setErr(String(e));
        setLoading(false);
      });
  }, [open, report, code, name, market]);

  const askYuanbao = async () => {
    const text = `【${name}（${code}）】\n\n${DEFAULT_PROMPT.replaceAll(
      '{name}',
      name,
    ).replaceAll('{code}', code)}`;
    await copyText(text);
    window.open(YUANBAO_URL, '_blank', 'noopener,noreferrer');
  };

  const biz = report?.business;
  const pre = report?.pre ?? null;
  const hasBiz =
    biz && (biz.summary || biz.review || (biz.groups && biz.groups.length > 0));
  /** 有预生成深度解析时，即使实时 F10 抓取失败也要展示 */
  const hasContent = hasBiz || !!pre;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="查看 AI 深度解析：业务与护城河、竞争对手、市场多空观点、营收构成"
        className="btn border-brand-200 text-brand-700 hover:border-brand-300 hover:bg-brand-50"
      >
        AI 分析
      </button>

      <Modal
        open={open}
        title={`${name} · AI 分析`}
        onClose={() => {
          setOpen(false);
          setReport(null);
          setExpanded(false);
          setReviewExpanded(false);
          setCompTab(0);
        }}
        size="lg"
        maximizable
      >
        <div className="space-y-5">
          {loading && (
            <div className="flex items-center gap-3 py-10 text-sm text-slate-500">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600" />
              正在聚合公开资料与研报观点…
            </div>
          )}

          {err && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              分析生成失败：{err}
            </div>
          )}

          {report && (
            <>
              {hasContent && (
                <section>
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      公司深度解析
                    </h3>
                    {(pre?.industry || biz?.industry) && (
                      <span className="rounded bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
                        {pre?.industry || biz?.industry}
                      </span>
                    )}
                  </div>

                  {pre?.position && (
                    <p className="mb-2 border-l-2 border-brand-400 pl-2 text-[12.5px] font-medium text-slate-800">
                      {pre.position}
                    </p>
                  )}

                  <div
                    className={`space-y-2.5 whitespace-pre-line text-[13px] leading-[1.75] text-slate-700 ${
                      pre && !expanded && pre.summary.length > 420
                        ? 'max-h-[13.5rem] overflow-hidden'
                        : ''
                    }`}
                  >
                    {pre?.summary || biz?.summary || '暂无数据'}
                  </div>
                  {pre && pre.summary.length > 420 && (
                    <button
                      type="button"
                      onClick={() => setExpanded((v) => !v)}
                      className="mt-1 text-[12px] font-medium text-brand-600 hover:underline"
                    >
                      {expanded ? '收起' : '展开全文'}
                    </button>
                  )}
                  {pre?.source && (
                    <p className="mt-1 text-[11px] text-slate-400">{pre.source}</p>
                  )}
                </section>
              )}

              {pre?.moat && pre.moat.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    核心优势与护城河
                  </h3>
                  <PointList items={pre.moat} tone="brand" />
                </section>
              )}

              {pre?.competitors && pre.competitors.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    竞争对手对比
                  </h3>
                  <ul className="divide-y divide-slate-100">
                    {pre.competitors.map((c, i) => (
                      <li key={i} className="py-2 first:pt-0 last:pb-0">
                        <div className="mb-0.5 flex items-baseline gap-1.5">
                          <span className="text-[12.5px] font-medium text-slate-900">
                            {c.name}
                          </span>
                          {c.code && (
                            <span className="rounded bg-slate-100 px-1 py-px text-[10px] tabular-nums text-slate-500">
                              {c.code}
                            </span>
                          )}
                        </div>
                        <p className="text-[12.5px] leading-5 text-slate-600">
                          {c.note}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {pre &&
                ((pre.bullCase && pre.bullCase.length > 0) ||
                  (pre.bearCase && pre.bearCase.length > 0)) && (
                  <section>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-slate-900">
                        市场观点
                      </h3>
                      <div className="flex items-center gap-2 text-[11px]">
                        {pre.ratingSummary && (
                          <span className="text-slate-600">
                            买入 {pre.ratingSummary.buy}
                            {pre.ratingSummary.hold > 0 &&
                              ` · 增持 ${pre.ratingSummary.hold}`}
                            {pre.ratingSummary.sell > 0 &&
                              ` · 中性/减持 ${pre.ratingSummary.sell}`}
                          </span>
                        )}
                        {pre.targetPriceRange &&
                          pre.targetPriceRange.max > 0 && (
                            <span className="tabular-nums text-slate-600">
                              目标价 {pre.targetPriceRange.min}–
                              {pre.targetPriceRange.max} 元
                            </span>
                          )}
                      </div>
                    </div>

                    {pre.bullCase && pre.bullCase.length > 0 && (
                      <div className="mb-2.5 rounded-lg border border-emerald-100 bg-emerald-50/50 p-2.5">
                        <div className="mb-1.5 text-[12px] font-semibold text-emerald-700">
                          主流看好
                        </div>
                        <PointList items={pre.bullCase} tone="bull" />
                      </div>
                    )}

                    {pre.bearCase && pre.bearCase.length > 0 && (
                      <div className="rounded-lg border border-rose-100 bg-rose-50/50 p-2.5">
                        <div className="mb-1.5 text-[12px] font-semibold text-rose-700">
                          分歧与风险
                        </div>
                        <PointList items={pre.bearCase} tone="bear" />
                      </div>
                    )}
                  </section>
                )}

              {biz?.groups && biz?.groups.length > 0 && (
                <section>
                  <div className="mb-1.5 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-900">
                      营收构成
                    </h3>
                    {biz?.groups[compTab]?.date && (
                      <span className="text-[11px] text-slate-400">
                        {biz?.groups[compTab].date} 口径
                      </span>
                    )}
                  </div>
                  <div className="mb-2 flex flex-wrap gap-1">
                    {biz?.groups.map((g, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setCompTab(i)}
                        className={
                          compTab === i
                            ? 'rounded px-2 py-0.5 text-[11px] font-medium bg-brand-50 text-brand-700'
                            : 'rounded px-2 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100'
                        }
                      >
                        {g.label}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    {biz?.groups[compTab]?.items.map((s, i) => {
                      const w = Math.max(
                        0,
                        Math.min(100, (s.incomeRatio ?? 0) * 100),
                      );
                      return (
                        <div key={i}>
                          <div className="flex items-baseline justify-between gap-2 text-[12px] leading-5">
                            <span className="truncate text-slate-700">
                              {s.name}
                            </span>
                            <span className="shrink-0 tabular-nums text-slate-500">
                              {s.incomeRatio != null
                                ? `${(s.incomeRatio * 100).toFixed(1)}%`
                                : '—'}
                              {s.grossMargin != null
                                ? ` · 毛利${(s.grossMargin * 100).toFixed(0)}%`
                                : ''}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-slate-100">
                            <div
                              className="h-1.5 rounded bg-brand-500"
                              style={{ width: `${w}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {report.profile && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    公司资料
                  </h3>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
                    <div className="flex justify-between gap-3 border-b border-slate-100 py-1.5">
                      <span className="text-slate-500">控股股东</span>
                      <span className="text-right text-slate-800">
                        {report.profile.holder ?? '—'}
                        {report.profile.holderRatio != null &&
                          `（${report.profile.holderRatio.toFixed(1)}%）`}
                      </span>
                    </div>
                    <div className="flex justify-between gap-3 border-b border-slate-100 py-1.5">
                      <span className="text-slate-500">实际控制人</span>
                      <span className="text-right text-slate-800">
                        {report.profile.controller ?? '—'}
                      </span>
                    </div>
                    <div className="flex justify-between gap-3 border-b border-slate-100 py-1.5 sm:col-span-2">
                      <span className="text-slate-500">所属行业</span>
                      <span className="text-right text-slate-800">
                        {report.profile.industryPath ||
                          report.profile.industry ||
                          '—'}
                      </span>
                    </div>
                  </div>
                </section>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                <p className="text-[11px] leading-4 text-slate-400">
                  数据来源：通达信 F10 深度资料 + 券商研报（评级/目标价/风险提示）+
                  东方财富 F10 主营构成。内容为基于公开资料的研究整理，不构成投资建议。
                </p>
                <button
                  type="button"
                  onClick={askYuanbao}
                  className="btn-primary shrink-0"
                >
                  用元宝深度追问
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
