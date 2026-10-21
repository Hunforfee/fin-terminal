import { Pool } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Bounded, read-only production inspection. Does not initialize tables or export credentials/personal records. */
export async function auditMarketDatabase(pool) {
  const client = await pool.connect();
  const report = { at: new Date().toISOString(), readOnly: true, checks: {} };
  const query = async (name, sql, args = []) => {
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const result = await client.query(sql, args);
      report.checks[name] = result.rows;
      return result.rows;
    } catch (e) {
      // Connection strings and database error details must not leak into reports.
      report.checks[name] = { errorCode: e.code ?? 'QUERY_FAILED' };
      return [];
    } finally { await client.query('ROLLBACK').catch(() => {}); }
  };
  try {
    const tables = await query('tables', `SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS data_type
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
      WHERE c.relname = ANY($1::text[]) AND pg_table_is_visible(c.oid) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`, [['fin_market_records','fin_market_bars','fin_market_revisions','fin_market_incidents']]);
    const present = new Set(tables.map(t => t.table_name));
    if (present.has('fin_market_records')) {
      await query('recordKinds', `SELECT body->>'kind' AS kind, count(*)::int AS records,
        min(body->>'acquiredAt') AS oldest_acquired_at, max(body->>'acquiredAt') AS newest_acquired_at
        FROM fin_market_records GROUP BY body->>'kind' ORDER BY records DESC LIMIT 50`);
      const codes = ['600415','000923'];
      const keys = codes.flatMap(code => ['profit','balance','cashflow'].flatMap(statement =>
        [2024,2025,2026].map(year => `source-sina-page:v1:${code}:${statement}:${year}`)));
      await query('sampleFinancialCoverage', `SELECT key, body->>'source' AS source,
        body->'payload'->'dates' AS report_dates,
        jsonb_array_length(body->'payload'->'rows') AS field_rows
        FROM fin_market_records WHERE key=ANY($1::text[]) ORDER BY key`, [keys]);
      const histories = codes.flatMap(code => [2,5,6,12].map(span=>`statements-v3:${code}:${span}`));
      await query('sampleValuationHistory', `SELECT r.key, count(p.value)::int AS periods,
        count(*) FILTER (WHERE jsonb_typeof(p.value->'npParent')='number')::int AS profit_periods,
        count(*) FILTER (WHERE jsonb_typeof(p.value->'equityParent')='number')::int AS equity_periods,
        count(*) FILTER (WHERE jsonb_typeof(p.value->'sharesYi')='number')::int AS share_periods,
        min(p.value->>'date') AS first_report, max(p.value->>'date') AS last_report
        FROM fin_market_records r LEFT JOIN LATERAL jsonb_array_elements(r.body->'payload') p ON true
        WHERE r.key=ANY($1::text[]) GROUP BY r.key ORDER BY r.key`, [histories]);
    }
    if (present.has('fin_market_bars')) await query('priceCoverage', `SELECT key,count(*)::int AS bars,
      min(date) AS first_date,max(date) AS last_date FROM fin_market_bars
      WHERE key=ANY($1::text[]) GROUP BY key ORDER BY key`,
      [['sh600415','sz000923'].map(s=>`kline:v2:${s}:day:none:canonical:prices-only`)]);
    if (present.has('fin_market_revisions')) await query('sampleRecoveryVersions', `SELECT key,count(*)::int AS versions,
      min(at) AS oldest_version,max(at) AS newest_version FROM fin_market_revisions
      WHERE key LIKE 'source-sina-page:v1:600415:%' OR key LIKE 'source-sina-page:v1:000923:%'
      GROUP BY key ORDER BY key LIMIT 30`);
    return report;
  } finally { client.release(); }
}

if (import.meta.url === (await import('node:url')).pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  const connectionString = process.env.MARKET_DATABASE_READONLY_URL;
  if (!connectionString) {
    console.error('未配置 MARKET_DATABASE_READONLY_URL；不会使用生产写入账号或创建任何表。');
    process.exitCode = 1;
  } else {
    const pool = new Pool({connectionString,max:1,connectionTimeoutMillis:5000,query_timeout:6000});
    pool.on('error',()=>{});
    try {
      const report=await auditMarketDatabase(pool), output=process.argv[2];
      if (output) await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
      else console.log(JSON.stringify(report,null,2));
    } catch (e) { console.error(`只读连接失败（${e.code ?? 'CONNECTION_FAILED'}），未执行写入。`);process.exitCode=1; }
    finally { await pool.end(); }
  }
}
