import { NextRequest, NextResponse } from 'next/server';
import { proxyRemoteMarketRequest } from './lib/marketDataClient';

export async function middleware(request: NextRequest) {
  const response = await proxyRemoteMarketRequest(request);
  return response ? new NextResponse(response.body, { status: response.status, headers: response.headers }) : NextResponse.next();
}
export const config = { matcher: ['/api/:path*'], runtime: 'nodejs' };
