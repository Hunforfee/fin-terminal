import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import SearchBox from '@/components/SearchBox';
import AppNav from '@/components/AppNav';
import { WatchlistProvider } from '@/components/WatchlistProvider';
import AccountProvider from '@/components/AccountProvider';
import AccountButton from '@/components/AccountButton';
import ResearchWorkspaceProvider from '@/components/ResearchWorkspaceProvider';
export const metadata: Metadata = {
  title: 'FinTerminal · 金融数据终端',
  description: '股票 / 指数 / 基金的行情、估值、财务与条件选股分析平台',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48', type: 'image/x-icon' },
      { url: '/brand-icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 身份由客户端 Cloud Auth 管理（会话存 localStorage），服务端不下发用户。
  const user = null;
  return (
    <html lang="zh-CN">
      <body>
        <AccountProvider initialUser={user}>
          <WatchlistProvider>
            <ResearchWorkspaceProvider>
              <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3"
              >
                跳到主要内容
              </a>
              <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/95 backdrop-blur-xl">
                <div className="w-full px-3 sm:px-4">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 xl:grid-cols-[auto_auto_minmax(0,1fr)_auto]">
                    <Link
                      href="/"
                      className="flex min-h-11 shrink-0 items-center gap-2.5"
                      aria-label="FinTerminal 首页"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src="/brand-icon.svg"
                        alt=""
                        width={28}
                        height={28}
                        className="h-7 w-7 shrink-0"
                      />
                      <span className="hidden text-lg font-semibold tracking-tight sm:inline">
                        FinTerminal
                      </span>
                    </Link>
                    <div className="col-span-3 col-start-1 row-start-2 min-w-0 xl:col-span-1 xl:col-start-2 xl:row-start-1">
                      <AppNav />
                    </div>
                    <div className="col-start-2 row-start-1 ml-auto w-full min-w-0 max-w-[420px] xl:col-start-3">
                      <SearchBox placeholder="搜索股票、指数或基金" />
                    </div>
                    <div className="col-start-3 row-start-1 xl:col-start-4">
                      <AccountButton />
                    </div>
                  </div>
                </div>
              </header>
              <main
                id="main-content"
                className="min-h-[65vh] w-full px-2.5 py-3 sm:px-3"
              >
                {children}
              </main>
            </ResearchWorkspaceProvider>
          </WatchlistProvider>
        </AccountProvider>
      </body>
    </html>
  );
}
