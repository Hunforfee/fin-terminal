"use client";

import { useEffect, useId, useRef, useState } from "react";
import AiAnalysis from "@/components/AiAnalysis";

export default function AiAnalysisDialog({
  code,
  name,
}: {
  code: string;
  name: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const [visited, setVisited] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!opened) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [opened]);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        className="chip gap-1.5 border border-brand-200 bg-brand-50 text-brand-700 hover:border-brand-400 hover:bg-brand-100"
        onClick={() => {
          setVisited(true);
          dialog.current?.showModal();
          setOpened(true);
        }}
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
        </svg>
        AI 分析
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="m-auto max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-6xl overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-900/35"
        onClose={() => setOpened(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              dialog.current?.close();
          }
        }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-4 py-3 sm:px-5">
          <h2 id={titleId} className="min-w-0 text-base font-semibold">
            {name}{" "}
            <span className="ml-2 text-sm font-normal text-slate-500">
              AI 分析
            </span>
          </h2>
          <button
            type="button"
            aria-label="关闭 AI 分析"
            autoFocus
            onClick={() => dialog.current?.close()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xl text-slate-500 hover:bg-slate-100"
          >
            ×
          </button>
        </div>
        <div className="p-3 sm:p-5">
          {visited && <AiAnalysis code={code} name={name} />}
        </div>
      </dialog>
    </>
  );
}
