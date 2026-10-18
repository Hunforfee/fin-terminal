export const DEFAULT_AI_URL = 'https://api.deepseek.com/v1/chat/completions';
export const DEFAULT_AI_MODEL = 'deepseek-chat';

/** Credentials and their destination belong to the same configuration source. */
export function aiConnection(
  headers: Pick<Headers, 'get'>,
  config = process.env,
): { key: string; url: string; model: string } {
  const ownKey = headers.get('x-ai-key')?.trim();
  // A visitor must never redirect a server-owned key to an arbitrary endpoint.
  const rawUrl =
    (ownKey ? headers.get('x-ai-url')?.trim() : null) ||
    config.AI_API_URL ||
    DEFAULT_AI_URL;
  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    throw new Error('AI 接口地址无效');
  }
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error('AI 接口地址无效');
  return {
    key: ownKey || config.AI_API_KEY || '',
    url: endpoint.href,
    model:
      headers.get('x-ai-model')?.trim() || config.AI_MODEL || DEFAULT_AI_MODEL,
  };
}
