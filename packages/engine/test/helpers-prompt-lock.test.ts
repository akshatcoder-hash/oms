import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { BUILT_IN_AGENTS } from '../src/runtime/helpers/agents.ts';
import { delegationSection, SUBAGENT_PROMPT } from '../src/runtime/helpers/prompt.ts';

// The text the chat's model gets about helpers. It is appended after the locked chat prompt, so chat-prompt-lock is unchanged.
// A change here must be deliberate: update the hashes with it.
const locked = {
  subagent_prompt: {
    bytes: 726,
    sha256: '908af06609b9bd463da6f3802a4ee31ca6350a870bc6ea82c63395fdf24ca979',
    text: () => SUBAGENT_PROMPT,
  },
  with_built_ins: {
    bytes: 918,
    sha256: '8a7466078e0907e51ef902dc4249fbf62aeba379fbb5c56b4a5653c12050778b',
    text: () => delegationSection(BUILT_IN_AGENTS),
  },
};

for (const [name, expected] of Object.entries(locked)) {
  test(`helper prompt lock: ${name} is byte-identical to the written text`, () => {
    const text = expected.text();
    assert.equal(Buffer.byteLength(text), expected.bytes);
    assert.equal(createHash('sha256').update(text).digest('hex'), expected.sha256);
  });
}
