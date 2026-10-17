import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import SearchBox from '@/components/SearchBox';
import AppNav from '@/components/AppNav';
import { WatchlistProvider } from '@/components/WatchlistProvider';
export const metadata: Metadata = {
  title: 'FinTerminal · 金融数据终端',
  description: '股票 / 指数 / 基金的行情、估值、财务与条件选股分析平台',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <WatchlistProvider>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3"
          >
            跳到主要内容
          </a>
          <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/95 backdrop-blur-xl">
            <div className="mx-auto max-w-[1480px] px-4 sm:px-8">
              <div className="flex min-h-20 items-center justify-between gap-4">
                <Link
                  href="/"
                  className="flex shrink-0 items-center gap-2.5"
                  aria-label="FinTerminal 首页"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-900 text-lg font-semibold text-white">
                    F
                  </span>
                  <span className="hidden text-lg font-semibold tracking-tight sm:inline">
                    FinTerminal
                    <span className="ml-3 hidden text-xs font-normal text-slate-400 lg:inline">
                      金融数据终端
                    </span>
                  </span>
                </Link>
                <div className="w-full max-w-[420px]">
                  <SearchBox placeholder="搜索股票、指数或基金" />
                </div>
              </div>
              <AppNav />
            </div>
          </header>
          <main
            id="main-content"
            className="mx-auto min-h-[65vh] max-w-[1480px] px-4 py-6 sm:px-8 sm:py-8"
          >
            {children}
          </main>
        </WatchlistProvider>
      </body>
    </html>
  );
}
