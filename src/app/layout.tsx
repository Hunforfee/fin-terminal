import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import SearchBox from '@/components/SearchBox';
import { WatchlistProvider } from '@/components/WatchlistProvider';

export const metadata: Metadata = {
  title: 'FinTerminal · 金融数据终端',
  description: '股票 / 指数 / 基金的行情、估值、财务与条件选股分析平台',
};

const NAV = [
  { href: '/', label: '首页' },
  { href: '/industry', label: '行业' },
  { href: '/screener', label: '条件选股' },
  { href: '/watchlist', label: '自选' },
  { href: '/fund', label: '基金' },
  { href: '/health', label: '数据源' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <WatchlistProvider>
          <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
            <div className="flex items-center gap-4 px-3 py-2.5 md:gap-6 md:px-5">
              <Link href="/" className="flex shrink-0 items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded bg-brand-600 text-sm font-bold text-white">
                  F
                </span>
                <span className="text-base font-semibold text-slate-900">FinTerminal</span>
              </Link>

              <nav className="hidden shrink-0 items-center gap-1 md:flex">
                {NAV.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="rounded px-2.5 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>

              <div className="ml-auto w-full max-w-md">
                <SearchBox />
              </div>
            </div>

            {/* 移动端导航 */}
            <div className="flex gap-1 overflow-x-auto border-t border-slate-100 px-3 py-1.5 md:hidden">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="whitespace-nowrap px-2 py-1 text-xs text-slate-600">
                  {n.label}
                </Link>
              ))}
            </div>
          </header>

          <main className="px-3 py-4 md:px-5 md:py-5">{children}</main>

          <footer className="px-3 py-8 text-xs leading-relaxed text-slate-400 md:px-5">
            <p>
              数据来源于公开行情接口（腾讯财经 / 新浪财经 / 东方财富），仅供参考，不构成任何投资建议。
            </p>
            <p className="mt-1">
              个股估值使用已披露财报、真实股本与前复权价格计算；具体数据覆盖、口径及缺失情况见估值分析说明。
            </p>
          </footer>
        </WatchlistProvider>
      </body>
    </html>
  );
}

