import assert from 'node:assert/strict';
import { test } from 'node:test';
import { omsSystemPrompt } from '../src/runtime/session.ts';

test('the system prompt does not send the model to re-read requirements its first message may carry', () => {
  const prompt = omsSystemPrompt('/work', 'Compatibility rule findings: none.', ' TAIL');
  assert.doesNotMatch(prompt, /Read task_status/);
  assert.match(prompt, /task_status returns the trusted requirements: call it when the first message does not already carry them/);
  assert.match(prompt, /toolchain_check details compatibility findings/);
  assert.match(prompt, /Compatibility rule findings: none\./);
  assert.ok(prompt.endsWith(' TAIL'));
});

test("the system prompt tells the model to prefer a program's installed official client, in a prefix identical across sessions", () => {
  const rule = "Before hand-encoding a program's instructions, check the project's package.json and node_modules for that program's official client (the index names it) and use it when present; fall back to program_reference encodings otherwise.";
  const first = omsSystemPrompt('/work/a', 'toolchain ok');
  const second = omsSystemPrompt('/work/b', 'toolchain differs', ' tail');
  assert.ok(first.includes(rule) && second.includes(rule));
  const prefix = (prompt: string) => prompt.slice(0, prompt.indexOf('You are OMS'));
  assert.ok(prefix(first).includes(rule));
  assert.equal(prefix(first), prefix(second));
});

test('the system prompt forbids existing keys, allows throwaway local-chain signers, and states the capped-action rule', () => {
  const prompt = omsSystemPrompt('/work', 'ok');
  assert.match(prompt, /Never read, request, copy, print or use the user's existing keys, wallets, keypair files, seed phrases or credentials\./);
  assert.match(prompt, /generate fresh throwaway keypairs in memory or in the task's temp or work directory, only for tests and local-chain \(Surfpool or local validator\) setup/);
  assert.match(prompt, /never use them on devnet or mainnet or commit them with real funds/);
  assert.doesNotMatch(prompt, /Signing and credential access/);
  assert.doesNotMatch(prompt, /plan the whole budget rather than spending it piecemeal|Keep a short plan of completed steps/);
  assert.match(prompt, /or measures an objective, the capped action is the scarce resource: plan the whole cap before spending it\./);
  assert.match(prompt, /make each action carry as much verified work as its size and compute limits allow: merge pending items from different candidates into one action/);
  assert.match(prompt, /An action that would carry only one or two items waits for more, unless later work depends on it\./);
  assert.match(prompt, /when setup fails, drop its dependents for an independent alternative; when a size or compute limit is hit, split and repack\./);
  assert.match(prompt, /stop a strategy when its gain per action falls below the best remaining candidate in the ledger\./);
  assert.match(prompt, /Do not vary data a program does not interpret \(memo text, no-op logs\)\. Follow the task's scoring rules literally\./);
  assert.match(prompt, /if actions will, spend time preparing fuller actions; if time will, send what is verified\./);
  assert.doesNotMatch(prompt, /spend the remaining budget before it runs out/);
  assert.match(prompt, /an environment failure \(an unhealthy or timed-out RPC node, a dropped connection, a sandbox error\) is not a reason to stop; check the node's health, wait briefly, re-simulate and continue\./);
  assert.match(prompt, /Work in large verified steps: when the next several steps are clear, write one script that performs and checks them all/);
  assert.match(prompt, /Make focused changes and verify them with real sandbox checks\./);
  assert.doesNotMatch(prompt, /Use small changes|Iterate with scripts: write and run|re-rank it after every result, do tested cheap work/);
  assert.match(prompt, /When a program has no installed client and source_fetch is available, fetch its source with source_fetch and read its instruction and state definitions locally with grep and cat, not page by page through the web\./);
  assert.match(prompt, /existing protocol state \(configs, pools, mints, registries\) is real and usable: when an admin or initialize instruction fails, find the live deployment \(the client SDK's deployment constants, or getProgramAccounts with a data-size or discriminator filter\) and use the operations your wallet can authorize\. Instructions in one transaction run in order/);
  assert.match(prompt, /build a lifecycle \(create, then update, use and close\) as one transaction and simulate it whole\. Separate simulations do not persist state/);
  assert.doesNotMatch(prompt, /do not simulate instructions together/);
  const prefix = (text: string) => text.slice(0, text.indexOf('You are OMS'));
  assert.equal(prefix(prompt), prefix(omsSystemPrompt('/other', 'different', ' tail')));
});

test('the system prompt picks SDKs by compatibility and asks for an operational plan, in an identical prefix', () => {
  const first = omsSystemPrompt('/work/a', 'ok');
  const second = omsSystemPrompt('/work/b', 'other', ' tail');
  const prefix = (text: string) => text.slice(0, text.indexOf('You are OMS'));
  assert.match(prefix(first), /Prefer @solana\/kit for new code, but use whichever installed client is compatible with the project and the target program, and convert between installed clients when needed rather than re-implementing an instruction by hand/);
  assert.doesNotMatch(first, /legacy web3\.js classes/);
  assert.match(prefix(first), /exact raw integers/);
  assert.match(first, /Keep a short ledger of candidate work/);
  assert.equal(prefix(first), prefix(second));
});
