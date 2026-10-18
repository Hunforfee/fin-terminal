/**
 * WorkBuddy integration boundary. Implement ONLY after the hosting application's
 * actual phone-auth service is enabled. Do not use WorkBuddy desktop login APIs.
 * No default URL, fixed OTP, debug login, or client-supplied identity is accepted.
 * See WORKBUDDY_AUTH.md for the contract and verification checklist.
 */
export function phoneLoginConfigured(): boolean {
  return false;
}
export async function sendPhoneCode(_phone: string): Promise<void> {
  throw new Error('短信验证码服务尚未接入');
}
export async function verifyPhoneCode(
  _phone: string,
  _code: string,
): Promise<{ id: string; phone: string }> {
  throw new Error('短信验证码服务尚未接入');
}
