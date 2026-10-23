/**
 * 安全 JSON 取数助手
 *
 * 背景：公网代理层偶发返回空 body（重启后连接抖动、524 超时页等），
 * 直接 `response.json()` 会抛出 "Unexpected end of JSON input" 这类
 * 原始 JS 错误并暴露给终端用户。这里统一收敛为可读错误信息，
 * 并保留原有 ok/error 协议结构，调用方逻辑不变。
 */

export class FetchJsonError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FetchJsonError';
    this.status = status;
  }
}

/** 取 JSON；空 body / 非 JSON / 非 2xx 一律抛出带可读信息的 FetchJsonError（AbortError 原样抛出，保留取消语义） */
export async function fetchJson<T = any>(input: string, init?: RequestInit): Promise<T> {
  const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new FetchJsonError('网络请求失败，请检查连接后重试', 0);
  }
  let text = '';
  try {
    text = await response.text();
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new FetchJsonError('服务响应读取失败，请稍后重试', response.status);
  }
  if (!response.ok) {
    let msg = `服务响应异常（HTTP ${response.status}）`;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === 'string' && parsed.error) msg = parsed.error;
    } catch { /* 非 JSON 错误页，用通用文案 */ }
    throw new FetchJsonError(msg, response.status);
  }
  if (!text.trim()) {
    throw new FetchJsonError('服务返回了空响应，请稍后重试', response.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FetchJsonError('服务返回的数据无法解析，请稍后重试', response.status);
  }
}
