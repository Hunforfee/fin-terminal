/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    '/api/analysis': ['./src/data/analyses/[0-9]*.json'],
    '/api/company-learning': ['./src/data/analyses/[0-9]*.json'],
  },
  // 行情/K线抓取发生在服务端 Route Handler，无需外网图片资源
  images: { unoptimized: true },
  experimental: {
    // 上游数据源单次可能较慢，放宽 Server Action / 路由体大小限制
    serverActions: { bodySizeLimit: '2mb' },
  },
  webpack: (config) => {
    // pg 仅用于可选 PostgreSQL 个人数据存储；默认走文件存储，沙箱无数据库，
    // 故将其外部化，构建时不打包、不解析。
    config.externals = config.externals || [];
    config.externals.push({ pg: 'commonjs pg' });
    return config;
  },
};

export default nextConfig;
