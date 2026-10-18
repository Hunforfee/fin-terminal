import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-modules.mjs';
const { aiConnection, DEFAULT_AI_URL } = await load('aiConnection');

test('a custom destination cannot capture the server API key, including blank client keys', () => {
  const server = {
    AI_API_KEY: 'test-server-key',
    AI_API_URL: 'https://trusted.example/v1/chat/completions',
  };
  for (const key of [null, '', ' ']) {
    const headers = new Headers({
      'x-ai-url': 'https://untrusted.example/v1/chat/completions',
    });
    if (key !== null) headers.set('x-ai-key', key);
    assert.equal(aiConnection(headers, server).url, server.AI_API_URL);
    assert.equal(aiConnection(headers, server).key, server.AI_API_KEY);
  }
  assert.equal(
    aiConnection(new Headers({ 'x-ai-url': 'https://untrusted.example' }), {
      AI_API_KEY: 'test-server-key',
    }).url,
    DEFAULT_AI_URL,
  );
});

test('visitors retain their own key and custom HTTP-compatible endpoint and model', () => {
  const actual = aiConnection(
    new Headers({
      'x-ai-key': 'own-test-key',
      'x-ai-url': 'http://localhost:11434/v1/chat/completions',
      'x-ai-model': 'own-model',
    }),
    { AI_API_KEY: 'test-server-key', AI_API_URL: 'https://trusted.example' },
  );
  assert.deepEqual(actual, {
    key: 'own-test-key',
    url: 'http://localhost:11434/v1/chat/completions',
    model: 'own-model',
  });
  for (const url of [
    'file:///private',
    'ftp://example.org',
    'bad URL',
    'https://user:pass@example.org',
  ])
    assert.throws(
      () =>
        aiConnection(
          new Headers({ 'x-ai-key': 'own-test-key', 'x-ai-url': url }),
          {},
        ),
      /地址无效/,
    );
});
