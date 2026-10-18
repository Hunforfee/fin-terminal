'use client';

import { useEffect, useRef, useState } from 'react';

/** Keep long lists inside the remaining window space. */
export default function StockListViewport({
  children,
  resetKey,
}: {
  children: React.ReactNode;
  resetKey: string;
}) {
  const region = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>();
  const velocity = useRef(0);
  const frame = useRef(0);

  useEffect(() => {
    const element = region.current;
    if (!element) return;
    const measure = () => {
      // Document position is stable while the outer page scrolls.
      const top = element.getBoundingClientRect().top + window.scrollY;
      const footer =
        element.nextElementSibling?.getBoundingClientRect().height ?? 40;
      const height = window.visualViewport?.height ?? window.innerHeight;
      setMaxHeight(Math.round(Math.max(200, height - top - footer - 16)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (element.parentElement) observer.observe(element.parentElement);
    if (element.nextElementSibling)
      observer.observe(element.nextElementSibling);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    region.current?.scrollTo({ top: 0, left: 0 });
  }, [resetKey]);

  function stopAutoScroll() {
    velocity.current = 0;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  }
  useEffect(() => {
    // Also stop if the drag ends outside this scroll area.
    document.addEventListener('dragend', stopAutoScroll);
    document.addEventListener('drop', stopAutoScroll);
    return () => {
      stopAutoScroll();
      document.removeEventListener('dragend', stopAutoScroll);
      document.removeEventListener('drop', stopAutoScroll);
    };
  }, []);

  function animateScroll() {
    const element = region.current;
    if (!element || !velocity.current) {
      frame.current = 0;
      return;
    }
    element.scrollTop += velocity.current;
    frame.current = requestAnimationFrame(animateScroll);
  }

  function keepFocusedRowVisible() {
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && region.current?.contains(focused)) {
        focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
  }

  return (
    <div
      ref={region}
      role="region"
      aria-label="股票列表滚动区域"
      tabIndex={0}
      className="research-stock-viewport overflow-auto focus-visible:outline-offset-[-2px]"
      style={{
        maxHeight: maxHeight ?? 'max(200px, calc(100dvh - 400px))',
        scrollbarGutter: 'stable',
      }}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest('button');
        if (/^[上下]移/.test(button?.getAttribute('aria-label') ?? ''))
          keepFocusedRowVisible();
      }}
      onKeyDown={(event) => {
        if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key))
          keepFocusedRowVisible();
        if (
          event.target !== event.currentTarget ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        const element = event.currentTarget;
        const page = Math.max(40, element.clientHeight - 44);
        const positions: Record<string, number> = {
          ArrowDown: element.scrollTop + 40,
          ArrowUp: element.scrollTop - 40,
          PageDown: element.scrollTop + page,
          PageUp: element.scrollTop - page,
          Home: 0,
          End: element.scrollHeight,
        };
        if (event.key in positions) {
          event.preventDefault();
          element.scrollTo({ top: positions[event.key] });
        }
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('application/x-fin-stock'))
          return;
        const element = region.current;
        if (!element) return;
        const bounds = element.getBoundingClientRect();
        const header =
          element.querySelector('thead')?.getBoundingClientRect().height ?? 40;
        const fromTop = event.clientY - bounds.top - header;
        const fromBottom = bounds.bottom - event.clientY;
        velocity.current =
          fromTop < 36
            ? -Math.min(12, Math.max(2, (36 - fromTop) / 3))
            : fromBottom < 36
              ? Math.min(12, Math.max(2, (36 - fromBottom) / 3))
              : 0;
        if (!velocity.current) stopAutoScroll();
        else if (!frame.current)
          frame.current = requestAnimationFrame(animateScroll);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          stopAutoScroll();
      }}
      onDrop={stopAutoScroll}
      onDragEnd={stopAutoScroll}
    >
      {children}
    </div>
  );
}
