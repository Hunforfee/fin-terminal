'use client';

import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';

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
  profile: ReportProfile | null;
  business: ReportBusiness | null;
  reports: ReportItem[];
  searchOk: boolean;
  generatedAt: string;
}

function fmtYi(n: number | null): string {
  if (n == null) return '—';
  return `${(n / 1e8).toFixed(2)} 亿`;
}
function pct(x: number | null): string {
  if (x == null) return '—';
  return `${(x * 100).toFixed(1)}%`;
}
function ratingClass(r: string | null): string {
  if (!r) return 'bg-slate-100 text-slate-600';
  if (/买入|推荐|强烈/.test(r)) return 'bg-emerald-100 text-emerald-700';
  if (/增持|谨慎/.test(r)) return 'bg-sky-100 text-sky-700';
  if (/中性|持有|观望/.test(r)) return 'bg-slate-100 text-slate-600';
  if (/减持|卖出|回避/.test(r)) return 'bg-rose-100 text-rose-700';
  return 'bg-slate-100 text-slate-600';
}

/** 将经营评述的长文本按（一）（二）… 拆分为带小标题的段落，便于阅读 */
function splitReview(text: string): { head: string; body: string }[] {
  return text
    .split(/(?=（[一二三四五六七八九十]+）)/)
    .map((p) => {
      const m = p.match(/^（([一二三四五六七八九十]+)）\s*([\s\S]*)$/);
      if (m) return { head: `（${m[1]}）`, body: m[2].trim() };
      return { head: '', body: p.trim() };
    })
    .filter((x) => x.body.length > 0);
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
  const summaryText = biz?.summary ?? '';
  const shownSummary =
    expanded || summaryText.length <= 240
      ? summaryText
      : `${summaryText.slice(0, 240)}…`;

  const reviewSections = biz?.review ? splitReview(biz.review) : [];
  const hasBiz =
    biz && (biz.summary || biz.review || (biz.groups && biz.groups.length > 0));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="查看 AI 聚合分析：主营业务、研报观点、公司资料"
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
              {hasBiz && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    主营业务
                  </h3>

                  {biz!.industry && (
                    <div className="mb-2">
                      <span className="inline-flex items-center rounded-md bg-brand-50 px-2 py-0.5 text-[12px] font-medium text-brand-700">
                        所属行业：{biz!.industry}
                      </span>
                    </div>
                  )}

                  {biz!.summary && (
                    <p className="whitespace-pre-line text-[13px] leading-6 text-slate-700">
                      {shownSummary}
                      {summaryText.length > 240 && (
                        <button
                          type="button"
                          onClick={() => setExpanded((v) => !v)}
                          className="ml-1 align-baseline text-brand-600 hover:underline"
                        >
                          {expanded ? '收起' : '展开全文'}
                        </button>
                      )}
                    </p>
                  )}

                  {biz!.review && (
                    <div className="mt-3">
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[12px] font-medium text-slate-600">
                          经营评述
                          {biz!.reviewDate && (
                            <span className="ml-1 text-slate-400">
                              （{biz!.reviewDate}）
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => setReviewExpanded((v) => !v)}
                          className="text-[12px] text-brand-600 hover:underline"
                        >
                          {reviewExpanded ? '收起' : '展开全文'}
                        </button>
                      </div>
                      <div
                        className={
                          reviewExpanded
                            ? 'space-y-2.5'
                            : 'max-h-72 space-y-2.5 overflow-y-auto pr-1'
                        }
                      >
                        {reviewSections.map((s, i) => (
                          <p
                            key={i}
                            className="text-[13px] leading-6 text-slate-700"
                          >
                            {s.head && (
                              <span className="font-semibold text-slate-900">
                                {s.head}
                              </span>
                            )}
                            {s.body}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {biz!.groups?.map((g, gi) => {
                    const showMargin = g.items.some(
                      (s) => s.grossMargin != null,
                    );
                    return (
                      <div
                        key={gi}
                        className="mt-3 overflow-hidden rounded-lg border border-slate-200"
                      >
                        <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-[12px] font-medium text-slate-600">
                          <span>主营构成 · {g.label}</span>
                          {g.date && (
                            <span className="text-slate-400">{g.date}</span>
                          )}
                        </div>
                        <table className="w-full text-[13px]">
                          <thead>
                            <tr className="text-left text-xs text-slate-500">
                              <th className="px-3 py-2 font-medium">项目</th>
                              <th className="px-3 py-2 text-right font-medium">
                                营收
                              </th>
                              <th className="px-3 py-2 text-right font-medium">
                                收入占比
                              </th>
                              {showMargin && (
                                <th className="px-3 py-2 text-right font-medium">
                                  毛利率
                                </th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {g.items.map((s, i) => (
                              <tr
                                key={i}
                                className="border-t border-slate-100 text-slate-700"
                              >
                                <td className="px-3 py-2">{s.name}</td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {fmtYi(s.income)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {pct(s.incomeRatio)}
                                </td>
                                {showMargin && (
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {pct(s.grossMargin)}
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </section>
              )}

              <section>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">
                  研报主要观点
                </h3>
                {report.reports.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-[13px] text-slate-500">
                    暂未检索到公开研报，可点击右下角「用元宝深度追问」获取 AI 解读。
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {report.reports.map((r, i) => (
                      <li
                        key={i}
                        className="rounded-lg border border-slate-200 p-3"
                      >
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[13px] font-medium leading-5 text-brand-700 hover:underline"
                        >
                          {r.title}
                        </a>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                          {r.orgName && (
                            <span className="font-medium text-slate-700">
                              {r.orgName}
                            </span>
                          )}
                          {r.date && <span>· {r.date}</span>}
                          {r.rating && (
                            <span
                              className={`rounded px-1.5 py-0.5 font-medium ${ratingClass(
                                r.rating,
                              )}`}
                            >
                              {r.rating}
                            </span>
                          )}
                          {r.targetPrice != null && (
                            <span className="text-slate-600">
                              目标价 {r.targetPrice.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

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
                  数据来源：东方财富 F10 公开资料（公司概况 / 经营分析 / 主营构成）+ 研报聚合。本面板仅供研究参考，不构成投资建议。
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
