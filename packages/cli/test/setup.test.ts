import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { Server } from 'node:http';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { createProviderControls } from '@oms/engine';
import { SetupPane } from '../src/tui/setup.ts';
import { getTheme } from '../src/tui/theme.ts';

function fixture(
  mode: 'model' | 'connect' | 'theme' = 'model',
  login?: (interaction: AuthInteraction) => Promise<void>,
) {
  let closed = false;
  let theme = '';
  let configured = false;
  const selected: string[] = [];
  const notices: string[] = [];
  const starts: string[] = [];
  const pane = new SetupPane(
    {
      listProviders: () => [
        { id: 'openai', name: 'OpenAI', configured: true, apiKey: true, oauth: false, apiKeyLabel: 'OpenAI API key' },
        {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          configured,
          apiKey: false,
          oauth: true,
          oauthLabel: 'OpenAI Codex subscription (ChatGPT)',
        },
        {
          id: 'anthropic',
          name: 'Anthropic',
          configured: false,
          apiKey: true,
          oauth: false,
          oauthLabel: 'Claude Code / Pro-Max subscription',
          oauthUnavailable: 'Third-party subscription login unavailable. Use an API key.',
        },
      ],
      listModels: () => [
        { provider: 'openai', id: 'api-model', name: 'API model', configured: true },
        { provider: 'openai-codex', id: 'subscription-model', name: 'Subscription model', configured },
      ],
      async selectModel(provider, id) {
        selected.push(`${provider}/${id}`);
      },
      async loginProvider(provider, method, interaction) {
        starts.push(`${provider}/${method}`);
        await login?.(interaction);
        configured = true;
      },
      async importEnvironment() {
        throw new Error('Import not configured in this fixture');
      },
    },
    {
      mode,
      theme: () => getTheme('gruvbox')!,
      rows: () => 30,
      render() {},
      close() {
        closed = true;
      },
      notice(message) {
        notices.push(message);
      },
      selectTheme(id) {
        theme = id;
        return true;
      },
    },
  );
  return {
    pane,
    selected,
    notices,
    starts,
    closed: () => closed,
    theme: () => theme,
    screen: () => [...pane.body.render(160), ...pane.input.render(160)].join('\n'),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('model setup starts with connected direct providers before showing their model catalog', async () => {
  const f = fixture();
  assert.match(f.screen(), /OpenAI models/);
  assert.match(f.screen(), /Codex subscription/);
  assert.doesNotMatch(f.screen(), /api-model/);
  f.pane.handleInput('\r');
  assert.match(f.screen(), /openai\/api-model/);
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(f.selected, ['openai/api-model']);
  assert.equal(f.closed(), true);
});

test('OAuth method, URL and manual code stay in setup; sensitive input is masked and discarded', async () => {
  const f = fixture('connect', async (interaction) => {
    assert.equal(
      await interaction.prompt({
        type: 'select',
        message: 'Choose login',
        options: [{ id: 'manual', label: 'Browser with manual code' }],
      }),
      'manual',
    );
    interaction.notify({
      type: 'auth_url',
      url: 'https://example.invalid/authorize?state=synthetic',
      instructions: 'Open yourself',
    });
    assert.equal(
      await interaction.prompt({ type: 'manual_code', message: 'Paste callback code' }),
      'synthetic-private-code',
    );
  });
  f.pane.handleInput('Codex');
  assert.deepEqual(f.starts, []);
  f.pane.handleInput('\r');
  await flush();
  assert.match(f.screen(), /Browser with manual code/);
  f.pane.handleInput('\r');
  await flush();
  assert.match(f.screen(), /https:\/\/example.invalid\/authorize/);
  f.pane.handleInput('synthetic-private-code');
  assert.doesNotMatch(f.screen(), /synthetic-private-code/);
  f.pane.handleInput('\r');
  await flush();
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(f.selected, ['openai-codex/subscription-model']);
  assert.equal(f.closed(), true);
  assert.doesNotMatch(f.screen(), /synthetic-private-code/);
  assert.doesNotMatch(f.notices.join(' '), /synthetic-private-code|state=/);
  f.pane.dispose();
});

test('closing setup aborts in-flight auth and clears sensitive prompt state', async () => {
  let signal: AbortSignal | undefined;
  const f = fixture('connect', async (interaction) => {
    signal = interaction.signal;
    await interaction.prompt({ type: 'secret', message: 'Code' });
  });
  f.pane.handleInput('Codex');
  f.pane.handleInput('\r');
  await flush();
  f.pane.handleInput('private-value');
  f.pane.handleInput('\x1b');
  f.pane.dispose();
  await flush();
  assert.equal(signal?.aborted, true);
  assert.equal(f.closed(), true);
  assert.doesNotMatch(f.screen(), /private-value/);
});

test('Claude subscription explains the provider restriction and never starts login', () => {
  const f = fixture('connect');
  f.pane.handleInput('Pro-Max');
  f.pane.handleInput('\r');
  assert.match(f.screen(), /Third-party subscription login unavailable/);
  assert.deepEqual(f.starts, []);
});

for (const available of [false, true]) {
  test(`local Claude Code setup ${available ? 'checks access and offers models' : 'gives actionable CLI login guidance'} without credential entry`, async () => {
    let configured = false;
    let checks = 0;
    const notices: string[] = [];
    const selections: string[] = [];
    const pane = new SetupPane(
      {
        listProviders: () => [
          {
            id: 'claude-code',
            name: 'Claude Code',
            configured,
            apiKey: false,
            oauth: true,
            oauthLabel: 'Check local Claude Code subscription login',
          },
        ],
        listModels: () => [
          {
            provider: 'claude-code',
            id: 'sonnet',
            name: 'Claude Code Sonnet',
            configured,
            selectable: configured,
            detail: configured ? 'Local subscription' : 'Run claude auth login.',
          },
        ],
        async loginProvider(provider, method, interaction) {
          assert.equal(provider, 'claude-code');
          assert.equal(method, 'oauth');
          checks++;
          interaction.notify({ type: 'info', message: 'Checking local subscription login.' });
          if (!available) throw new Error('synthetic-private-account-identifier');
          configured = true;
        },
        async selectModel(provider, id) {
          selections.push(`${provider}/${id}`);
        },
        async importEnvironment() {
          throw new Error('Not available');
        },
      },
      {
        mode: 'connect',
        theme: () => getTheme('gruvbox')!,
        rows: () => 35,
        render() {},
        close() {},
        notice: (message) => notices.push(message),
        selectTheme() {
          return false;
        },
      },
    );
    const screen = () => pane.body.render(160).map(stripVTControlCharacters).join('\n');
    assert.match(screen(), /Local Claude Code/);
    pane.handleInput('\r');
    await flush();
    assert.equal(checks, 1);
    assert.doesNotMatch(screen(), /Stored only in private OMS configuration|synthetic-private-account-identifier/);
    assert.deepEqual(selections, []);
    if (available) {
      assert.match(screen(), /claude-code\/sonnet/);
      assert.match(screen(), /Claude owns a native chat for this OMS conversation/);
      assert.match(screen(), /approvals, sandbox and independent verification/);
      assert.match(notices.join(' '), /Local Claude Code login checked/);
      pane.handleInput('\r');
      await flush();
      assert.deepEqual(selections, ['claude-code/sonnet']);
      assert.match(notices.at(-1)!, /Native Claude chat selected: claude-code\/sonnet/);
    } else {
      assert.match(screen(), /Claude Code is not ready/);
      assert.match(screen(), /claude auth login/);
      assert.match(screen(), /claude auth status/);
      assert.doesNotMatch(screen(), /Secret:|credentials may already be saved/);
      assert.deepEqual(notices, []);
    }
    pane.dispose();
  });
}

test('unconfigured Claude Code is visible in /model and checks installed CLI login before offering models', async () => {
  let configured = false;
  let checks = 0;
  const selected: string[] = [];
  const pane = new SetupPane(
    {
      listProviders: () => [
        {
          id: 'claude-code',
          name: 'Claude Code',
          configured,
          apiKey: false,
          oauth: true,
          oauthLabel: 'Check local Claude Code subscription login',
        },
      ],
      listModels: () =>
        ['sonnet', 'opus', 'haiku'].map((id) => ({
          provider: 'claude-code',
          id,
          name: `Claude Code ${id}`,
          configured,
          selectable: configured,
        })),
      async loginProvider(provider, method) {
        assert.equal(provider, 'claude-code');
        assert.equal(method, 'oauth');
        configured = true;
        checks++;
      },
      async selectModel(provider, id) {
        selected.push(`${provider}/${id}`);
      },
      async importEnvironment() {
        throw new Error('Not available');
      },
    },
    {
      mode: 'model',
      theme: () => getTheme('gruvbox')!,
      rows: () => 35,
      render() {},
      close() {},
      notice() {},
      selectTheme() {
        return false;
      },
    },
  );
  const screen = () => pane.body.render(160).map(stripVTControlCharacters).join('\n');
  assert.match(screen(), /Claude Code/);
  assert.match(screen(), /check installed CLI and login/);
  assert.deepEqual(selected, []);
  pane.handleInput('\r');
  await flush();
  assert.equal(checks, 1);
  for (const id of ['sonnet', 'opus', 'haiku']) assert.ok(screen().includes(`claude-code/${id}`));
  assert.match(screen(), /\/session shows the native session/);
  assert.doesNotMatch(screen(), /\/claude/);
  assert.deepEqual(selected, []);
  pane.handleInput('opus');
  pane.handleInput('\r');
  await flush();
  assert.deepEqual(selected, ['claude-code/opus']);
  pane.dispose();
});

test('theme picker still selects locally without auth', () => {
  const f = fixture('theme');
  f.pane.handleInput('gruvbox');
  f.pane.handleInput('\r');
  assert.equal(f.theme(), 'gruvbox');
  assert.equal(f.closed(), true);
  assert.deepEqual(f.starts, []);
});

test('SDK callback cancellation discards pending manual code without aborting the completed login', async () => {
  const callback = new AbortController();
  let flowSignal: AbortSignal | undefined;
  const f = fixture('connect', async (interaction) => {
    flowSignal = interaction.signal;
    await assert.rejects(
      interaction.prompt({ type: 'manual_code', message: 'Paste code', signal: callback.signal }),
      /cancelled/,
    );
  });
  f.pane.handleInput('Codex');
  f.pane.handleInput('\r');
  await flush();
  f.pane.handleInput('discard-this-code');
  callback.abort();
  await flush();
  assert.equal(flowSignal?.aborted, false);
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(f.selected, ['openai-codex/subscription-model']);
  assert.equal(f.closed(), true);
  assert.doesNotMatch(f.screen(), /discard-this-code/);
  f.pane.dispose();
});

test('device codes and verification URLs stay in setup instead of chat', async () => {
  const f = fixture('connect', async (interaction) => {
    interaction.notify({
      type: 'device_code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://example.invalid/device',
    });
    await interaction.prompt({ type: 'manual_code', message: 'Wait for approval' });
  });
  f.pane.handleInput('Codex');
  f.pane.handleInput('\r');
  await flush();
  assert.match(f.screen(), /ABCD-1234/);
  assert.ok(f.screen().includes('https://example.invalid/device'));
  assert.deepEqual(f.notices, []);
  f.pane.dispose();
  await flush();
});

test('selected model identity remains complete when the list column or viewport is narrow', async () => {
  const f = fixture('connect');
  f.pane.handleInput('Codex');
  f.pane.handleInput('\r');
  await flush();
  for (const width of [20, 160]) {
    const rendered = f.pane.body.render(width).map(stripVTControlCharacters).join('');
    assert.ok(rendered.includes('Selected:'));
    assert.ok(rendered.includes('openai-codex/subscription-model'));
  }
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(f.selected, ['openai-codex/subscription-model']);
  f.pane.dispose();
});

test('generic provider prompts accept text, empty continuation, secrets and actual option ids', async () => {
  const answers: string[] = [];
  const f = fixture('connect', async (interaction) => {
    answers.push(await interaction.prompt({ type: 'text', message: 'Account name' }));
    answers.push(await interaction.prompt({ type: 'text', message: 'Press Enter to continue' }));
    answers.push(await interaction.prompt({ type: 'secret', message: 'Token' }));
    answers.push(
      await interaction.prompt({
        type: 'select',
        message: 'Region',
        options: [{ id: 'actual-region', label: 'Provider region' }],
      }),
    );
  });
  f.pane.handleInput('\r');
  await flush();
  f.pane.handleInput('Team account');
  assert.match(f.screen(), /Team account/);
  f.pane.handleInput('\r');
  await flush();
  f.pane.handleInput('\r');
  await flush();
  f.pane.handleInput('private-token');
  assert.doesNotMatch(f.screen(), /private-token/);
  f.pane.handleInput('\r');
  await flush();
  f.pane.handleInput('\r');
  await flush();
  assert.deepEqual(answers, ['Team account', '', 'private-token', 'actual-region']);
  assert.doesNotMatch(f.screen(), /private-token/);
  f.pane.dispose();
});

test(
  'actual pinned OAuth URL survives narrow presentation and explicit copy without external requests',
  { timeout: 10_000 },
  async (t) => {
    const credentials: CredentialStore = {
      async read() {
        return undefined;
      },
      async list() {
        return [];
      },
      async modify() {
        throw new Error('Abort must precede credential persistence');
      },
      async delete() {},
    };
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const fetches: unknown[] = [];
    t.mock.method(globalThis, 'fetch', async (...args: unknown[]) => {
      fetches.push(args);
      throw new Error('External requests forbidden');
    });
    const controller = new AbortController();
    const controls = createProviderControls({
      modelRuntime: runtime,
      session: { async setModel() {} },
      maxOutputTokens: 50,
      signal: controller.signal,
      checkAuthFile() {},
      async withUserOperation(action) {
        return action();
      },
      loginOptions: { agentName: 'OMS' },
    });
    let generated = '';
    const listen = Server.prototype.listen;
    let callbackServer: Server | undefined;
    t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
      callbackServer = this;
      return Reflect.apply(listen, this, args);
    });
    let copied = '';
    let loginDone: Promise<void> | undefined;
    let ready!: () => void;
    const presented = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let methodReady!: () => void;
    const methodPresented = new Promise<void>((resolve) => {
      methodReady = resolve;
    });
    let pane: SetupPane;
    pane = new SetupPane(
      {
        ...controls,
        loginProvider(provider, method, interaction) {
          loginDone = controls.loginProvider(provider, method, {
            ...interaction,
            async prompt(prompt) {
              if (prompt.type === 'select') methodReady();
              if (prompt.type === 'manual_code') ready();
              return interaction.prompt(prompt);
            },
            notify(event) {
              if (event.type === 'auth_url') generated = event.url;
              interaction.notify(event);
            },
          });
          return loginDone;
        },
      },
      {
        mode: 'connect',
        query: 'openai-codex',
        theme: () => getTheme('gruvbox')!,
        rows: () => 20,
        bodyRows: () => 12,
        render() {},
        close() {},
        notice() {},
        selectTheme() {
          return false;
        },
        async copyAuthUrl(url) {
          copied = url;
        },
      },
    );
    try {
      pane.handleInput('\r');
      await methodPresented;
      pane.handleInput('\r');
      await presented;
      assert.ok(generated);
      const url = new URL(generated);
      assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(callbackServer?.listening, true, 'SDK must bind its local callback server, not silently fall back');
      const address = callbackServer?.address();
      assert.ok(address && typeof address !== 'string' && address.port === 1455);
      assert.equal(url.searchParams.get('originator'), 'OMS');
      const narrow = pane.body.render(24).join('\n');
      // OSC-8 targets carry the complete URI, independent of visual wrapping and clipping.
      assert.ok(narrow.includes(`\x1b]8;;${generated}\x1b\\`));
      assert.equal(copied, '');
      pane.handleInput('\x18');
      await flush();
      assert.equal(copied, generated);
      assert.equal(new URL(copied).searchParams.get('redirect_uri'), url.searchParams.get('redirect_uri'));
      pane.handleInput('\x1b');
      await assert.rejects(loginDone!, /setup did not complete/);
      assert.deepEqual(fetches, []);
      assert.equal(callbackServer?.listening, false, 'aborting login must close the SDK callback server');
    } finally {
      pane.dispose();
      controller.abort();
      await loginDone?.catch(() => {});
    }
  },
);

test('explicit environment import keeps names and confirmation outside chat and preserves model selection', async () => {
  let writes = 0;
  let selected = 0;
  let closed = false;
  const notices: string[] = [];
  const pane = new SetupPane(
    {
      listProviders: () => [],
      listModels: () => [],
      async selectModel() {
        selected++;
      },
      async loginProvider() {},
      async importEnvironment(path, interaction) {
        assert.equal(path, '/private/operator.env');
        const choice = await interaction.prompt({
          type: 'select',
          message: 'Import OPENAI_API_KEY into private OMS configuration?',
          options: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'import', label: 'Import credentials' },
          ],
        });
        if (choice === 'import') writes++;
        return {
          status: 'completed',
          outcomes: [
            {
              name: 'OPENAI_API_KEY',
              provider: 'openai',
              status: choice === 'import' ? 'configured' : 'not_attempted',
            },
          ],
        };
      },
    },
    {
      mode: 'connect',
      query: 'import /private/operator.env',
      theme: () => getTheme('gruvbox')!,
      rows: () => 30,
      render() {},
      close() {
        closed = true;
      },
      notice: (message) => notices.push(message),
      selectTheme: () => false,
    },
  );
  await flush();
  assert.match(pane.body.render(120).join('\n'), /OPENAI_API_KEY/);
  assert.equal(writes, 0);
  pane.handleInput('\x1b[B');
  pane.handleInput('\r');
  await flush();
  assert.equal(writes, 1);
  assert.equal(selected, 0);
  assert.equal(closed, true);
  assert.match(notices.join(' '), /configured/);
  pane.dispose();
});

test('Codex-only setup exposes a Codex action and selects a model only on explicit confirmation', async () => {
  const selected: string[] = [];
  let logins = 0;
  const pane = new SetupPane(
    {
      listProviders: () => [{ id: 'openai-codex', name: 'OpenAI Codex', configured: true, apiKey: false, oauth: true }],
      listModels: () => [
        { provider: 'openai-codex', id: 'controlled', name: 'Controlled Codex', configured: true, selectable: true },
      ],
      async selectModel(provider, id) {
        selected.push(`${provider}/${id}`);
      },
      async loginProvider() {
        logins++;
      },
      async importEnvironment() {
        throw Error();
      },
    },
    {
      mode: 'model',
      theme: () => getTheme('gruvbox')!,
      rows: () => 30,
      render() {},
      close() {},
      notice() {},
      selectTheme: () => false,
    },
  );
  let screen = stripVTControlCharacters(pane.body.render(160).join('\n'));
  assert.match(screen, /Codex models/);
  pane.handleInput('Codex');
  pane.handleInput('\r');
  await flush();
  screen = stripVTControlCharacters(pane.body.render(160).join('\n'));
  assert.match(screen, /openai-codex\/controlled/);
  assert.match(screen, /does not configure/i);
  assert.deepEqual(selected, []);
  pane.handleInput('\r');
  await flush();
  assert.deepEqual(selected, ['openai-codex/controlled']);
  assert.equal(logins, 0);
  pane.dispose();
});
