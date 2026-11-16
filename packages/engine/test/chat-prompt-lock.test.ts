import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { omsChatPrompt } from '../src/runtime/system-prompt.ts';

// The chat prompt shares the reference prefix and program index with the pinned prompt and adds its own paragraph.
// Any change here, including whitespace, must be a deliberate decision: re-measure, then update these hashes.
const locked: Record<string, { bytes: number; sha256: string; text: () => string }> = {
  chat_plain: {
    bytes: 23293,
    sha256: 'ac9cbcc87356199d9fd2367163f6812df583cc9f0f8dd4750ae60cff28124958',
    text: () => omsChatPrompt('/work', 'ok'),
  },
  chat_tail: {
    bytes: 23328,
    sha256: '9df7677d508065bfd2df3b68b118886b4b07c186d8d5476e63221da615321aef',
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
