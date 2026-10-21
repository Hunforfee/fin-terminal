/** Server-side public data store. Never uses browser auth or personal-data tables. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { retainMarketPayload } from './marketRetention';

export interface MarketRecord<T = unknown> {
  schema: 1; key: string; kind: string; source: string; payload: T;
  digest: string; acquiredAt: string; refreshAfter: string;
  validation: 'structural'; // Never means audited against original disclosures.
}
export interface MarketStore {
  close?(): Promise<void>;
  coordinated?: boolean;
  read<T>(key: string): Promise<MarketRecord<T> | null>;
  write<T>(record: MarketRecord<T>, expected: string | null): Promise<boolean>;
  incident(key: string, reason: string, details?: unknown): Promise<void>;
  readInputs?(keys: string[]): Promise<MarketRecord[]>;
  writeInputs?(items: { record: MarketRecord; expected: string | null }[]): Promise<number>;
  scan?(after: string, limit: number): Promise<{ records: MarketRecord[]; cursor: string; done: boolean }>;
  remove?(key: string, expected: string): Promise<boolean>;
  pruneAux?(now: number): Promise<void>;
}
// PostgreSQL JSONB changes object-key order. Hash canonical JSON, not insertion order.
export const marketDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)).digest('hex');
export function marketRecord<T>(key: string, kind: string, source: string, payload: T, ttl: number, now = Date.now()): MarketRecord<T> {
  payload = retainMarketPayload(kind, payload, now);
  return { schema: 1, key, kind, source, payload, digest: marketDigest(payload), acquiredAt: new Date(now).toISOString(),
    refreshAfter: new Date(now + ttl).toISOString(), validation: 'structural' };
}
function checked<T>(value: MarketRecord<T>, key: string): MarketRecord<T> {
  if (value?.schema !== 1 || value.key !== key || marketDigest(value.payload) !== value.digest ||
      !Number.isFinite(Date.parse(value.acquiredAt)) || !Number.isFinite(Date.parse(value.refreshAfter)))
    throw Error('市场数据存储校验失败');
  return value;
}

/** Local single-process development adapter. Explicit directory required in production. */
export function fileMarketStore(directory: string): MarketStore {
  const root = path.resolve(directory);
  const queues = new Map<string, Promise<unknown>>();
  const file = (key: string) => path.join(root, marketDigest(key) + '.json');
  const serial = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn); queues.set(key, next);
    try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
  };
  const read = async <T>(key: string): Promise<MarketRecord<T> | null> => {
    try { return checked(JSON.parse(await fs.readFile(file(key), 'utf8')), key); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  };
  const adapter: MarketStore = {
    coordinated: true,
    read,
    async scan(after, limit) {
      let names: string[];
      try { names = (await fs.readdir(root)).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], cursor: '', done: true }; throw e; }
      const selected = names.filter(n => n > after).slice(0, limit), records: MarketRecord[] = [];
      for (const name of selected) {
        const value = JSON.parse(await fs.readFile(path.join(root,name),'utf8'));
        if (value?.schema === 1 && file(value.key) === path.join(root,name)) records.push(checked(value,value.key));
      }
      return { records, cursor: selected.at(-1) ?? '', done: !selected.length || selected.at(-1) === names.at(-1) };
    },
    remove: (key, expected) => serial(key, async () => {
      const old = await read(key); if (!old || old.digest !== expected) return false;
      await fs.unlink(file(key));
      await fs.unlink(file(key)+'.history.json').catch(e => { if (e.code !== 'ENOENT') throw e; });
      return true;
    }),
    async pruneAux(now) {
      let names: string[]; try { names = await fs.readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      for (const name of names.filter(n => /^[a-f0-9]{64}\.json(?:\.history\.json)?$/.test(n))) {
        const target = path.join(root,name), rows = JSON.parse(await fs.readFile(target,'utf8'));
        if (!Array.isArray(rows) || !rows.length) continue;
        const history = name.endsWith('.history.json'), key = rows[0]?.key;
        if (typeof key !== 'string' || target !== (history ? file(key)+'.history.json' : file('incidents:'+key))) continue;
        await serial(history ? key : 'incidents:'+key, async () => {
          const current = JSON.parse(await fs.readFile(target,'utf8'));
          const kept = current.filter((r: any) => Date.parse(history ? r.acquiredAt : r.at) >= now - (history ? 7 : 30)*864e5)
            .map((r: any) => history ? { ...r, payload: retainMarketPayload(r.kind,r.payload,now) } : r)
            .map((r: any) => history ? { ...r, digest: marketDigest(r.payload) } : r);
          const temp = target+'.'+randomUUID(); await fs.writeFile(temp,JSON.stringify(kept),{mode:0o600}); await fs.rename(temp,target);
        });
      }
    },
    async readInputs(keys) {
      const result: MarketRecord[] = [];
      for (let i = 0; i < keys.length; i += 32) {
        const rows = await Promise.all(keys.slice(i, i + 32).map(key => read(key)));
        result.push(...rows.filter((r): r is MarketRecord => r !== null));
      }
      return result;
    },
    async writeInputs(items) {
      let written = 0;
      for (let i = 0; i < items.length; i += 16)
        written += (await Promise.all(items.slice(i, i + 16).map(item => adapter.write(item.record, item.expected)))).filter(Boolean).length;
      return written;
    },
    write: (record, expected) => serial(record.key, async () => {
      await fs.mkdir(root, { recursive: true });
      const old = await read(record.key);
      if ((old?.digest ?? null) !== expected) return false;
      if (old && old.digest !== record.digest && !['fetch-lease','market-maintenance','market-update-queue'].includes(record.kind)) {
        const history = file(record.key) + '.history.json';
        let entries: unknown[] = [];
        try { entries = JSON.parse(await fs.readFile(history, 'utf8')); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        const temp = history + '.' + randomUUID();
        await fs.writeFile(temp, JSON.stringify([...entries.slice(-3), old]), { mode: 0o600 });
        await fs.rename(temp, history);
      }
      const temp = file(record.key) + '.' + randomUUID();
      await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temp, file(record.key));
      return true;
    }),
    incident: (key, reason, details) => serial('incidents:' + key, async () => {
      await fs.mkdir(root, { recursive: true });
      const target = file('incidents:' + key);
      let rows: unknown[] = [];
      try { rows = JSON.parse(await fs.readFile(target, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const temp = target + '.' + randomUUID();
      await fs.writeFile(temp, JSON.stringify([...rows.slice(-19), { at: new Date().toISOString(), key, reason, details }]), { mode: 0o600 });
      await fs.rename(temp, target);
    }),
  };
  return adapter;
}

export function postgresMarketStore(connectionString: string, poolFactory?: () => Promise<any>): MarketStore {
  let pool: any;
  let ready: Promise<void> | undefined;
  const database = async () => {
    if (!pool) {
      if (poolFactory) pool = await poolFactory();
      else {
        const { Pool } = await import('pg');
        pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 1500, query_timeout: 4000,
          statement_timeout: 3500, idleTimeoutMillis: 30000 });
        pool.on('error', () => {}); // Connection errors are handled at the request boundary.
      }
    }
    ready ??= pool.query(`
      CREATE TABLE IF NOT EXISTS fin_market_records (key text PRIMARY KEY, body jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS fin_market_bars (key text NOT NULL, date text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(key,date));
      CREATE TABLE IF NOT EXISTS fin_market_revisions (id bigserial PRIMARY KEY, key text NOT NULL, at timestamptz NOT NULL DEFAULT now(), body jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS fin_market_revisions_key ON fin_market_revisions(key,at);
      CREATE TABLE IF NOT EXISTS fin_market_incidents (id bigserial PRIMARY KEY, key text NOT NULL, at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL, details jsonb);
    `).then(() => {}).catch((e: unknown) => { ready = undefined; throw e; });
    await ready; return pool;
  };
  return {
    async close() { if(pool)await pool.end(); },
    coordinated: true,
    async scan(after, limit) {
      const db = await database();
      const result = await db.query('SELECT key FROM fin_market_records WHERE key>$1 ORDER BY key LIMIT $2',[after,limit]);
      const records: MarketRecord[] = [];
      for (const r of result.rows) {
        const value = await db.query(`SELECT r.body, COALESCE((SELECT jsonb_agg(b.body ORDER BY b.date) FROM fin_market_bars b WHERE b.key=r.key),'[]'::jsonb) bars FROM fin_market_records r WHERE r.key=$1`,[r.key]);
        if (!value.rows.length) continue;
        const row = value.rows[0].body; if (row.kind === 'kline') row.payload.candles = value.rows[0].bars;
        records.push(checked(row,r.key));
      }
      return { records, cursor: result.rows.at(-1)?.key ?? '', done: result.rows.length < limit };
    },
    async remove(key, expected) {
      const db = await database(), client = await db.connect();
      try {
        await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
        const deleted = await client.query("DELETE FROM fin_market_records WHERE key=$1 AND body->>'digest'=$2 RETURNING key",[key,expected]);
        if (deleted.rows.length) {
          await client.query('DELETE FROM fin_market_bars WHERE key=$1',[key]);
          await client.query('DELETE FROM fin_market_revisions WHERE key=$1',[key]);
        }
        await client.query('COMMIT'); return !!deleted.rows.length;
      } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; } finally { client.release(); }
    },
    async pruneAux(now) {
      const db = await database();
      await db.query('DELETE FROM fin_market_revisions WHERE at < $1',[new Date(now-7*864e5).toISOString()]);
      let after='0';
      while(true){
        const page=await db.query('SELECT id,body FROM fin_market_revisions WHERE id>$1 ORDER BY id LIMIT 200',[after]);
        const updates=page.rows.flatMap((r:any)=>{
          const payload=retainMarketPayload(r.body.kind,r.body.payload,now),digest=marketDigest(payload);
          return digest===r.body.digest?[]:[{id:r.id,body:{...r.body,payload,digest}}];
        });
        if(updates.length)await db.query(`UPDATE fin_market_revisions r SET body=i->'body' FROM jsonb_array_elements($1::jsonb) i WHERE r.id=(i->>'id')::bigint`,[JSON.stringify(updates)]);
        if(page.rows.length<200)break;after=String(page.rows.at(-1).id);
      }
      await db.query('DELETE FROM fin_market_incidents WHERE at < $1',[new Date(now-30*864e5).toISOString()]);
    },
    async readInputs(keys) {
      const db = await database();
      const result = await db.query('SELECT key,body FROM fin_market_records WHERE key=ANY($1::text[])', [keys]);
      return result.rows.map((r: any) => {
        if (r.body.kind === 'kline') throw Error('批量输入读取不支持K线');
        return checked(r.body, r.key);
      });
    },
    async writeInputs(items) {
      if (!items.length) return 0;
      if (items.some(item => item.record.kind === 'kline')) throw Error('K线必须使用事务版本写入');
      const db = await database(), client = await db.connect();
      const data = JSON.stringify(items);
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended(k,0)) FROM unnest($1::text[]) k ORDER BY k', [items.map(i => i.record.key).sort()]);
        await client.query(`INSERT INTO fin_market_revisions(key,body)
          SELECT r.key,r.body FROM fin_market_records r JOIN jsonb_array_elements($1::jsonb) i ON r.key=i->'record'->>'key'
          WHERE r.body->>'digest'=i->>'expected' AND r.body->>'digest'<>i->'record'->>'digest'`, [data]);
        const result = await client.query(`INSERT INTO fin_market_records(key,body)
          SELECT i->'record'->>'key',i->'record' FROM jsonb_array_elements($1::jsonb) i
          ON CONFLICT(key) DO UPDATE SET body=EXCLUDED.body WHERE fin_market_records.body->>'digest'=
          (SELECT i->>'expected' FROM jsonb_array_elements($1::jsonb) i WHERE i->'record'->>'key'=EXCLUDED.key) RETURNING key`, [data]);
        await client.query(`DELETE FROM fin_market_revisions WHERE id IN
          (SELECT id FROM (SELECT id,row_number() OVER(PARTITION BY key ORDER BY id DESC) n FROM fin_market_revisions WHERE key=ANY($1::text[])) r WHERE n>4)`, [items.map(i => i.record.key)]);
        await client.query('COMMIT'); return result.rows.length;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    },
    async read<T>(key: string) {
      const db = await database();
      // One SQL snapshot keeps metadata and bars from different versions apart.
      const result = await db.query(`SELECT r.body, COALESCE((SELECT jsonb_agg(b.body ORDER BY b.date) FROM fin_market_bars b WHERE b.key=r.key),'[]'::jsonb) AS bars FROM fin_market_records r WHERE r.key=$1`, [key]);
      if (!result.rows.length) return null;
      const record = result.rows[0].body;
      if (record.kind === 'kline') record.payload.candles = result.rows[0].bars;
      return checked<T>(record, key);
    },
    async write(record, expected) {
      const db = await database(), client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [record.key]);
        const previous = await client.query('SELECT body FROM fin_market_records WHERE key=$1 FOR UPDATE', [record.key]);
        const old = previous.rows[0]?.body;
        if ((old?.digest ?? null) !== expected) { await client.query('ROLLBACK'); return false; }
        if (old && old.digest !== record.digest && !['fetch-lease','market-maintenance','market-update-queue'].includes(record.kind)) {
          const oldBars = old.kind === 'kline' ? await client.query('SELECT body FROM fin_market_bars WHERE key=$1 ORDER BY date', [record.key]) : null;
          if (oldBars) old.payload.candles = oldBars.rows.map((r: any) => r.body);
          await client.query('INSERT INTO fin_market_revisions(key,body) VALUES($1,$2)', [record.key, JSON.stringify(old)]);
          await client.query('DELETE FROM fin_market_revisions WHERE key=$1 AND id NOT IN (SELECT id FROM fin_market_revisions WHERE key=$1 ORDER BY id DESC LIMIT 4)', [record.key]);
        }
        const body = JSON.parse(JSON.stringify(record));
        if (record.kind === 'kline') {
          const candles = body.payload.candles; delete body.payload.candles;
          await client.query(`INSERT INTO fin_market_bars(key,date,body) SELECT $1,item->>'date',item FROM jsonb_array_elements($2::jsonb) item ON CONFLICT(key,date) DO UPDATE SET body=EXCLUDED.body WHERE fin_market_bars.body IS DISTINCT FROM EXCLUDED.body`, [record.key, JSON.stringify(candles)]);
          await client.query(`DELETE FROM fin_market_bars WHERE key=$1 AND NOT(date=ANY($2::text[]))`, [record.key, candles.map((c: any) => c.date)]);
        }
        await client.query('INSERT INTO fin_market_records(key,body) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET body=EXCLUDED.body', [record.key, JSON.stringify(body)]);
        await client.query('COMMIT'); return true;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    },
    async incident(key, reason, details) {
      const db = await database();
      await db.query('INSERT INTO fin_market_incidents(key,reason,details) VALUES($1,$2,$3)', [key, reason, JSON.stringify(details ?? null)]);
      await db.query("DELETE FROM fin_market_incidents WHERE at < now() - interval '30 days'");
    },
  };
}

let configured: MarketStore | undefined;
export function getMarketStore(): MarketStore | null {
  if (process.env.MARKET_DATA_STORE === 'off') return null;
  if (process.env.NODE_TEST_CONTEXT && !process.env.MARKET_DATA_DIR && !process.env.MARKET_DATABASE_URL) return null;
  if (configured) return configured;
  const url = process.env.MARKET_DATABASE_URL || process.env.DATABASE_URL;
  if (url) return configured = postgresMarketStore(url);
  if (process.env.MARKET_DATA_DIR || process.env.NODE_ENV !== 'production')
    return configured = fileMarketStore(process.env.MARKET_DATA_DIR || path.join(process.cwd(), 'data', 'market'));
  return null; // No implicit ephemeral-file storage in a hosted production deployment.
}
