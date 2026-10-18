import { createHash, createHmac } from 'node:crypto';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** API 3.0 规范：https://cloud.tencent.com/document/product/213/30654 */
export function tc3CanonicalRequest(
  host: string,
  action: string,
  payload: string,
): string {
  const headers = `content-type:application/json; charset=utf-8\nhost:${host.toLowerCase()}\nx-tc-action:${action.toLowerCase()}\n`;
  return [
    'POST',
    '/',
    '',
    headers,
    'content-type;host;x-tc-action',
    sha256(payload),
  ].join('\n');
}

export function tc3Authorization(input: {
  secretId: string;
  secretKey: string;
  host: string;
  service: string;
  action: string;
  payload: string;
  timestamp: number;
}): string {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${input.service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    input.timestamp,
    scope,
    sha256(tc3CanonicalRequest(input.host, input.action, input.payload)),
  ].join('\n');
  const kDate = createHmac('sha256', `TC3${input.secretKey}`)
    .update(date)
    .digest();
  const kService = createHmac('sha256', kDate).update(input.service).digest();
  const kSigning = createHmac('sha256', kService)
    .update('tc3_request')
    .digest();
  const signature = createHmac('sha256', kSigning)
    .update(stringToSign)
    .digest('hex');
  return `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`;
}
