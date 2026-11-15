import type { StartupArtMode } from './startup-art.ts';
import type { CommandContext } from './commands.ts';

/** The commands that only move around the interface: views, panes, files, setup screens, the startup picture and web access. */

const ART_MODES: Record<string, StartupArtMode> = {
  on: 'auto',
  auto: 'auto',
  image: 'image',
  truecolor: 'truecolor',
  256: '256',
  off: 'off',
};
export const acceptsArt = (argument: string): boolean =>
  !argument || argument === 'next' || Object.hasOwn(ART_MODES, argument);
export const acceptsWeb = (argument: string): boolean => ['', 'on', 'off'].includes(argument);
export const acceptsLayout = (argument: string): boolean => ['editor', 'balanced', ''].includes(argument);

type Draft = string | undefined;

/** Show the agent or the workbench and focus its main pane. */
const goToView =
  (view: 'harness' | 'workbench') =>
  (ctx: CommandContext, _argument: string, draft: Draft): void => {
    ctx.clearDraft(draft);
    ctx.switchView(view);
    ctx.setFocus(view === 'harness' ? 'input' : 'editor');
  };

/** Run a workbench action in the editor view. */
const inEditor =
  (action: (ctx: CommandContext, argument: string) => void | Promise<void>) =>
  (ctx: CommandContext, argument: string, draft: Draft): void => {
    ctx.clearDraft(draft);
    ctx.editorAction(() => action(ctx, argument));
  };

/** Open a setup screen; the screen keeps the draft and the argument filters it. */
const setupScreen =
  (mode: 'model' | 'connect' | 'settings') =>
  (ctx: CommandContext, argument: string, draft: Draft): void =>
    ctx.openSetup(mode, argument, draft);
const accountScreen =
  (mode: 'login' | 'logout') =>
  (ctx: CommandContext, _argument: string, draft: Draft): void =>
    ctx.openAccount(mode, draft);

export const uiCommands = {
  workbench: goToView('workbench'),
  harness: goToView('harness'),
  files: inEditor((ctx) => ctx.workbench.open()),
  open: inEditor((ctx, argument) => ctx.workbench.open(argument)),
  newfile: inEditor((ctx, argument) => ctx.workbench.newFile(argument || undefined)),
  save: inEditor((ctx) => ctx.workbench.save()),
  close: inEditor((ctx) => {
    ctx.workbench.closeBuffer();
  }),
  find: inEditor((ctx) => {
    ctx.workbench.find();
  }),
  replace: inEditor((ctx) => {
    ctx.workbench.replace();
  }),
  next: inEditor((ctx) => {
    ctx.workbench.nextBuffer();
  }),
  split: inEditor((ctx) => {
    ctx.workbench.split();
  }),
  model: setupScreen('model'),
  connect: setupScreen('connect'),
  settings: setupScreen('settings'),
  login: accountScreen('login'),
  logout: accountScreen('logout'),
  theme(ctx: CommandContext, argument: string, draft: Draft): void {
    if (!argument) {
      ctx.openSetup('theme', '', draft);
      return;
    }
    if (ctx.changeTheme(argument)) ctx.clearDraft(draft);
  },
  art(ctx: CommandContext, argument: string, draft: Draft): void {
    ctx.clearDraft(draft);
    if (argument && argument !== 'next') {
      ctx.art.setMode(ART_MODES[argument]!);
      ctx.setNotice(`Startup art ${argument}`);
    } else {
      if (argument === 'next') ctx.art.next();
      ctx.setNotice(`${ctx.art.title()} · /art next · /art off`);
    }
    ctx.art.reload();
  },
  web(ctx: CommandContext, argument: string, draft: Draft): void {
    ctx.clearDraft(draft);
    const { web } = ctx.harness;
    if (!web) {
      ctx.setNotice('Web access is not available in this session.');
      return;
    }
    if (argument) web.set(argument === 'on');
    const used = web.usage();
    ctx.setNotice(
      `Web ${web.enabled() ? 'on' : 'off'} · ${used.webSearch} searches, ${used.webFetch} fetches, ${used.solanaMcp} Solana MCP calls · /web ${web.enabled() ? 'off' : 'on'}`,
    );
  },
  terminal(ctx: CommandContext, argument: string, draft: Draft): void {
    ctx.clearDraft(draft);
    ctx.terminalAction(argument);
  },
  layout(ctx: CommandContext, argument: string, draft: Draft): void {
    ctx.clearDraft(draft);
    ctx.setAgentPanel(argument ? argument === 'balanced' : undefined);
  },
  cancel(ctx: CommandContext, _argument: string, draft: Draft): void {
    ctx.clearDraft(draft);
    ctx.cancel();
  },
  requirements(ctx: CommandContext, _argument: string, draft: Draft): void {
    ctx.clearDraft(draft);
    if (ctx.columns() < 78) {
      ctx.submit('/status');
      return;
    }
    ctx.switchView('harness');
    ctx.toggleRequirements();
  },
};
