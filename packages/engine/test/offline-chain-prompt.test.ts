import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fauxAssistantMessage, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { programReferenceIndex } from '../src/runtime/program-reference.ts';
import { createHarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';

const binary = process.env.SURFPOOL_BINARY;
const image = process.env.OMS_SANDBOX_IMAGE;
const forwarderImage = process.env.OMS_SANDBOX_FORWARDER_IMAGE ?? image;

test('production dispatch names the offline chain and build timeout without a dynamic port', async (t) => {
  if (
    (await skipUnavailable(t, { docker: [image, forwarderImage], surfpool: binary })) ||
    !binary ||
    !image ||
    !forwarderImage
  )
    return;
  const f = await createHarnessFixture({ binary, image, forwarderImage });
  const harness = await createHarnessSession({ ...f.options, modelRuntime: f.modelRuntime, model: f.model });
  try {
    const prompts: string[] = [];
    f.faux.setResponses([
      (context) => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage('Ready for offline work.');
      },
    ]);
    await harness.session.prompt('Describe the task environment.');
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(prompts.length, 1);
    const prompt = prompts[0]!;
    assert.equal(
      prompt,
      harness.session.systemPrompt.replaceAll(f.task.codeRoot, '/work'),
      'the static prompt reaches the provider with only the sandbox cwd rewrite',
    );
    assert.match(prompt, /offline Surfpool at \$SURFNET_RPC_URL \(= \$SOLANA_RPC_URL\)/);
    assert.match(prompt, /no mainnet/i);
    assert.match(prompt, /explicit timeouts for long builds/i);
    assert.ok(
      prompt.includes(programReferenceIndex()),
      'the program index is in the prompt without the knowledge service',
    );
    assert.doesNotMatch(prompt, /:\d{4,5}\b/);
  } finally {
    await harness.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
