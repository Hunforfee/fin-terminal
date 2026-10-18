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

export class AccountStoreError extends Error {}

function readStore(): Store {
  let raw: string;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { accounts: {} };
    throw new AccountStoreError('账号数据暂不可用');
  }
  let store: Store;
  try {
    store = JSON.parse(raw) as Store;
  } catch {
    throw new AccountStoreError('账号数据暂不可用');
  }
  if (
    !store ||
    typeof store !== 'object' ||
    Array.isArray(store) ||
    !store.accounts ||
    typeof store.accounts !== 'object' ||
    Array.isArray(store.accounts) ||
    Object.values(store.accounts).some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        typeof entry.salt !== 'string' ||
        !/^[a-f0-9]{32}$/i.test(entry.salt) ||
        typeof entry.hash !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(entry.hash) ||
        !Number.isFinite(entry.createdAt),
    )
  )
    throw new AccountStoreError('账号数据暂不可用');
  return store;
}

function writeStore(store: Store): void {
  const tmp = FILE + '.' + randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw new AccountStoreError('账号数据暂不可用');
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString('hex');
}

export function userIdOf(username: string): string {
  return (
    'u' +
    createHash('sha256')
      .update(`fin-user:${username.toLowerCase()}`)
      .digest('hex')
      .slice(0, 24)
  );
}

export function normalizeUsername(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!USERNAME_RE.test(value)) return null;
  if (/^\d{11}$/.test(value)) return null; // 与会话显示名规则一致，避免注册后无法登录
  return value;
}

export function checkPasswordStrength(password: unknown): string | null {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 128
  ) {
    return '密码至少 8 位';
  }
  return null;
}

/** 注册；用户名已存在时抛错 */
export function registerUser(
  username: string,
  password: string,
): { id: string; name: string } {
  const normalized = normalizeUsername(username);
  if (!normalized)
    throw new Error(
      '用户名需 3-24 位字母、数字、下划线、中文或连字符，不能是 11 位纯数字',
    );
  const weak = checkPasswordStrength(password);
  if (weak) throw new Error(weak);
  username = normalized;
  const key = username.toLowerCase();
  const store = readStore();
  if (Object.hasOwn(store.accounts, key)) throw new Error('用户名已被注册');
  const salt = randomBytes(16).toString('hex');
  const record: AccountRecord = {
    id: userIdOf(username),
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
  };
  Object.defineProperty(store.accounts, key, {
    value: record,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  writeStore(store);
  return { id: record.id, name: username };
}

/** 登录校验；失败统一抛错（不区分用户名不存在/密码错误） */
export function verifyUser(
  username: string,
  password: string,
): { id: string; name: string } {
  if (
    !normalizeUsername(username) ||
    typeof password !== 'string' ||
    password.length > 128
  )
    throw new Error('用户名或密码错误');
  const key = username.toLowerCase();
  const accounts = readStore().accounts;
  const record = Object.hasOwn(accounts, key) ? accounts[key] : undefined;
  const fail = () => {
    throw new Error('用户名或密码错误');
  };
  if (!record) return fail();
  const expected = Buffer.from(record.hash, 'hex');
  const supplied = Buffer.from(hashPassword(password, record.salt), 'hex');
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    return fail();
  return { id: record.id, name: username };
}
