import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFailure, describeRejection } from '../src/runtime/provider-rejection.ts';

test('a failed request names the provider and its reason, never a key or raw JSON', () => {
  assert.equal(
    describeFailure('xai', 'xai API error (500): upstream timed out\nfor key xai-ABCDEFGHIJKLMNOP'),
    'xAI request failed: xai API error (500): upstream timed out for key [key]. Send your message again to retry.',
  );
  assert.equal(describeFailure('openai', undefined), 'OpenAI request failed. Send your message again to retry.');
});

test('a rejected request quotes the provider message from its JSON body', () => {
  assert.equal(
    describeRejection('xai', 400, '{"error":"Argument not supported: background"}'),
    'xAI rejected the request: Argument not supported: background',
  );
});
