import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { omsChatPrompt } from '../src/runtime/system-prompt.ts';

// The chat prompt shares the reference prefix and program index with the pinned prompt and adds its own paragraph.
// Any change here, including whitespace, must be a deliberate decision: re-measure, then update these hashes.
const locked: Record<string, { bytes: number; sha256: string; text: () => string }> = {
  chat_plain: {
    bytes: 23105,
    sha256: 'ef385c8523b2be746b82b595041251e98a5274d5704a938b88ef39e306d8ae88',
    text: () => omsChatPrompt('/work', 'ok'),
  },
  chat_tail: {
    bytes: 23140,
    sha256: 'fede1e9d0aaac77734781d9e5605f4d291522a21b2b719cba27120eba45440a8',
    text: () => omsChatPrompt('/home/dev/app', 'toolchain: anchor 0.32.1', '\nTAIL'),
  },
};

for (const [name, expected] of Object.entries(locked)) {
  test(`chat prompt lock: ${name} is byte-identical to the tuned text`, () => {
    const text = expected.text();
    assert.equal(Buffer.byteLength(text), expected.bytes);
    assert.equal(createHash('sha256').update(text).digest('hex'), expected.sha256);
  });
}
