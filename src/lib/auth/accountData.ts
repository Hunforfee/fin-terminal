import { Pool } from 'pg';
import type { PersonalSnapshot } from '../personalStorage';
export interface AccountRecord {
  revision: number;
  data: PersonalSnapshot;
}
let pool: Pool | null = null;
let initialized: Promise<void> | null = null;
async function database(): Promise<Pool> {
  if (!process.env.DATABASE_URL) throw new Error('个人数据存储未配置');
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
export async function readAccountData(userId: string): Promise<AccountRecord> {
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
/** Compare-and-swap prevents one device from silently replacing another's edits. */
export async function writeAccountData(
  userId: string,
  revision: number,
  data: PersonalSnapshot,
): Promise<AccountRecord | null> {
  const db = await database();
  const result = await db.query(
    'UPDATE fin_account_data SET revision=revision+1,data=$3::jsonb,updated_at=now() WHERE user_id=$1 AND revision=$2 RETURNING revision,data',
    [userId, revision, JSON.stringify(data)],
  );
  return result.rowCount
    ? { revision: Number(result.rows[0].revision), data: result.rows[0].data }
    : null;
}
