import test from 'node:test';
import assert from 'node:assert/strict';

import { createAIClient, resolveAIConfig } from '../pipeline/process.js';

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test('resolveAIConfig requires a local OpenAI-compatible endpoint', () => {
  assert.throws(() => resolveAIConfig({}), /AI_BASE_URL/);
});

test('resolveAIConfig requires a local model and drops provider-specific extras', () => {
  assert.throws(
    () => resolveAIConfig({ AI_BASE_URL: 'http://127.0.0.1:8080/v1' }),
    /AI_MODEL/,
  );
  const config = resolveAIConfig({
    AI_BASE_URL: 'http://127.0.0.1:8080/v1/',
    AI_MODEL: 'qwen3-8b-4bit',
  });
  assert.equal(config.provider, 'openai');
  assert.equal(config.baseURL, 'http://127.0.0.1:8080/v1');
  assert.equal(config.model, 'qwen3-8b-4bit');
  assert.equal(config.needsKey, false);
  assert.deepEqual(config.bodyExtras, {});
});

test('resolveAIConfig rejects non-local providers and non-http(s) base URLs', () => {
  assert.throws(() => resolveAIConfig({ AI_PROVIDER: 'anthropic' }), /AI_PROVIDER/);
  assert.throws(
    () => resolveAIConfig({ AI_BASE_URL: 'https://api.openai.com/v1', AI_MODEL: 'm' }),
    /本机回环地址/,
  );
  assert.throws(
    () => resolveAIConfig({ AI_BASE_URL: 'ftp://127.0.0.1:8080/v1', AI_MODEL: 'm' }),
    /http/,
  );
});

test('resolveAIConfig honours AI_TIMEOUT_MS and AI_CONCURRENCY overrides', () => {
  const config = resolveAIConfig({
    AI_BASE_URL: 'http://127.0.0.1:8080/v1',
    AI_MODEL: 'qwen3-8b-4bit',
    AI_TIMEOUT_MS: '600000',
    AI_CONCURRENCY: '1',
  });
  assert.equal(config.timeoutMs, 600000);
  assert.equal(config.concurrency, 1);
  const clamped = resolveAIConfig({
    AI_BASE_URL: 'http://127.0.0.1:8080/v1',
    AI_MODEL: 'qwen3-8b-4bit',
    AI_CONCURRENCY: '0',
  });
  assert.equal(clamped.concurrency, 1);
});

test('createAIClient posts only the local OpenAI-compatible body shape', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return jsonResponse({ choices: [{ message: { content: '中文总结' } }] });
  };

  const local = createAIClient(
    resolveAIConfig({
      AI_BASE_URL: 'http://127.0.0.1:8080/v1',
      AI_MODEL: 'qwen3-8b-4bit',
      AI_API_KEY: 'k-test',
    }),
    { fetchImpl, sleepMs: 0 },
  );
  assert.equal(await local([{ role: 'user', content: 'hi' }]), '中文总结');
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer k-test');
  assert.equal(calls[0].body.thinking, undefined);
  assert.equal(calls[0].body.model, 'qwen3-8b-4bit');
  assert.equal(calls[0].body.temperature, 0.3);
});

test('createAIClient retries once and rejects empty output', async () => {
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts === 1) throw new Error('boom');
    return jsonResponse({ choices: [{ message: { content: '重试成功' } }] });
  };
  const localConfig = {
    AI_BASE_URL: 'http://127.0.0.1:8080/v1',
    AI_MODEL: 'qwen3-8b-4bit',
  };
  const client = createAIClient(resolveAIConfig(localConfig), { fetchImpl: flaky, sleepMs: 0 });
  assert.equal(await client([{ role: 'user', content: 'hi' }]), '重试成功');
  assert.equal(attempts, 2);

  const empty = createAIClient(resolveAIConfig(localConfig), {
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '   ' } }] }),
    sleepMs: 0,
  });
  await assert.rejects(() => empty([{ role: 'user', content: 'hi' }]), /空/);
});
