/**
 * 邮箱验证码 Provider —— 与短信通道并行的零注册登录方案。
 *
 * 环境变量（全部必需才启用）：
 *   SMTP_HOST   如 smtp.qq.com
 *   SMTP_PORT   465（SSL）
 *   SMTP_USER   发件邮箱
 *   SMTP_PASS   SMTP 授权码（QQ 邮箱：设置-账号-开启 SMTP 获取授权码）
 *   SMTP_FROM   可选，默认同 SMTP_USER
 *
 * 生命周期与短信通道一致：6 位数字、10 分钟有效、5 次失败作废、
 * 一次性消费、哈希存储（会话密钥加盐）、重发覆盖旧码。
 */

import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { sessionSecret } from './session';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

interface CodeEntry {
  hash: string;
  expires: number;
  attempts: number;
}

const store = new Map<string, CodeEntry>();

function smtpConfig() {
  const host = process.env.SMTP_HOST || '';
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const from = process.env.SMTP_FROM || user;
  const ok = Boolean(host && user && pass);
  return { host, port, user, pass, from, ok };
}

export function emailLoginConfigured(): boolean {
  return smtpConfig().ok;
}

function hashCode(email: string, code: string): string {
  const salt = sessionSecret() ?? 'fin-email-fallback-salt';
  return createHash('sha256').update(`${salt}:${email}:${code}`).digest('hex');
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

/** 发送验证码邮件；失败必须抛错 */
export async function sendEmailCode(email: string): Promise<void> {
  const cfg = smtpConfig();
  if (!cfg.ok) throw new Error('邮箱验证服务未配置');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const minutes = Math.round(CODE_TTL_MS / 60000);
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  try {
    await transporter.sendMail({
      from: `"FinTerminal" <${cfg.from}>`,
      to: email,
      subject: `FinTerminal 登录验证码：${code}`,
      text: `您的登录验证码是 ${code}，${minutes} 分钟内有效。如非本人操作请忽略本邮件。`,
      html: `<p>您的登录验证码是 <strong style="font-size:18px;letter-spacing:2px">${code}</strong>，${minutes} 分钟内有效。</p><p>如非本人操作请忽略本邮件。</p>`,
    });
  } finally {
    transporter.close();
  }
  store.set(email, {
    hash: hashCode(email, code),
    expires: Date.now() + CODE_TTL_MS,
    attempts: 0,
  });
}

/** 服务端校验；成功返回稳定不透明用户 ID */
export async function verifyEmailCode(
  email: string,
  code: string,
): Promise<{ id: string; email: string }> {
  if (!smtpConfig().ok) throw new Error('邮箱验证服务未配置');
  const entry = store.get(email);
  if (!entry) throw new Error('验证码不存在或已过期，请重新获取');
  if (Date.now() > entry.expires) {
    store.delete(email);
    throw new Error('验证码已过期，请重新获取');
  }
  if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
    store.delete(email);
    throw new Error('错误次数过多，验证码已作废，请重新获取');
  }
  entry.attempts += 1;
  if (entry.hash !== hashCode(email, code)) throw new Error('验证码错误');
  store.delete(email); // 一次性消费
  const id =
    'u' + createHash('sha256').update(`fin-user:${email}`).digest('hex').slice(0, 24);
  return { id, email };
}
