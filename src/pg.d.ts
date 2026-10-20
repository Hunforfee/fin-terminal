// 发布兼容性声明：pg 仅在配置 DATABASE_URL 时才会被运行加载（可选个人数据存储）。
// 发布沙箱无 PostgreSQL，构建期不打包不解析该模块，故此处声明为外部模块以满足类型检查。
declare module 'pg';
