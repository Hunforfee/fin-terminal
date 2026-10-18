/**
 * 腾讯云短信（SMS）验证码 Provider —— 手机号登录的真实实现。
 *
 * 环境变量（全部必需才启用）：
 *   SMS_SECRET_ID     腾讯云 API 密钥 SecretId
 *   SMS_SECRET_KEY    腾讯云 API 密钥 SecretKey
 *   SMS_SDK_APP_ID    短信应用 SDK AppID（控制台创建短信应用后获得）
 *   SMS_SIGN_NAME     已审批通过的短信签名
 *   SMS_TEMPLATE_ID   已审批通过的模板 ID，模板需含两个参数：{1}=验证码 {2}=有效期分钟数
 *   SMS_REGION        可选，默认 ap-guangzhou
 *
 * 验证码生命周期（服务端管理）：
 *   - 6 位数字，10 分钟有效；同一手机号重发覆盖旧码
 *   - 校验最多 5 次失败后作废；成功校验立即消费（一次性）
 *   - 发送频率限制由 /api/auth/send-code 路由层的 allowAttempt 控制
 *   - 存储为进程内哈希（sha256 + 会话密钥盐），不存明文、不落日志
 *
 * 测试说明：未配置环境变量时 phoneLoginConfigured() 返回 false，登录按钮禁用、
 * 路由返回 503，与 WORKBUDDY_AUTH.md 的「无固定验证码/无后门」契约一致。
 */

import { createHash, randomInt } from 'node:crypto';
import { sessionSecret } from './session';
import { tc3Authorization } from './tc3';

const SMS_HOST = 'sms.tencentcloudapi.com';
const SMS_SERVICE = 'sms';
const SMS_ACTION = 'SendSms';
const SMS_VERSION = '2021-01-11';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

interface CodeEntry {
  hash: string;
  expires: number;
  attempts: number;
}

/** 进程内验证码存储（当前部署为单实例；多实例部署需换 Redis） */
const store = new Map<string, CodeEntry>();

function smsConfig() {
  const secretId = process.env.SMS_SECRET_ID || '';
  const secretKey = process.env.SMS_SECRET_KEY || '';
  const sdkAppId = process.env.SMS_SDK_APP_ID || '';
  const signName = process.env.SMS_SIGN_NAME || '';
  const templateId = process.env.SMS_TEMPLATE_ID || '';
  const ok = Boolean(
    secretId && secretKey && sdkAppId && signName && templateId,
  );
  return { secretId, secretKey, sdkAppId, signName, templateId, ok };
}

export function phoneLoginConfigured(): boolean {
  return smsConfig().ok;
}

/** 验证码哈希：以会话密钥为盐，未配置密钥时退化为固定盐（仅影响盐） */
function hashCode(phone: string, code: string): string {
  const salt = sessionSecret() ?? 'fin-sms-fallback-salt';
  return createHash('sha256').update(`${salt}:${phone}:${code}`).digest('hex');
}

/** 腾讯云 API v3 签名（TC3-HMAC-SHA256），无 SDK 依赖 */
function tc3Headers(
  secretId: string,
  secretKey: string,
  payload: string,
  timestamp: number,
): Record<string, string> {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    Host: SMS_HOST,
    'X-TC-Action': SMS_ACTION,
    'X-TC-Version': SMS_VERSION,
    'X-TC-Region': process.env.SMS_REGION || 'ap-guangzhou',
    'X-TC-Timestamp': String(timestamp),
    Authorization: tc3Authorization({
      secretId,
      secretKey,
      host: SMS_HOST,
      service: SMS_SERVICE,
      action: SMS_ACTION,
      payload,
      timestamp,
    }),
  };
}

/** 生成并发送验证码；任何发送失败都必须抛错（路由层统一兜底提示） */
export async function sendPhoneCode(phone: string): Promise<void> {
  const cfg = smsConfig();
  if (!cfg.ok) throw new Error('短信服务未配置');
  const code = String(randomInt(100000, 1000000));
  const payload = JSON.stringify({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: cfg.sdkAppId,
    SignName: cfg.signName,
    TemplateId: cfg.templateId,
    TemplateParamSet: [code, String(Math.round(CODE_TTL_MS / 60000))],
  });
  const res = await fetch(`https://${SMS_HOST}/`, {
    method: 'POST',
    headers: tc3Headers(
      cfg.secretId,
      cfg.secretKey,
      payload,
      Math.floor(Date.now() / 1000),
    ),
    body: payload,
    signal: AbortSignal.timeout(10000),
  });
  const j = (await res.json().catch(() => null)) as {
    Response?: {
      Error?: { Message?: string };
      SendStatusSet?: { Code?: string; Message?: string }[];
    };
  } | null;
  const apiErr = j?.Response?.Error;
  const sendErr = j?.Response?.SendStatusSet?.[0];
  if (!res.ok || apiErr || sendErr?.Code !== 'Ok') {
    const msg = apiErr?.Message ?? sendErr?.Message ?? `HTTP ${res.status}`;
    throw new Error(`短信发送失败：${msg}`);
  }
  // 重发覆盖旧码，重置尝试次数
  store.set(phone, {
    hash: hashCode(phone, code),
    expires: Date.now() + CODE_TTL_MS,
    attempts: 0,
  });
}

/** 服务端校验验证码；成功返回稳定不透明用户 ID（手机号哈希，不可反推） */
export async function verifyPhoneCode(
  phone: string,
  code: string,
): Promise<{ id: string; phone: string }> {
  if (!smsConfig().ok) throw new Error('短信服务未配置');
  const entry = store.get(phone);
  if (!entry) throw new Error('验证码不存在或已过期，请重新获取');
  if (Date.now() > entry.expires) {
    store.delete(phone);
    throw new Error('验证码已过期，请重新获取');
  }
  if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
    store.delete(phone);
    throw new Error('错误次数过多，验证码已作废，请重新获取');
  }
  entry.attempts += 1;
  if (entry.hash !== hashCode(phone, code)) throw new Error('验证码错误');
  store.delete(phone); // 一次性消费
  const id =
    'u' +
    createHash('sha256').update(`fin-user:${phone}`).digest('hex').slice(0, 24);
  return { id, phone };
}
