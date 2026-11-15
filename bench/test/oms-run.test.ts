import assert from 'node:assert/strict';
import { test } from 'node:test';
import { omsWebArgs, onlineStamp } from '../src/oms-run.ts';
import { lostSubscriptionAuth } from '../src/external.ts';

const OMS = 'oms3-web:gpt-sol';

test('the OMS cell needs the oms-search stack and refuses bring-your-own search keys', () => {
  assert.throws(() => omsWebArgs(OMS, {}), /OMS_SEARCH_TOKEN/);
  assert.throws(() => omsWebArgs(OMS, { OMS_SEARCH_TOKEN: 't', OMS_SEARCH_URL: 'http://search.example.com' }), /OMS_SEARCH_URL/);
  assert.throws(() => omsWebArgs(OMS, { OMS_SEARCH_TOKEN: 't', OMS_SEARCH_URL: 'https://search.example.com', EXA_API_KEY: 'k' }), /EXA_API_KEY/);
  assert.deepEqual(omsWebArgs(OMS, { OMS_SEARCH_TOKEN: 't', OMS_SEARCH_URL: 'https://search.example.com' }), ['--web']);
  assert.deepEqual(omsWebArgs('codex:gpt-sol', {}), []);
});

test('the online label follows --web and a mismatch refuses before the run', () => {
  assert.deepEqual(onlineStamp(OMS, ['--web']), { online: 'web + Solana MCP' });
  assert.throws(() => onlineStamp(OMS, []), /needs --web/);
});

test('Claude Code losing its staged login mid-run is auth loss, read from its own error result only', () => {
  const lost = JSON.stringify({ type: 'result', is_error: true, result: 'OAuth token has expired. Please run /login' });
  assert.equal(lostSubscriptionAuth(lost), true);
  assert.equal(lostSubscriptionAuth(JSON.stringify({ type: 'result', is_error: false, result: 'OAuth token has expired' })), false);
  assert.equal(lostSubscriptionAuth('tool output mentioning Not logged in'), false);
});
