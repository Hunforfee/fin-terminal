'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
const items = [
  ['/watchlist', '自选公司'],
  ['/industry', '行业研究'],
  ['/screener', '条件选股'],
  ['/fund', '基金'],
] as const;
export default function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="主导航" className="flex gap-1 overflow-x-auto py-1">
      {items.map(([href, label]) => {
        const active = pathname.startsWith(href);
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
    </nav>
  );
}
