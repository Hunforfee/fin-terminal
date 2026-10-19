'use client';
import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import CompanyWindow from './CompanyWindow';
import HeaderToolButton from './HeaderToolButton';
import { useWatchlist } from './WatchlistProvider';
import { useResearchWorkspace } from './ResearchWorkspaceProvider';
import { normalizeStockCode } from '@/lib/datasource/codes';
import { industryStockSymbol } from '@/lib/industryResearch';
const items = [
  ['/watchlist', '自选公司'],
  ['/industry', '行业研究'],
  ['/screener', '条件选股'],
  ['/fund', '基金'],
] as const;
export default function AppNav() {
  const pathname = usePathname();
  const { codes } = useWatchlist();
  const { notebook, notesOpen, openNotes } = useResearchWorkspace();
  const announcementCodes = useMemo(() => {
    const eligible = codes.flatMap(input => {
      const stock = normalizeStockCode(input);
      return stock && industryStockSymbol(stock.code) === stock.symbol
        ? [stock.code]
        : [];
    });
    return [...new Set(eligible)];
  }, [codes]);
  return (
    <nav aria-label="主导航" className="flex items-center gap-1 overflow-x-auto py-1">
      {items.map(([href, label]) => {
        const active =
          (href === '/watchlist' && pathname === '/') ||
          pathname.startsWith(href);
        return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${active ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-100' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
            >
              {label}
            </Link>
        );
      })}
      <div role="group" aria-label="研究工具" className="ml-2 flex shrink-0 items-center gap-2 border-l border-slate-200 pl-3">
        <CompanyWindow codes={announcementCodes} variant="nav" />
        <HeaderToolButton
          label="研究笔记"
          aria-label="打开研究笔记"
          aria-haspopup="dialog"
          aria-expanded={notesOpen}
          disabled={!notebook.ready}
          onClick={() => openNotes()}
        >
          <svg aria-hidden="true" focusable="false" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
            <path d="M14 3v6h6M8 13h8M8 17h6" />
          </svg>
        </HeaderToolButton>
      </div>
    </nav>
  );
}
