import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AccountPane } from '../src/tui/account.ts';
import type { OmsAccountSnapshot } from '@oms/engine';
import { getTheme } from '../src/tui/theme.ts';

test('device login displays code/link and escape cancels its pending operation', async () => {
  let signal: AbortSignal | undefined;
  let closed = false;
  const pane = new AccountPane({ snapshot: () => ({ state: 'signed-out', origin: 'https://oms.barestate.xyz' }),
    async refresh() {}, async logout() { return { serverRevoked: false }; },
    async login(interaction, active) { signal = active; interaction.showDevice({verificationUri:'https://oms.barestate.xyz/device',userCode:'ABCD-EFGH',expiresAt:Date.now()+60000}); await new Promise<void>(resolve => active.addEventListener('abort',()=>resolve(),{once:true})); },
  }, {mode:'login',theme:()=>getTheme('gruvbox')!,render(){},close(){closed=true;pane.dispose();}});
  await setImmediate();
  const screen=pane.body.render(100).join('\n');
  assert.match(screen,/ABCD-EFGH/);assert.match(screen,/https:\/\/oms.barestate.xyz\/device/);
  pane.handleInput('\x1b');await setImmediate();
  assert.equal(signal?.aborted,true);assert.equal(closed,true);
});

test('offline logout states revocation uncertainty instead of claiming server success', async () => {
  const pane=new AccountPane({snapshot:()=>({state:'signed-out',transport:'local',origin:'https://oms.barestate.xyz'}),async refresh(){},async login(){},async logout(){return {serverRevoked:false};}},
    {mode:'logout',theme:()=>getTheme('gruvbox')!,render(){},close(){}});
  await setImmediate();assert.match(pane.body.render(100).join('\n'),/revocation unconfirmed/i);pane.dispose();
});

test('account pane shows the signed-in email and origin and explains that sign-in only enables hosted search', async () => {
  const snapshot: OmsAccountSnapshot = { state: 'signed-in', origin: 'https://oms.barestate.xyz', email: 'person@example.test' };
  const pane = new AccountPane({ snapshot: () => snapshot, async refresh() {}, async login() {}, async logout() { return { serverRevoked: false }; } },
    { mode: 'account', theme: () => getTheme('gruvbox')!, render() {}, close() {} });
  await setImmediate();
  const screen = pane.body.render(120).join('\n');
  assert.match(screen, /signed-in/);
  assert.match(screen, /person@example\.test/);
  assert.match(screen, /hosted web search only/);
  assert.doesNotMatch(screen, /credit|managed/i);
  pane.dispose();
});
