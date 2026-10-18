/**
 * 用户名注册/登录存储 —— 文件型账号库（单实例部署）。
 *
 * - 密码用 scrypt + 每账号随机盐哈希，绝不存明文
 * - 账号文件 data/auth-accounts.json（已加入 .gitignore），写盘用临时文件+原子替换
 * - 用户名：3-24 位，字母/数字/下划线/中文/连字符，唯一（不区分大小写）
 * - 密码：至少 8 位
 * - 用户 ID：'u' + sha256('fin-user:' + username 小写)，稳定不透明
 */

import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'auth-accounts.json');

export const USERNAME_RE = /^[\w\u4e00-\u9fa5-]{3,24}$/;

interface AccountRecord {
  id: string;
  salt: string;
  hash: string;
  createdAt: number;
}

interface Store {
  accounts: Record<string, AccountRecord>;
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw) as Store;
    if (j && typeof j.accounts === 'object') return j;
  } catch {
    /* 文件不存在或损坏时按空库处理 */
  }
  return { accounts: {} };
}

function writeStore(store: Store): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.' + randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, FILE);
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString('hex');
}

export function userIdOf(username: string): string {
  return 'u' + createHash('sha256').update(`fin-user:${username.toLowerCase()}`).digest('hex').slice(0, 24);
}

export function normalizeUsername(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!USERNAME_RE.test(value)) return null;
  if (/^1[3-9]\d{9}$/.test(value)) return null; // 避免与手机号身份混淆
  return value;
}

export function checkPasswordStrength(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return '密码至少 8 位';
  }
  return null;
}

/** 注册；用户名已存在时抛错 */
export function registerUser(username: string, password: string): { id: string; name: string } {
  const key = username.toLowerCase();
  const store = readStore();
  if (store.accounts[key]) throw new Error('用户名已被注册');
  const salt = randomBytes(16).toString('hex');
  const record: AccountRecord = {
    id: userIdOf(username),
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
  };
  store.accounts[key] = record;
  writeStore(store);
  return { id: record.id, name: username };
}

/** 登录校验；失败统一抛错（不区分用户名不存在/密码错误） */
export function verifyUser(username: string, password: string): { id: string; name: string } {
  const key = username.toLowerCase();
  const record = readStore().accounts[key];
  const fail = () => {
    throw new Error('用户名或密码错误');
  };
  if (!record) return fail();
  const expected = Buffer.from(record.hash, 'hex');
  const supplied = Buffer.from(hashPassword(password, record.salt), 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return fail();
  return { id: record.id, name: username };
}
