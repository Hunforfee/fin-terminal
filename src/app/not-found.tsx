import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card-pad my-10 text-center">
      <h1 className="text-lg font-semibold text-slate-900">未找到该标的</h1>
      <p className="mt-2 text-sm text-slate-500">
        可能是代码有误，或该标的不在公开数据源的覆盖范围内。
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Link href="/" className="btn">
          返回首页
        </Link>
        <Link href="/screener" className="btn-primary">
          去条件选股
        </Link>
      </div>
    </div>
  );
}
