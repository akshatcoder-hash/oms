import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { omsChatPrompt } from '../src/runtime/system-prompt.ts';

// The chat prompt shares the reference prefix and program index with the pinned prompt and adds its own paragraph.
// Any change here, including whitespace, must be a deliberate decision: re-measure, then update these hashes.
const locked: Record<string, { bytes: number; sha256: string; text: () => string }> = {
  chat_plain: {
    bytes: 23271,
    sha256: '4ddc2bba6e164b3d21a343084002cb6039ebc31ed24d4f37315ebda80b4b5802',
    text: () => omsChatPrompt('/work', 'ok'),
  },
  chat_tail: {
    bytes: 23306,
    sha256: 'eabd19798acd7a0abd822d7690016a1bf01242818bc6f490cd5885c7f813aadb',
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
