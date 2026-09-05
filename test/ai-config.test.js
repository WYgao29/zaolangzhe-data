import test from 'node:test';
import assert from 'node:assert/strict';

import { createAIClient, resolveAIConfig } from '../pipeline/process.js';

const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test('resolveAIConfig defaults to the Zhipu cloud provider', () => {
  const config = resolveAIConfig({});
  assert.equal(config.provider, 'zhipu');
  assert.equal(config.baseURL, ZHIPU_BASE);
  assert.equal(config.model, 'glm-5.3-flash');
  assert.equal(config.apiKey, '');
  assert.equal(config.needsKey, true);
  assert.deepEqual(config.bodyExtras, { thinking: { type: 'enabled', length: 'low' } });
  assert.equal(config.timeoutMs, 180000);
  assert.equal(config.concurrency, 2);
});

test('resolveAIConfig keeps legacy ZHIPU_MODEL and ZHIPU_API_KEY env names', () => {
  const config = resolveAIConfig({ ZHIPU_MODEL: 'glm-5.3', ZHIPU_API_KEY: 'k-legacy' });
  assert.equal(config.model, 'glm-5.3');
  assert.equal(config.apiKey, 'k-legacy');
});

test('resolveAIConfig openai provider requires base URL and model, drops thinking extras', () => {
  assert.throws(() => resolveAIConfig({ AI_PROVIDER: 'openai' }), /AI_BASE_URL/);
  assert.throws(
    () => resolveAIConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:8080/v1' }),
    /AI_MODEL/,
  );
  const config = resolveAIConfig({
    AI_PROVIDER: 'openai',
    AI_BASE_URL: 'http://127.0.0.1:8080/v1/',
    AI_MODEL: 'qwen3-8b-4bit',
  });
  assert.equal(config.provider, 'openai');
  assert.equal(config.baseURL, 'http://127.0.0.1:8080/v1');
  assert.equal(config.model, 'qwen3-8b-4bit');
  assert.equal(config.needsKey, false);
  assert.deepEqual(config.bodyExtras, {});
});

test('resolveAIConfig rejects unknown providers and non-http(s) base URLs', () => {
  assert.throws(() => resolveAIConfig({ AI_PROVIDER: 'anthropic' }), /AI_PROVIDER/);
  assert.throws(
    () => resolveAIConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'ftp://127.0.0.1:8080/v1', AI_MODEL: 'm' }),
    /http/,
  );
});

test('resolveAIConfig honours AI_TIMEOUT_MS and AI_CONCURRENCY overrides', () => {
  const config = resolveAIConfig({ AI_TIMEOUT_MS: '600000', AI_CONCURRENCY: '1' });
  assert.equal(config.timeoutMs, 600000);
  assert.equal(config.concurrency, 1);
  const clamped = resolveAIConfig({ AI_CONCURRENCY: '0' });
  assert.equal(clamped.concurrency, 1);
});

test('createAIClient posts to the configured endpoint with provider body shape', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return jsonResponse({ choices: [{ message: { content: '中文总结' } }] });
  };

  const zhipu = createAIClient(resolveAIConfig({ ZHIPU_API_KEY: 'k-test' }), { fetchImpl, sleepMs: 0 });
  assert.equal(await zhipu([{ role: 'user', content: 'hi' }]), '中文总结');
  assert.equal(calls[0].url, `${ZHIPU_BASE}/chat/completions`);
  assert.equal(calls[0].headers.Authorization, 'Bearer k-test');
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled', length: 'low' });
  assert.equal(calls[0].body.model, 'glm-5.3-flash');
  assert.equal(calls[0].body.temperature, 0.3);

  const local = createAIClient(
    resolveAIConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://127.0.0.1:8080/v1', AI_MODEL: 'qwen3-8b-4bit' }),
    { fetchImpl, sleepMs: 0 },
  );
  calls.length = 0;
  assert.equal(await local([{ role: 'user', content: 'hi' }]), '中文总结');
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].body.thinking, undefined);
  assert.equal(calls[0].body.model, 'qwen3-8b-4bit');
});

test('createAIClient retries once and rejects empty output', async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts === 1) throw new Error('boom');
    return jsonResponse({ choices: [{ message: { content: '重试成功' } }] });
  };
  const client = createAIClient(resolveAIConfig({}), { fetchImpl: flaky, sleepMs: 0 });
  assert.equal(await client([{ role: 'user', content: 'hi' }]), '重试成功');
  assert.equal(attempts, 2);

  const empty = createAIClient(resolveAIConfig({}), {
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '   ' } }] }),
    sleepMs: 0,
  });
  await assert.rejects(() => empty([{ role: 'user', content: 'hi' }]), /空/);
});
