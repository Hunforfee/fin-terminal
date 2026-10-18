import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import SearchBox from '@/components/SearchBox';
import AppNav from '@/components/AppNav';
import { WatchlistProvider } from '@/components/WatchlistProvider';
import AccountProvider from '@/components/AccountProvider';
import AccountButton from '@/components/AccountButton';
import { cookies } from 'next/headers';
import { readSession, SESSION_COOKIE } from '@/lib/auth/session';
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
  const cookieStore = await cookies();
  const user = readSession(cookieStore.get(SESSION_COOKIE)?.value);
  return (
    <html lang="zh-CN">
      <body>
        <AccountProvider initialUser={user}>
          <WatchlistProvider>
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3"
            >
              跳到主要内容
            </a>
            <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/95 backdrop-blur-xl">
              <div className="w-full px-3 sm:px-4">
                <div className="flex min-h-12 items-center justify-between gap-3">
                  <Link
                    href="/"
                    className="flex shrink-0 items-center gap-2.5"
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
                  <div className="hidden xl:block">
                    <AppNav />
                  </div>
                  <div className="ml-auto min-w-0 w-full max-w-[210px]">
                    <SearchBox placeholder="搜索股票、指数或基金" />
                  </div>
                  <AccountButton />
                </div>
                <div className="xl:hidden">
                  <AppNav />
                </div>
              </div>
            </header>
            <main
              id="main-content"
              className="min-h-[65vh] w-full px-3 py-3 sm:px-4 sm:py-4"
            >
              {children}
            </main>
          </WatchlistProvider>
        </AccountProvider>
      </body>
    </html>
  );
}
