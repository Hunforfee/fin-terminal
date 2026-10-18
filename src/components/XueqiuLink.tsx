'use client';

import { useId } from 'react';

/**
 * 雪球入口按钮。
 *
 * 点击直接在新标签页打开该股票的雪球页面（https://xueqiu.com/S/SH600519）。
 *
 * 图标默认彩色显示（品牌蓝渐变圆底 + 白色球面缝线），不依赖 hover；
 * hover 仅做轻微提亮，不改变「是否可见/是否有色」。
 */
export default function XueqiuLink({
  url,
  name,
}: {
  url: string;
  name: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`在新标签页打开${name}的雪球页面`}
      title="在雪球查看"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-opacity hover:opacity-85"
    >
      <XueqiuMark className="h-[18px] w-[18px]" />
    </a>
  );
}

/**
 * 雪球彩色字标：品牌蓝渐变圆底 + 白色球面缝线，形似一颗雪球。
 * 渐变 id 用 useId 生成并去掉冒号，保证同页多个实例互不冲突。
 */
export function XueqiuMark({ className = '' }: { className?: string }) {
  const rawId = useId();
  const gid = `xq-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      role="img"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f9bfa" />
          <stop offset="0.55" stopColor="#1f6feb" />
          <stop offset="1" stopColor="#144fc0" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10" fill={`url(#${gid})`} />
      {/* 球面高光与缝线：上弧 + 下弧 + 高光点，构成雪球的立体感 */}
      <path
        d="M6 9.6c3.8-2.4 8.2-2.4 12 0"
        stroke="#ffffff"
        strokeOpacity="0.95"
        strokeWidth="1.7"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 14.4c3.8 2.4 8.2 2.4 12 0"
        stroke="#ffffff"
        strokeOpacity="0.95"
        strokeWidth="1.7"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="12" cy="12" r="1.7" fill="#ffffff" />
      <path
        d="M4.6 8.2A8.4 8.4 0 0 1 8.4 4.5"
        stroke="#ffffff"
        strokeOpacity="0.5"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
