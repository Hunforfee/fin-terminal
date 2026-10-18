'use client';

export default function OrderButtons({
  name,
  first,
  last,
  onMove,
}: {
  name: string;
  first: boolean;
  last: boolean;
  onMove: (delta: number) => void;
}) {
  return (
    <span className="inline-flex shrink-0">
      {([-1, 1] as const).map((delta) => (
        <button
          key={delta}
          type="button"
          aria-label={`${delta < 0 ? '上移' : '下移'}${name}`}
          title={`${delta < 0 ? '上移' : '下移'}${name}`}
          disabled={delta < 0 ? first : last}
          onClick={() => onMove(delta)}
          className="grid h-7 w-6 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-brand-700 disabled:opacity-20"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d={delta < 0 ? 'm4 9 4-4 4 4' : 'm4 6 4 4 4-4'} />
          </svg>
        </button>
      ))}
    </span>
  );
}
