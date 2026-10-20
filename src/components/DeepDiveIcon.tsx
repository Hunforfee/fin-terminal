'use client';
import { useState } from 'react';
import AiAnalysisPanel from './AiAnalysisPanel';

/**
 * 股票列表里的「深度解析」角标：叠在股票名称左上角，点击展开深度解析。
 *
 * 列表动辄上百行，而 AiAnalysisPanel 展开后会挂载弹窗与图表 DOM，
 * 所以常驻时只渲染这个轻量按钮，点击后才挂载面板并自动展开。
 */
export default function DeepDiveIcon({
  name,
  code,
  market = 'A',
}: {
  name: string;
  code: string;
  market?: string;
}) {
  const [active, setActive] = useState(false);

  // 角标常驻 DOM：面板只是叠加挂载，关闭后即使回调未触发也不会把角标带走。
  return (
    <>
      {active && (
        <AiAnalysisPanel
          name={name}
          code={code}
          market={market}
          variant="none"
          autoOpen
          onClosed={() => setActive(false)}
        />
      )}
      <button
        type="button"
        onClick={() => setActive(true)}
        title={`${name} 深度解析`}
        aria-label={`${name} 深度解析`}
        className="inline-flex h-[14px] w-[14px] flex-none translate-y-[-4px] items-center justify-center rounded-[3px] border border-brand-300 bg-brand-50 text-brand-600 transition-colors hover:border-brand-500 hover:bg-brand-100 hover:text-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
      >
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.15"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-[10px] w-[10px]"
        >
          {/* 摊开的书：左右两页 + 中缝，喻「研读」 */}
          <path d="M6 3.1v6.6" />
          <path d="M6 3.1c-.7-.6-1.7-.9-3.1-.9H1.5v6.5h1.4c1.4 0 2.4.3 3.1.9" />
          <path d="M6 3.1c.7-.6 1.7-.9 3.1-.9h1.4v6.5H9.1c-1.4 0-2.4.3-3.1.9" />
        </svg>
      </button>
    </>
  );
}