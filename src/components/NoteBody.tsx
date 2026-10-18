'use client';

import { useMemo } from 'react';
import { renderNote } from '@/lib/noteMarkdown';

const STYLE = `
.ft-note { font-size: 14px; line-height: 1.75; color: #334155; overflow-wrap: anywhere; }
.ft-note > * + * { margin-top: 0.7em; }
.ft-note h3 { font-size: 1.05rem; font-weight: 600; color: #0f172a; margin-top: 1.1em; }
.ft-note h4 { font-size: 0.98rem; font-weight: 600; color: #0f172a; margin-top: 1em; }
.ft-note h5, .ft-note h6 { font-size: 0.92rem; font-weight: 600; color: #1e293b; margin-top: 0.9em; }
.ft-note p { margin: 0; }
.ft-note strong { color: #0f172a; font-weight: 600; }
.ft-note em { font-style: italic; }
.ft-note del { color: #94a3b8; }
.ft-note a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
.ft-note code { background: #f1f5f9; border-radius: 4px; padding: 0.1em 0.35em; font-size: 0.88em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #be123c; }
.ft-note pre { background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.ft-note pre code { background: transparent; color: inherit; padding: 0; font-size: 12.5px; line-height: 1.6; }
.ft-note ul, .ft-note ol { padding-left: 1.35em; }
.ft-note ul { list-style: disc; }
.ft-note ol { list-style: decimal; }
.ft-note li + li { margin-top: 0.2em; }
.ft-note li > ul, .ft-note li > ol { margin-top: 0.2em; }
.ft-note li label { display: inline-flex; align-items: center; gap: 0.35em; }
.ft-note blockquote { border-left: 3px solid #cbd5e1; padding: 0.15em 0 0.15em 0.8em; color: #64748b; background: #f8fafc; border-radius: 0 6px 6px 0; }
.ft-note hr { border: 0; border-top: 1px solid #e2e8f0; margin: 1em 0; }
.ft-note .md-table { overflow-x: auto; border: 1px solid #e2e8f0; border-radius: 8px; }
.ft-note table { border-collapse: collapse; width: 100%; font-size: 13px; }
.ft-note th { background: #f8fafc; font-weight: 600; color: #0f172a; white-space: nowrap; }
.ft-note th, .ft-note td { border-bottom: 1px solid #eef2f6; border-right: 1px solid #eef2f6; padding: 6px 10px; vertical-align: top; }
.ft-note th:last-child, .ft-note td:last-child { border-right: 0; }
.ft-note tbody tr:last-child td { border-bottom: 0; }
`;

export default function NoteBody({ text }: { text: string }) {
  const html = useMemo(() => renderNote(text), [text]);
  return (
    <>
      <style>{STYLE}</style>
      <div className="ft-note" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
