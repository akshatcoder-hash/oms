import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { omsSystemPrompt, knowledgeHint } from '../src/runtime/session.ts';
import { WEB_PROMPT, WEB_PROMPT_NO_KNOWLEDGE } from '../src/runtime/web.ts';
import { KNOWLEDGE_RULE } from '../src/runtime/knowledge-service.ts';
import { programReferenceIndex } from '../src/runtime/program-reference.ts';
import { OMS_REFERENCE_PREFIX } from '../src/runtime/knowledge.ts';
import { CLAUDE_CAPPED_WORK } from '../src/runtime/system-prompt.ts';

// The model-facing prompt text was tuned through benchmark rounds and also keeps provider prompt caches warm.
// Any change here, including whitespace, must be a deliberate decision: re-measure, then update these hashes.
const config = { endpoint: 'https://example.invalid/mcp', token: 't' };
const locked: Record<string, { bytes: number; sha256: string; text: () => string }> = {
  claude_capped_work: {
    bytes: 1158,
    sha256: 'f00d7b01902e2448f3a5caf40702ae2d606fd4d7a3322eef1e2624c8e97dfbf8',
    text: () => CLAUDE_CAPPED_WORK,
  },
  system_plain: {
    bytes: 25329,
    sha256: 'ac13e74c2a77a64ea20b71794168e9f9b6622026e601c58b66e00f667de04c68',
    text: () => omsSystemPrompt('/work', 'ok'),
  },
  system_tail: {
    bytes: 25361,
    sha256: '63b56b40ba0508871eabbe423af2fb10bae3c628b5cae117573738f71a375919',
    text: () => omsSystemPrompt('/repo/task', 'toolchain: anchor 0.32.1', '\nTAIL'),
  },
  hint_on: {
    bytes: 356,
    sha256: 'e4323d2f40bd4b40b7b45d754f68261982c0d673af6ae463a146f2fa47859f02',
    text: () => knowledgeHint({ knowledgeHint: true }, config),
  },
  hint_off: {
    bytes: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    text: () => knowledgeHint({ knowledgeHint: false }, config),
  },
  hint_nocfg: {
    bytes: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    text: () => knowledgeHint({ knowledgeHint: true }, undefined),
  },
  web: {
    bytes: 484,
    sha256: 'a314fc09e52c375c967083faaf00fe197db6e344dcfba36bcfea0c32ae014c0c',
    text: () => WEB_PROMPT,
  },
  web_no_knowledge: {
    bytes: 464,
    sha256: '4db546295ca43beca4e8782071d5245925386497ae64868e0865cedea9d4fac5',
    text: () => WEB_PROMPT_NO_KNOWLEDGE,
  },
  knowledge_rule: {
    bytes: 384,
    sha256: '566c96424f838f8fc46804c4ed722f563bb6b17aeace8c393e213f033d01e6f3',
    text: () => KNOWLEDGE_RULE,
  },
  reference_prefix: {
    bytes: 4050,
    sha256: '4b810a440bcdffd01615b7b1617024d15f08dd4580307a07bb22910d61ccd78b',
    text: () => OMS_REFERENCE_PREFIX,
  },
  program_index: {
    bytes: 17045,
    sha256: 'eea749e10c2b87ca7d072cbb4661538e8317e0052320bbef42dc55363fef219a',
    text: () => programReferenceIndex(),
  },
};

for (const [name, expected] of Object.entries(locked)) {
  test(`prompt lock: ${name} is byte-identical to the tuned text`, () => {
    const text = expected.text();
    assert.equal(Buffer.byteLength(text), expected.bytes);
    assert.equal(createHash('sha256').update(text).digest('hex'), expected.sha256);
  });
}
