import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRetryableAssistantError, type AssistantMessage } from '@earendil-works/pi-ai';
import { describeFailure, describeRejection } from '../src/runtime/provider-rejection.ts';

test('a request that broke off names the provider, hides its raw text and does not read as retryable', () => {
  const text = describeFailure('xai');
  assert.equal(
    text,
    "xAI's answer broke off before it finished. It is counted at its maximum cost. Send your message again to continue.",
  );
  assert.equal(isRetryableAssistantError({ stopReason: 'error', errorMessage: text } as AssistantMessage), false);
});

test('a rejected request quotes the provider message from its JSON body', () => {
  assert.equal(
    describeRejection('xai', 400, '{"error":"Argument not supported: background"}'),
    'xAI rejected the request: Argument not supported: background',
  );
});
