import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createHarnessSession } from '../src/runtime/session.ts';
import { createHarnessFixture } from '../test-support/runtime-fixture.ts';
import { skipUnavailable } from '../../sandbox/test-support/infrastructure.ts';
const binary=process.env.SURFPOOL_BINARY,image=process.env.OMS_SANDBOX_IMAGE,forwarderImage=process.env.OMS_SANDBOX_FORWARDER_IMAGE??image;
test('session exposes toolchain readiness before its first turn and a read-only toolchain_check tool', {timeout:120_000},async t=>{
 if(await skipUnavailable(t,{docker:[image,forwarderImage],surfpool:binary})||!binary||!image||!forwarderImage) return;
 const f=await createHarnessFixture({binary,image,forwarderImage});
 const sentinel='UNTRUSTED_TOOLCHAIN_INSTRUCTION_MUST_NOT_ENTER_SYSTEM_PROMPT';
 writeFileSync(join(f.task.codeRoot,'Anchor.toml'),`[toolchain]\npackage_manager="${sentinel}"\n`);
 const harness=await createHarnessSession({...f.options,modelRuntime:f.modelRuntime,model:f.model});
 try {
   assert.ok(harness.session.getActiveToolNames().includes('toolchain_check'));
   assert.match(harness.session.systemPrompt,/Compatibility rule findings: pins/);
   assert.ok(!harness.session.systemPrompt.includes(sentinel));
   f.faux.setResponses([
     fauxAssistantMessage(fauxToolCall('toolchain_check',{}),{stopReason:'toolUse'}),
     fauxAssistantMessage('Report read.'),
   ]);
   await harness.session.prompt('Inspect compatibility and task state.');
   const results=harness.session.messages.filter(m=>m.role==='toolResult');
   assert.ok(results.some(m=>m.role==='toolResult'&&m.toolName==='toolchain_check'&&JSON.stringify(m).includes('package_manager')));
 } finally {await harness.close();rmSync(f.base,{recursive:true,force:true});}
});

