/**
 * 账号个人数据（自选分组、笔记、财务模块配置、AI 历史等）云同步存储。
 *
 * 存储策略：优先 Postgres（配置 DATABASE_URL 时，适合多实例部署），
 * 否则回退到文件存储 data/account-data.json —— 与账号库同一套零依赖机制，
 * 单实例部署下即可跨设备同步，写盘用临时文件 + rename 保证原子性。
 * 两层都用 revision 做乐观并发控制（CAS），避免一台设备静默覆盖另一台。
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PersonalSnapshot } from '../personalStorage';

export interface AccountRecord {
  revision: number;
  data: PersonalSnapshot;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'account-data.json');

interface Store {
  users: Record<
    string,
    { revision: number; data: PersonalSnapshot; updatedAt: number }
  >;
}

function readStore(): Store {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Store;
    if (j && typeof j.users === 'object' && j.users) return j;
  } catch {
    /* 文件不存在或损坏时按空库处理 */
  }
  return { users: {} };
}

function writeStore(store: Store): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, FILE);
}

/* ---------------- Postgres 分支（配置 DATABASE_URL 时启用） ---------------- */

let pool: import('pg').Pool | null = null;
let initialized: Promise<void> | null = null;

async function database(): Promise<import('pg').Pool> {
  const { Pool } = await import('pg');
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
  });
  const db = pool;
  initialized ??= db
    .query(
      "CREATE TABLE IF NOT EXISTS fin_account_data (user_id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0, data jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now())",
    )
    .then(() => {});
  try {
    await initialized;
  } catch (error) {
    initialized = null;
    throw error;
  }
  return db;
}

/** 同步功能是否可用：文件存储始终可用（仅需 data/ 目录可写）。 */
export function dataSyncReady(): boolean {
  return true;
}

/* ---------------- 对外接口 ---------------- */

export async function readAccountData(userId: string): Promise<AccountRecord> {
  if (process.env.DATABASE_URL) {
    const db = await database();
    await db.query(
      'INSERT INTO fin_account_data(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',
      [userId],
    );
    const result = await db.query(
      'SELECT revision, data FROM fin_account_data WHERE user_id=$1',
      [userId],
    );
    return {
      revision: Number(result.rows[0].revision),
      data: result.rows[0].data,
    };
  }
  const entry = readStore().users[userId];
  return entry
    ? { revision: entry.revision, data: entry.data }
    : { revision: 0, data: {} };
}

/** 版本号不匹配时返回 null（调用方回 409 并附带最新数据）。 */
export async function writeAccountData(
  userId: string,
  revision: number,
  data: PersonalSnapshot,
): Promise<AccountRecord | null> {
  if (process.env.DATABASE_URL) {
    const db = await database();
    const result = await db.query(
      'UPDATE fin_account_data SET revision=revision+1,data=$3::jsonb,updated_at=now() WHERE user_id=$1 AND revision=$2 RETURNING revision,data',
      [userId, revision, JSON.stringify(data)],
    );
    return result.rowCount
      ? { revision: Number(result.rows[0].revision), data: result.rows[0].data }
      : null;
  }
  const store = readStore();
  const current = store.users[userId]?.revision ?? 0;
  if (current !== revision) return null;
  const next: AccountRecord = { revision: current + 1, data };
  store.users[userId] = { ...next, updatedAt: Date.now() };
  writeStore(store);
  return next;
}
