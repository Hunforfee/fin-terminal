'use client';

import { useId } from 'react';

/**
 * 雪球入口按钮。
 *
 * 点击直接在新标签页打开该股票的雪球页面（https://xueqiu.com/S/SH600519）。
 *
 * 图标采用雪球官方视觉：品牌蓝圆角方底 + 白色风车状球面弧线，默认彩色显示，
 * 不依赖 hover；hover 仅轻微提亮。
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

/** 雪球官方风格字标：品牌蓝圆角方底 + 白色双弧（风车状球面线），useId 防渐变 id 冲突。 */
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
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b7bf3" />
          <stop offset="1" stopColor="#1a63d8" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="5.5" fill={`url(#${gid})`} />
      {/* 官方 logo 的两段风车弧：上弧沿圆周从右上扫到左侧再折向球心，下弧镜像 */}
      <path
        d="M14.6 5.2A7.6 7.6 0 0 0 5.4 9.6l4.4 3.1z"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.4 18.8a7.6 7.6 0 0 0 9.2-4.4l-4.4-3.1z"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
