'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Modal from './Modal';
import type { PreAnalysis, ViewPoint } from '@/data/analyses';

/** 预生成深度解析的数据结构（由 /api/analysis 下发，避免打进客户端包） */

const YUANBAO_URL = 'https://yuanbao.tencent.com/';

/** 板块导航定义：id 对应各 section 的 DOM id，label 为导航文字 */
const SECTIONS = [
  { id: 'sec-business', label: '业务与模式' },
  { id: 'sec-revenue', label: '营收构成' },
  { id: 'sec-moat', label: '护城河' },
  { id: 'sec-competitors', label: '竞争对手对比' },
  { id: 'sec-views', label: '市场观点' },
  { id: 'sec-profile', label: '公司资料' },
] as const;

/** A 股 / 港股代码 → 站内股票页链接；境外上市代码（.KS/.T 等）返回 null */
function stockHref(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{6}$/.test(s)) return `/stock/${s}`;
  const hk = s.match(/^(?:hk)?(\d{1,5})(?:\.hk)?$/i);
  if (hk) return `/stock/${hk[1].padStart(5, '0')}`;
  return null;
}

/** 竞争对手代码徽章：可跳转的渲染为链接，境外代码保持纯文本 */
function CodeBadges({ code }: { code: string }) {
  return (
    <>
      {code
        .split(/\s*\/\s*/)
        .filter(Boolean)
        .map((p, i) => {
          const href = stockHref(p);
          return href ? (
            <Link
              key={i}
              href={href}
              title={`查看 ${p} 行情页`}
              className="rounded bg-brand-50 px-1 py-px text-[10px] tabular-nums text-brand-700 hover:bg-brand-100 hover:underline"
            >
              {p}
            </Link>
          ) : (
            <span
              key={i}
              title="境外上市，暂不支持站内跳转"
              className="rounded bg-slate-100 px-1 py-px text-[10px] tabular-nums text-slate-500"
            >
              {p}
            </span>
          );
        })}
    </>
  );
}

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
export interface CompanyAnalysisReport {
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
  embedded = false,
  variant = 'button',
  autoOpen = false,
  onClosed,
  onReady,
}: {
  name: string;
  code: string;
  market?: string;
  /** Reuse the same analysis in the daily-company reader without a nested modal. */
  embedded?: boolean;
  /** 紧凑形态：'none' 表示不渲染触发按钮，由外层自带图标直接挂载本面板 */
  variant?: 'button' | 'none';
  /** 列表按需挂载用：挂载即展开弹窗 */
  autoOpen?: boolean;
  onReady?: (report: CompanyAnalysisReport | null) => void;
  /** 弹窗关闭后的回调（供 variant='none' 的外层把挂载点切回图标） */
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  /** 列表场景按需挂载：挂载即打开 */
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<CompanyAnalysisReport | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** 当前高亮的导航板块（跟随滚动位置） */
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nonce = useRef(0);

  useEffect(() => {
    if (!open && !embedded) return;
    const id = ++nonce.current;
    const controller = new AbortController();
    setLoading(true);
    setErr(null);
    setReport(null);
    fetch(
      `/api/analysis?code=${encodeURIComponent(code)}&name=${encodeURIComponent(
        name,
      )}&market=${market}`,
      { signal: controller.signal },
    )
      .then((r) => r.json())
      .then((d) => {
        if (controller.signal.aborted || id !== nonce.current) return;
        if (d?.error) setErr(d.error);
        else setReport(d);
        setLoading(false);
      })
      .catch((e) => {
        if (controller.signal.aborted || id !== nonce.current) return;
        setErr(String(e));
        setLoading(false);
      });
    return () => { controller.abort(); nonce.current++; };
  }, [open, embedded, code, name, market, attempt]);

  useEffect(() => {
    onReady?.(report);
    return () => onReady?.(null);
  }, [report, onReady]);

  const askYuanbao = async () => {
    const analysisName = report?.name || name;
    const text = `【${analysisName}（${code}）】\n\n${DEFAULT_PROMPT.replaceAll(
      '{name}',
      analysisName,
    ).replaceAll('{code}', code)}`;
    await copyText(text);
    window.open(YUANBAO_URL, '_blank', 'noopener,noreferrer');
  };

  /** 点击导航：平滑滚动到对应板块并立即高亮 */
  const jumpLock = useRef(0);
  const jumpTo = (id: string) => {
    // 平滑滚动期间锁定高亮，避免动画中途的中间态覆盖点击项
    jumpLock.current = Date.now() + 900;
    bodyRef.current
      ?.querySelector<HTMLElement>(`#${id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(id);
  };

  // 滚动高亮：监听弹窗内容滚动容器（Modal 内容区），同步当前板块
  useEffect(() => {
    const body = bodyRef.current;
    if ((!open && !embedded) || !body) return;
    let container: HTMLElement | null = body.parentElement;
    while (container) {
      const oy = getComputedStyle(container).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      container = container.parentElement;
    }
    if (!container) return;
    const onScroll = () => {
      if (Date.now() < jumpLock.current) return;
      // 以「在可视区域中占比最大」的板块为当前项，
      // 避免贴顶板块（底部空间不足滚不到顶）被误判为上一个板块
      const rect = container!.getBoundingClientRect();
      let best: string = SECTIONS[0].id;
      let bestVis = -1;
      for (const s of SECTIONS) {
        const el = body.querySelector<HTMLElement>(`#${s.id}`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const vis = Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top);
        if (vis > bestVis) {
          bestVis = vis;
          best = s.id;
        }
      }
      setActive(best);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => container.removeEventListener('scroll', onScroll);
  }, [open, embedded, report]);

  const biz = report?.business;
  const pre = report?.pre ?? null;
  const hasBiz =
    biz && (biz.summary || biz.review || (biz.groups && biz.groups.length > 0));
  /** 有预生成深度解析时，即使实时 F10 抓取失败也要展示 */
  const hasContent = hasBiz || !!pre;

  /** 仅展示实际渲染出来的板块导航 */
  const navItems = SECTIONS.filter((s) => {
    if (s.id === 'sec-business') return !!hasContent;
    if (s.id === 'sec-moat') return !!pre?.moat?.length;
    if (s.id === 'sec-competitors') return !!pre?.competitors?.length || pre?.researchStatus === 'draft';
    if (s.id === 'sec-views')
      return !!(
        (pre?.bullCase && pre.bullCase.length > 0) ||
        (pre?.bearCase && pre.bearCase.length > 0)
      );
    if (s.id === 'sec-revenue')
      return !!(biz?.groups?.length || pre?.businessSnapshot);
    return !!report?.profile;
  });

  const navigation = (
    navItems.length > 1 ? (
            <nav
              aria-label="分析板块导航"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-2"
            >
              {navItems.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => jumpTo(s.id)}
                  aria-current={active === s.id ? 'true' : undefined}
                  className={`border-b-2 pb-0.5 text-[12px] transition-colors ${
                    active === s.id
                      ? 'border-brand-600 font-medium text-brand-700'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </nav>
          ) : undefined
  );
  const body = (
    <div className="space-y-5" ref={bodyRef}>
          {loading && (
            <div className="flex items-center gap-3 py-10 text-sm text-slate-500">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600" />
              正在聚合公开资料与研报观点…
            </div>
          )}

          {err && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              分析生成失败：{err}
              <button type="button" onClick={() => setAttempt(value => value + 1)} className="ml-3 underline">重试</button>
            </div>
          )}

          {report && (
            <>
              {hasContent && (
                <section id="sec-business" className="scroll-mt-2">
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      业务与模式
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

                  <div className="space-y-2.5 whitespace-pre-line text-[13px] leading-[1.75] text-slate-700">
                    {pre?.summary || biz?.summary || '暂无数据'}
                  </div>
                </section>
              )}

              {pre?.businessSnapshot && !biz?.groups?.length && (
                <section id="sec-revenue" className="scroll-mt-2">
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">营收构成</h3>
                  <p className="text-[12px] leading-5 text-slate-500">未取得可用收入分项，不据此填零或估算占比。</p>
                  <p className="mt-1 text-[11px] text-slate-400">{pre.businessSnapshot.source}</p>
                </section>
              )}
              {biz?.groups && biz?.groups.length > 0 && (
                <section id="sec-revenue" className="scroll-mt-2">
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    营收构成
                  </h3>
                  <div
                    className={
                      biz.groups.length >= 3
                        ? 'grid gap-2.5 md:grid-cols-3'
                        : biz.groups.length === 2
                          ? 'grid gap-2.5 sm:grid-cols-2'
                          : ''
                    }
                  >
                    {biz.groups.map((g, gi) => (
                      <div
                        key={gi}
                        className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5"
                      >
                        <div className="mb-2 flex items-center justify-between gap-1">
                          <span className="text-[12px] font-semibold text-slate-800">
                            {g.label}
                          </span>
                          {g.date && (
                            <span className="shrink-0 text-[10px] text-slate-400">
                              {g.date}
                            </span>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          {g.items.map((s, i) => {
                            const w = Math.max(
                              0,
                              Math.min(100, (s.incomeRatio ?? 0) * 100),
                            );
                            return (
                              <div key={i}>
                                <div className="flex items-baseline justify-between gap-1.5 text-[11px] leading-4">
                                  <span className="truncate text-slate-600">
                                    {s.name}
                                  </span>
                                  <span className="shrink-0 tabular-nums text-slate-500">
                                    {s.incomeRatio != null
                                      ? `${(s.incomeRatio * 100).toFixed(1)}%`
                                      : '—'}
                                    {s.grossMargin != null && (
                                      <span className="text-slate-400">
                                        {' '}
                                        毛
                                        {(s.grossMargin * 100).toFixed(0)}%
                                      </span>
                                    )}
                                  </span>
                                </div>
                                <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-slate-200/70">
                                  <div
                                    className="h-1 rounded bg-brand-500"
                                    style={{ width: `${w}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {pre?.moat && pre.moat.length > 0 && (
                <section id="sec-moat" className="scroll-mt-2">
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    护城河
                  </h3>
                  <PointList items={pre.moat} tone="brand" />
                </section>
              )}

              {pre?.researchStatus === 'draft' && !pre.competitors?.length && (
                <section id="sec-competitors" className="scroll-mt-2">
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">竞争对手对比</h3>
                  <p className="text-[12px] leading-5 text-slate-500">尚未确认足够可比的公司，需按具体产品、客户与地区补充。</p>
                </section>
              )}
              {pre?.competitors && pre.competitors.length > 0 && (
                <section id="sec-competitors" className="scroll-mt-2">
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    竞争对手对比
                  </h3>
                  <ul className="divide-y divide-slate-100">
                    {pre.competitors.map((c, i) => (
                      <li key={i} className="py-2 first:pt-0 last:pb-0">
                        <div className="mb-0.5 flex flex-wrap items-baseline gap-1.5">
                          <span className="text-[12.5px] font-medium text-slate-900">
                            {c.name}
                          </span>
                          {c.code && <CodeBadges code={c.code} />}
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
                  <section id="sec-views" className="scroll-mt-2">
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
                          {pre.viewBasis === 'research_hypotheses' ? '正向情景 · 待验证' : '主流看好'}
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

              {report.profile && (
                <section id="sec-profile" className="scroll-mt-2">
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

              {pre?.sources?.length ? <section aria-label="解析来源与复核" className="border-t border-slate-100 pt-3 text-xs">
                <div className="flex flex-wrap gap-x-4 gap-y-2">{pre.sources.map(item => <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">{item.label}</a>)}</div>
                {pre.verificationTasks?.length ? <details className="mt-3 text-slate-500"><summary className="cursor-pointer">待核对 {pre.verificationTasks.length} 项</summary><ul className="mt-2 list-disc space-y-1 pl-4">{pre.verificationTasks.map(task => <li key={task} className="leading-5">{task}</li>)}</ul></details> : null}
              </section> : null}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
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
  );

  if (embedded) return (
    <div className="min-w-0 px-4 pb-5 sm:px-6 [&_section]:scroll-mt-24">
      {navigation && <div className="sticky top-0 z-10 -mx-4 mb-4 border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">{navigation}</div>}
      {body}
    </div>
  );

  return (
    <>
      {variant === 'none' ? null : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="查看深度解析：业务与模式、护城河、竞争对手、市场多空观点、营收构成"
          className="btn border-brand-200 text-brand-700 hover:border-brand-300 hover:bg-brand-50"
        >
          深度解析
        </button>
      )}

      <Modal
        open={open}
        title={`${name} · 深度解析`}
        onClose={() => {
          setOpen(false);
          setReport(null);
          setActive(SECTIONS[0].id);
          onClosed?.();
        }}
        size="lg"
        maximizable
        nav={navigation}
      >
        {body}
      </Modal>
    </>
  );
}
