'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Modal from './Modal';
import { personalStorage } from '@/lib/personalStorage';

/**
 * AI 分析（腾讯元宝版）：
 * - 点击「AI 分析」：把「预设提示词 + 该股票的关键行情信息」拼成完整提问，
 *   复制到剪贴板，然后新标签打开腾讯元宝 —— 用户用自己的元宝账户登录，
 *   粘贴发送即可。本站不接触任何元宝账号信息。
 * - 「预设提示词」：标题栏旁的齿轮可编辑模板（localStorage 保存），
 *   模板里可用占位符 {name} {code}，发送时替换为实际股票。
 *
 * 为什么走剪贴板而不是 URL 参数：元宝不支持用 URL 预填对话内容，
 * 剪贴板是最可靠的过渡方式 —— 打开元宝后 Ctrl+V 一键发送。
 */

const LS_PROMPT = 'fin.yuanbao.prompt';
export const YUANBAO_URL = 'https://yuanbao.tencent.com/';

const DEFAULT_PROMPT =
  '请深入分析{name}（{code}），包括但不限于公司的业务结构、核心竞争力、行业格局与竞争地位、财务质量（收入/利润/现金流/资产负债）、主要风险，并推测未来 1-3 年的利润区间及关键驱动因素。要求使用最新数据，反复核对，确保信息来源真实可靠；引用数据注明来源与日期，无法核实的明确标注。';

interface QuoteLite {
  name: string;
  code: string;
  price: number | null;
  changePct: number | null;
}

function buildPrompt(template: string, q: QuoteLite): string {
  const stock = template
    .replaceAll('{name}', q.name)
    .replaceAll('{code}', q.code);
  const lines = [
    `【${q.name}（${q.code}）】`,
    `当前价格：${q.price != null ? q.price : '—'} 元，涨跌幅：${
      q.changePct != null ? `${q.changePct > 0 ? '+' : ''}${q.changePct}%` : '—'
    }`,
    '',
    stock,
  ];
  return lines.join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（http）或权限被拒：退回 execCommand
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

export default function YuanbaoAnalysis({ quote }: { quote: QuoteLite }) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_PROMPT);
  const [copied, setCopied] = useState(false);
  const editorId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const saved = personalStorage.getItem(LS_PROMPT);
    if (saved) setPrompt(saved);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const openYuanbao = async () => {
    const text = buildPrompt(prompt, quote);
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    }
    window.open(YUANBAO_URL, '_blank', 'noopener,noreferrer');
  };

  const savePrompt = () => {
    const next = draft.trim() || DEFAULT_PROMPT;
    setPrompt(next);
    personalStorage.setItem(LS_PROMPT, next);
    setEditorOpen(false);
  };

  return (
    <>
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={openYuanbao}
          title="用腾讯元宝 AI 分析（提示词自动复制，粘贴发送即可）"
          className="chip gap-1.5 rounded-r-none border-r-0 border-brand-200 bg-brand-50 text-brand-700 hover:border-brand-400 hover:bg-brand-100"
        >
          AI 分析
        </button>
        <button
          type="button"
          aria-label="预设提示词设置"
          title="预设提示词"
          onClick={() => {
            setDraft(prompt);
            setEditorOpen(true);
          }}
          className="chip rounded-l-none border-brand-200 bg-brand-50 px-1.5 text-brand-700 hover:border-brand-400 hover:bg-brand-100"
        >
          <svg
            aria-hidden="true"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </button>
        {copied && (
          <span
            role="status"
            className="absolute -top-8 left-0 z-10 whitespace-nowrap rounded-md bg-slate-800 px-2.5 py-1 text-xs text-white shadow-lg"
          >
            提示词已复制，到元宝 Ctrl+V 发送
          </span>
        )}
      </div>
      <Modal
        open={editorOpen}
        title="预设提示词"
        onClose={() => setEditorOpen(false)}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            点击「AI 分析」时会按此模板生成提问并自动复制，再打开腾讯元宝（用你自己的账户登录）。模板中可用{' '}
            <code className="rounded bg-slate-100 px-1">{'{name}'}</code>、{' '}
            <code className="rounded bg-slate-100 px-1">{'{code}'}</code>{' '}
            代表股票名称与代码；当前行情会自动附在开头。
          </p>
          <label htmlFor={editorId} className="sr-only">
            预设提示词
          </label>
          <textarea
            id={editorId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6 focus:border-brand-400 focus:outline-none"
            placeholder={DEFAULT_PROMPT}
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setDraft(DEFAULT_PROMPT)}
              className="min-h-9 rounded-lg px-3 text-sm text-slate-500 hover:bg-slate-100"
            >
              恢复默认
            </button>
            <button
              type="button"
              onClick={savePrompt}
              className="min-h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              保存
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
