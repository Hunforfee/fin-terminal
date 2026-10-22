'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';

/**
 * 站内个股页链接的统一出口：强制新标签打开（target="_blank" + rel="noopener noreferrer"），
 * 并默认关闭预取（股票页不需要即时预渲染）。其余 <Link> 语义（className / onClick / title 等）原样透传。
 * 这样「点击任意股票都在新标签打开」由单一组件保证，新增入口只需复用本组件。
 */
export function StockLink(props: ComponentProps<typeof Link>) {
  const { target, rel, prefetch, ...rest } = props;
  return (
    <Link
      {...rest}
      target={target ?? '_blank'}
      rel={rel ?? 'noopener noreferrer'}
      prefetch={prefetch ?? false}
    />
  );
}
