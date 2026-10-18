import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { load } from './load-modules.mjs';
const { tc3CanonicalRequest, tc3Authorization } = await load('auth/tc3');
const { sendPhoneCode, verifyPhoneCode } = await load('auth/phoneProvider');

test('TC3 request matches the official Tencent canonical SHA256 example and UTC scope', () => {
  // Official reference: https://cloud.tencent.com/document/product/213/30654
  const payload =
    '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
  const canonical = tc3CanonicalRequest(
    'cvm.tencentcloudapi.com',
    'DescribeInstances',
    payload,
  );
  assert.equal(
    createHash('sha256').update(payload).digest('hex'),
    '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064',
  );
  assert.equal(
    createHash('sha256').update(canonical).digest('hex'),
    '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84',
  );
  const sign = (key, value) => createHmac('sha256', key).update(value).digest();
  const key = sign(
    sign(sign('TC3test-secret', '2019-02-25'), 'cvm'),
    'tc3_request',
  );
  const signature = createHmac('sha256', key)
    .update(
      'TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84',
    )
    .digest('hex');
  assert.equal(
    tc3Authorization({
      secretId: 'test-id',
      secretKey: 'test-secret',
      host: 'cvm.tencentcloudapi.com',
      service: 'cvm',
      action: 'DescribeInstances',
      payload,
      timestamp: 1551113065,
    }),
    `TC3-HMAC-SHA256 Credential=test-id/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
  );
});

test('mock SMS requires an explicit provider success and consumes an unpredictable code only once', async () => {
  const settings = {
    SMS_SECRET_ID: 'test-id',
    SMS_SECRET_KEY: 'test-secret',
    SMS_SDK_APP_ID: 'test-app',
    SMS_SIGN_NAME: 'test-sign',
    SMS_TEMPLATE_ID: 'test-template',
    AUTH_SESSION_SECRET: 'test-session-secret-long-enough-0123456789012',
  };
  const previous = Object.fromEntries(
    Object.keys(settings).map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  let sentCode;
  try {
    Object.assign(process.env, settings);
    globalThis.fetch = async () =>
      new Response('{"Response":{}}', { status: 200 });
    await assert.rejects(sendPhoneCode('13800000000'), /短信发送失败/);
    await assert.rejects(verifyPhoneCode('13800000000', '123456'), /不存在/);
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://sms.tencentcloudapi.com/');
      const params = JSON.parse(init.body);
      sentCode = params.TemplateParamSet[0];
      assert.match(sentCode, /^\d{6}$/);
      const timestamp = Number(init.headers['X-TC-Timestamp']);
      assert.equal(
        init.headers.Authorization,
        tc3Authorization({
          secretId: settings.SMS_SECRET_ID,
          secretKey: settings.SMS_SECRET_KEY,
          host: 'sms.tencentcloudapi.com',
          service: 'sms',
          action: 'SendSms',
          payload: init.body,
          timestamp,
        }),
      );
      return new Response('{"Response":{"SendStatusSet":[{"Code":"Ok"}]}}', {
        status: 200,
      });
    };
    await sendPhoneCode('13800000000');
    const identity = await verifyPhoneCode('13800000000', sentCode);
    assert.equal(identity.phone, '13800000000');
    await assert.rejects(verifyPhoneCode('13800000000', sentCode), /不存在/);
    await sendPhoneCode('13900000000');
    const wrong = sentCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await assert.rejects(verifyPhoneCode('13900000000', wrong), /错误/);
    await assert.rejects(verifyPhoneCode('13900000000', sentCode), /已作废/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
