/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 行情/K线抓取发生在服务端 Route Handler，无需外网图片资源
  images: { unoptimized: true },
  experimental: {
    // 上游数据源单次可能较慢，放宽 Server Action / 路由体大小限制
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
