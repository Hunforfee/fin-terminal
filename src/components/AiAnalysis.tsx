'use client';

/**
 * AI 深度分析面板（个股页）：
 *   - 可编辑提示词（localStorage 保存），默认模板
 *   - 点击「开始分析」调用 /api/ai-analyze（OpenAI 兼容接口，Key 可在面板设置里填，存浏览器本地）
 *   - 每次生成保存为一个版本，可点击历史版本查看；「更新」= 用当前提示词再生成一版并置顶
 */

import { useEffect, useRef, useState } from 'react';

interface Version {
  ts: number;
  prompt: string;
  content: string;
  model?: string;
  sources?: number;
}

const LS_PROMPT = 'fin.ai.prompt';
const LS_KEY = 'fin.ai.key';
const LS_URL = 'fin.ai.url';
const LS_MODEL = 'fin.ai.model';
const histKey = (code: string) => `fin.ai.history.${code}`;

const DEFAULT_PROMPT =
  '深入分析该股票，包括但不限于公司的业务结构、核心竞争力、行业格局与竞争地位、财务质量（收入/利润/现金流/资产负债）、主要风险，并推测未来 1-3 年的利润区间及关键驱动因素。要求使用最新数据，反复核对数据，确保信息来源真实可靠；引用数据注明来源与日期，无法核实的明确标注。';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 极简 Markdown 渲染：标题/加粗/列表/段落，避免引入额外依赖 */
function renderMd(md: string): string {
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc.split('\n');
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const inline = (s: string) =>
      s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(
          /`([^`]+)`/g,
          '<code class="rounded bg-slate-100 px-1 py-0.5 text-[11px]">$1</code>'
        );
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push('<ul class="ml-4 list-disc space-y-1">');
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (h) {
      const lvl = Math.min(h[1].length + 2, 5);
      out.push(`<h${lvl} class="mt-4 mb-1 font-semibold text-slate-800">${inline(h[2])}</h${lvl}>`);
    } else if (line.trim() === '') {
      out.push('<div class="h-2"></div>');
    } else {
      out.push(`<p class="leading-relaxed">${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

export default function AiAnalysis({ code, name }: { code: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [active, setActive] = useState(0); // 当前查看的版本下标
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiModel, setApiModel] = useState('');
  const booted = useRef(false);

  useEffect(() => {
    setPrompt(localStorage.getItem(LS_PROMPT) || DEFAULT_PROMPT);
    setVersions(loadJson<Version[]>(histKey(code), []));
    setApiKey(localStorage.getItem(LS_KEY) || '');
    setApiUrl(localStorage.getItem(LS_URL) || '');
    setApiModel(localStorage.getItem(LS_MODEL) || '');
    booted.current = true;
  }, [code]);

  useEffect(() => {
    if (!booted.current) return;
    try {
      localStorage.setItem(LS_PROMPT, prompt);
    } catch {
      /* ignore */
    }
  }, [prompt]);

  useEffect(() => {
    if (!booted.current) return;
    try {
      localStorage.setItem(histKey(code), JSON.stringify(versions.slice(0, 30)));
    } catch {
      /* ignore */
    }
  }, [versions, code]);

  const run = async () => {
    if (loading) return;
    setOpen(true);
    setLoading(true);
    setErr(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['x-ai-key'] = apiKey;
      if (apiUrl) headers['x-ai-url'] = apiUrl;
      if (apiModel) headers['x-ai-model'] = apiModel;
      const r = await fetch('/api/ai-analyze', {
        method: 'POST',
        headers,
        body: JSON.stringify({ code, name, prompt }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `请求失败（${r.status}）`);
      const v: Version = { ts: Date.now(), prompt, content: j.data.content, model: j.data.model, sources: j.data.sources };
      setVersions((vs) => [v, ...vs].slice(0, 30));
      setActive(0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const cur = versions[active];
  const fillPrompt = () => {
    setPrompt(
      `深入分析${name}（${code}），` +
        DEFAULT_PROMPT.replace('深入分析该股票，包括但不限于', '包括但不限于')
    );
    setEditingPrompt(false);
  };

  return (
    <section className="card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-700">AI 深入分析</h2>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setPromptOpen((v) => !v)}
            aria-expanded={promptOpen}
            aria-controls="ai-prompt"
            className="btn !min-h-8 !px-2.5 !py-1 !text-xs"
          >
            提示词
          </button>
          {versions.length > 0 && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="btn !min-h-8 !px-2.5 !py-1 !text-xs"
            >
              查看历史（{versions.length}）
            </button>
          )}
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            className="btn !min-h-8 !px-2.5 !py-1 !text-xs"
            title="配置 AI 接口（OpenAI 兼容）"
          >
            设置
          </button>
          <button
            onClick={
              versions.length
                ? run
                : () => {
                    setOpen(true);
                    run();
                  }
            }
            disabled={loading}
            className={`min-h-8 rounded-lg px-3 py-1 text-xs font-medium transition ${
              loading ? 'bg-slate-200 text-slate-400' : 'bg-brand-600 text-white hover:bg-brand-700'
            }`}
          >
            {loading ? 'AI 分析中…' : versions.length ? '更新' : '开始 AI 分析'}
          </button>
        </div>
      </div>

      {promptOpen && (
        <div id="ai-prompt" className="mt-3">
          {editingPrompt ? (
            <div className="space-y-1.5">
              <textarea
                aria-label="AI 分析提示词"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className="input w-full font-mono text-xs leading-relaxed"
                placeholder="输入希望 AI 执行的分析指令…"
              />
              <div className="flex items-center gap-2 text-[11px]">
                <button
                  onClick={() => {
                    setEditingPrompt(false);
                  }}
                  className="rounded bg-brand-600 px-2 py-0.5 text-white"
                >
                  完成
                </button>
                <button
                  onClick={() => setPrompt(DEFAULT_PROMPT)}
                  className="text-slate-500 hover:text-slate-700"
                >
                  恢复默认
                </button>
                <span className="text-slate-400">{prompt.length} 字</span>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <p className="flex-1 rounded bg-slate-50 px-2.5 py-1.5 text-xs leading-relaxed text-slate-500">
                {prompt}
              </p>
              <button
                onClick={() => setEditingPrompt(true)}
                className="shrink-0 text-[11px] text-brand-600 hover:underline"
              >
                编辑
              </button>
            </div>
          )}
        </div>
      )}

      {/* 设置 */}
      {settingsOpen && (
        <div className="mt-2 space-y-1.5 rounded border border-slate-200 bg-slate-50 px-3 py-2">
          <input
            aria-label="AI API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onBlur={() => {
              try {
                localStorage.setItem(LS_KEY, apiKey);
              } catch {}
            }}
            placeholder="API Key（sk-…）"
            className="input w-full py-1 text-xs"
            type="password"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              aria-label="AI 接口地址"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              onBlur={() => {
                try {
                  localStorage.setItem(LS_URL, apiUrl);
                } catch {}
              }}
              placeholder="接口地址（默认 DeepSeek）"
              className="input min-w-0 flex-1 py-1 text-xs"
            />
            <input
              aria-label="AI 模型"
              value={apiModel}
              onChange={(e) => setApiModel(e.target.value)}
              onBlur={() => {
                try {
                  localStorage.setItem(LS_MODEL, apiModel);
                } catch {}
              }}
              placeholder="模型（默认 deepseek-chat）"
              className="input !w-full py-1 text-xs sm:!w-40"
            />
          </div>
        </div>
      )}

      {err && <p className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-600">{err}</p>}
      {loading && (
        <p className="mt-2 animate-pulse text-xs text-slate-400">
          正在联网检索最新资料并生成分析（先搜索、后分析），通常需要 30 秒到 2 分钟…
        </p>
      )}

      {/* 历史版本 */}
      {open && versions.length > 0 && (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <div className="flex max-h-40 shrink-0 gap-1 overflow-auto border-b border-slate-100 pb-2 sm:block sm:max-h-[520px] sm:w-48 sm:space-y-1 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-2">
            {versions.map((v, i) => (
              <button
                key={v.ts}
                onClick={() => setActive(i)}
                className={`block w-full shrink-0 whitespace-nowrap rounded px-2 py-2 text-left text-[11px] sm:whitespace-normal ${
                  i === active
                    ? 'bg-brand-50 font-medium text-brand-700'
                    : 'text-slate-500 hover:bg-slate-50'
                }`}
              >
                {i === 0 ? '最新 · ' : ''}v{versions.length - i} · {fmtTs(v.ts)}
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            {cur && (
              <>
                <p className="mb-1 text-[10px] text-slate-400">
                  {cur.model ? `${cur.model} · ` : ''}{cur.sources !== undefined ? `联网检索 ${cur.sources} 条 · ` : ''}生成于 {fmtTs(cur.ts)} · 提示词{' '}
                  {cur.prompt.length} 字
                </p>
                <div
                  className="max-h-[520px] overflow-y-auto pr-1 text-xs text-slate-700"
                  dangerouslySetInnerHTML={{ __html: renderMd(cur.content) }}
                />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
