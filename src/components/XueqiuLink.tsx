'use client';

/**
 * 雪球入口按钮。
 *
 * 点击直接在新标签页打开该股票的雪球页面（https://xueqiu.com/S/SH600519）。
 *
 * 为什么不再用站内 iframe 弹窗：雪球对可疑来源会弹阿里云 WAF 滑块/405，
 * iframe 里经常停在验证页或空白，体验不可控；新标签打开能复用用户浏览器里
 * 已有的雪球登录态，也不会碰任何账号信息。
 *
 * 用 <a target="_blank"> 而不是 window.open：
 * - 浏览器原生支持中键/Ctrl+点击新标签，可访问性更好；
 * - 不会被弹窗拦截器当成脚本弹出而拦掉。
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
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-[#eaf3fe] hover:text-[#1f6feb] focus-visible:text-[#1f6feb] [@media(hover:none)]:text-[#1f6feb]"
    >
      <XueqiuMark className="h-4 w-4" />
    </a>
  );
}

/** 雪球字标：用官方蓝的描边圆环 + 白色「雪」字形，避免引入外部图片资源。 */
export function XueqiuMark({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9.2" />
      <path d="M8.4 9.3h7.2M9.1 12.4h5.8M12 7.4v9.2M9.3 16.6h5.4" />
    </svg>
  );
}
