import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, Model, Usage } from '@earendil-works/pi-ai';
import { MODEL_CATALOG } from '../src/models/catalog.ts';
import { normalizePiUsage, enforceCachePolicy, modelReservationBound, isClaudeCodeModel } from '../src/models/usage.ts';
const spec = MODEL_CATALOG['mimo-flash'];
const model: Model<Api> = { id: spec.modelId, name: 'MiMo', provider: spec.provider, api: spec.api, baseUrl: spec.baseUrl, contextWindow: spec.effectiveContextWindow, maxTokens: spec.maxOutputTokens, reasoning: true, input: ['text'], cost: { input:.14,output:.28,cacheRead:.0028,cacheWrite:0 } };
const usage: Usage = { input:10,output:5,cacheRead:3,cacheWrite:2,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
test('documented Xiaomi free writes settle only at the pinned model/provider/endpoint', () => {
  assert.equal(normalizePiUsage(model,usage)?.spendMicroUsd,3);
  assert.equal(normalizePiUsage({...model,baseUrl:'https://untrusted.invalid'},usage),null);
  assert.equal(normalizePiUsage({...model,id:'arbitrary-free'},usage),null);
  assert.equal(normalizePiUsage(model,{...usage,cacheWrite1h:1}),null);
});
test('OpenAI cache policy rejects post-hook lifetimes including nested breakpoints', () => {
  const openai = { ...model, provider:'openai',api:'openai-responses',baseUrl:'https://api.openai.com/v1',id:'gpt-6.1-sol' };
  const payload: Record<string,unknown> = {model:openai.id,input:[]};
  enforceCachePolicy(openai,payload);
  assert.deepEqual(payload.prompt_cache_options,{ttl:'30m'});
  for(const override of [ {prompt_cache_options:{ttl:'12h'}}, {input:[{content:[{type:'text',text:'x',prompt_cache_breakpoint:{ttl:'12h'}}]}]} ]) {
    assert.throws(()=>enforceCachePolicy(openai,{model:openai.id,...override}),/cache/i);
  }
});

test('native Claude Code reserves its full output capacity only for the installed connector identity', () => {
  const native: Model<Api> = { ...model, provider: 'claude-code', api: 'claude-code', baseUrl: 'claude-code://local',
    id: 'sonnet', contextWindow: 1_000, maxTokens: 100,
    cost: { input: 2, output: 6, cacheRead: 1, cacheWrite: 3 } };
  assert.deepEqual(modelReservationBound(native, 5), { tokens: 1_100, spendMicroUsd: 4_600 });
  for (const alias of ['sonnet', 'opus', 'haiku']) assert.equal(isClaudeCodeModel({ ...native, id: alias }), true);
  for (const candidate of [
    { ...native, provider: 'custom' }, { ...native, api: 'custom' },
    { ...native, baseUrl: 'https://example.test' }, { ...native, id: 'unrecognized' },
    { ...native, contextWindow: 99 },
  ]) assert.equal(modelReservationBound(candidate, 5), null);
  assert.equal(modelReservationBound({ ...native, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 5), null);
});
