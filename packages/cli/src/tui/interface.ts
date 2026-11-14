import { runReviewCommand, type ReviewPresentation } from '../review.ts';
import { REVIEW_DISCLAIMER } from '../../../review/src/disclaimer.ts';
import { basename } from 'node:path';
import {
  HStack, VStack, ScrollView, ProcessTerminal, TuiAltScreen, Input, matchesKey, isKeyRelease,
  truncateToWidth, visibleWidth, wrapTextWithAnsi, getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS,
  type Component, type Terminal, type KeybindingsConfig,
} from '@earendil-works/pi-tui';
import { LAYOUT_NODE } from '@earendil-works/pi-tui/dist/layout-node.js';
import type { HarnessSession } from '@oms/engine';
import { createFileEditorPane } from './file-editor.ts';
import { commandHelp, commandMatches, type OmsCommand } from './commands.ts';
import { SetupPane } from './setup.ts';
import { HarnessSettingsPane } from './harness-settings.ts';
import { AccountPane } from './account.ts';
import { ActionBar, PaneFrame } from './chrome.ts';
import { WorkbenchPane } from './workbench.ts';
import { TerminalPane } from './terminal-pane.ts';
import { Conversation, describeValue, displayText } from './transcript.ts';
import { READ_ONLY_COMMANDS, prepareSlash } from './slash-commands.ts';
import type { CommandOutput, Prepared } from './solana-commands.ts';
import { goalSummary, newGoal, parseGoalArguments, runGoalCheck, runGoalLoop, taskVerifierItem, type Goal } from './goal.ts';
import { StartupArt, artShow, settleKittyGraphics, type StartupArtMode } from './startup-art.ts';
import { colorText, DEFAULT_THEME_ID, getTheme, paintThemeRow, THEME_IDS, type OmsTheme, type OmsThemeId } from './theme.ts';

type ActionKind = 'agent' | 'command' | 'verification' | 'review';
interface Action {
  kind: ActionKind;
  draft: string | undefined;
  accepted: boolean;
  controller: AbortController;
  completion: Promise<void>;
  cancellation?: Promise<void>;
  error?: string;
  errorDisplayed?: boolean;
}
interface Requirement { id: string; title: string; status: string }

const MODEL_CONFIGURATION = 'Use /model to choose a model or /connect to add an API key; draft retained.';

/** Chrome components return physical rows; multiline content belongs only in the editor/transcript. */
function singleLine(value: string, limit: number): string {
  return displayText(value, limit).replace(/\s+/g, ' ').trim();
}

function hasModelConfiguration(model: { provider: string; id: string } | undefined): boolean {
  const provider = model?.provider.trim();
  const id = model?.id.trim();
  return !!provider && !!id && provider !== 'unknown' && id !== 'unknown';
}

function alignEnds(left: string, right: string, width: number): string {
  if (visibleWidth(right) + 4 >= width) return truncateToWidth(left, width, '');
  const start = truncateToWidth(left, width - visibleWidth(right) - 2, '');
  return start + ' '.repeat(Math.max(1, width - visibleWidth(start) - visibleWidth(right))) + right;
}
/** Convert render-loop failures into rejection of this presentation's lifecycle. */
class InterfaceRenderer extends TuiAltScreen {
  private readonly fail: (error: unknown) => void;
  private readonly palette: () => OmsTheme;
  private readonly prepareFrame: () => void;
  private readonly mouseFocus: (component: Component) => Component;
  constructor(terminal: Terminal, fail: (error: unknown) => void, palette: () => OmsTheme,
    prepareFrame: () => void, mouseFocus: (component: Component) => Component) {
    super(terminal, true, undefined, { mouse: true, copyOnSelect: false });
    this.fail = fail;
    this.palette = palette;
    this.prepareFrame = prepareFrame;
    this.mouseFocus = mouseFocus;
  }
  protected override resolveFakeCursors(lines: string[]): string[] {
    const theme = this.palette();
    return super.resolveFakeCursors(lines).map(line => paintThemeRow(theme, line, this.terminal.columns));
  }
  override setFocus(component: Component | null): void {
    // Native dispatch resolves candidates even for focus:false; only commit at actual focus.
    super.setFocus(component === null ? null : this.mouseFocus(component));
  }
  protected override doRender(): void {
    try { this.prepareFrame(); super.doRender(); } catch (error) { this.fail(error); }
  }
}

/** One OMS presentation over the live session. Whole-app quit/failure closes its owner; layout never does. */
export async function runOmsInterface(harness: HarnessSession, options: {
  review?: typeof runReviewCommand;
  terminal?: Terminal; theme?: OmsThemeId; onThemeChange?: (theme: OmsThemeId) => void;
  startupArt?: StartupArtMode; onStartupArtChange?: (mode: StartupArtMode) => void;
  view?: 'harness' | 'workbench';
  onViewChange?: (view: 'harness' | 'workbench') => void;
} = {}): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal();
  let theme = getTheme(options.theme ?? DEFAULT_THEME_ID);
  if (!theme) throw new Error(`Choose a theme from: ${THEME_IDS.join(', ')}`);
  let requirementsVisible = false;
  let view = options.view ?? 'harness';
  let terminalVisible = false;
  let agentPanelVisible = false;
  let discardConfirmed = false;
  const previousKeybindings = getKeybindings();
  const ownedBindings: KeybindingsConfig = { ...previousKeybindings.getResolvedBindings() };
  for (const id of Object.keys(TUI_KEYBINDINGS)) {
    if (id.startsWith('tui.altScreen.')) ownedBindings[id] = [];
  }
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  let closing = false;
  let disposed = false;
  let failure: unknown;
  let active: Action | undefined;
  let externalBusy = harness.session.isStreaming;
  let externalCancellation: Promise<void> | undefined;
  let sessionSettled: (() => void) | undefined;
  let shutdown: Promise<void> | undefined;
  let shutdownComplete = false;
  let titleSaved = false;
  type Focus = 'input' | 'requirements' | 'conversation' | 'editor' | 'terminal' | 'actions';
  let focus: Focus = view === 'workbench' ? 'editor' : 'input';
  let harnessFocus: Focus = 'input';
  let workbenchFocus: Focus = 'editor';
  let selectedId: string | undefined;
  let notice = '';
  let hostApproval: { text: string; answer(allowed: boolean): void } | undefined;
  let checkedItems: Requirement[] = [];
  let setup: SetupPane | HarnessSettingsPane | AccountPane | undefined;
  let commandIndex = 0;
  let commandDraft = '';
  let dismissedCommands: string | undefined;
  let paletteInput: Input | undefined;
  let proofAvailable = false;
  let goal: Goal | undefined;
  let checkedAt = 'not checked';
  const fail = (error: unknown) => {
    failure ??= error;
    if (!closing) quit(true);
    reject(error);
  };
  const renderer = new InterfaceRenderer(terminal, fail, () => theme!, () => {
    repairHiddenFocus();
    composerLayoutEntry.basis = terminal.rows >= 24 ? 7 : terminal.rows >= 20 ? 6 : 3;
  }, component => {
    if (setup) return setup.input;
    if (paletteInput) return paletteInput;
    if (component === input.focus) { focus = 'input'; return input.focus; }
    const editorFocus = workbench.resolveMouseFocus(component);
    if (editorFocus) { focus = 'editor'; return editorFocus; }
    if (shell.resolveMouseFocus(component)) { focus = 'terminal'; return shell.focus; }
    return component;
  });
  const requestRender = () => { if (!disposed) renderer.requestRender(); };
  const input = createFileEditorPane('', () => {
    if (input.document.text !== dismissedCommands) dismissedCommands = undefined;
    requestRender();
  });
  const workbench = new WorkbenchPane(harness, { theme: () => theme!, render: requestRender, rows: () => terminal.rows,
    notice: message => { if (view === 'harness') setNotice(message); },
    requestFocus: () => { if (!setup && !paletteInput) setFocus('editor'); },
    focusChanged: () => { if (view === 'workbench' && focus === 'editor') setFocus('editor'); } });
  const shell = new TerminalPane(harness, { theme: () => theme!, render: requestRender, notice: setNotice,
    requestFocus: () => { if (!setup && !paletteInput) setFocus('terminal'); }, hostRows: () => terminal.rows,
    columns: () => terminal.columns, rows: () => Math.max(3, Math.floor(terminal.rows / 3)) });
  const conversation = new Conversation(harness.session.messages, (message, provider) => actionError('agent', message, provider));
  const art = new StartupArt();
  let artMode = options.startupArt ?? 'auto';
  // Chosen from the environment (after the one Kitty graphics query over SSH) and again when /art changes the setting.
  let artShown = artShow(artMode, process.env);
  /** The image tier draws the mosaic until the picture is converted for Kitty graphics. */
  const loadArtImage = () => artShown === 'image' ? art.loadImage().catch(() => {}) : Promise.resolve();
  let artViewport = 0, artHidden = 0;
  function placeholder(width: number): string[] {
    const configured = hasModelConfiguration(harness.session.model);
    const content = configured
      ? [colorText(theme!, 'accent', 'What are we building?'), '',
        'Describe a change below. Your agent works in this task.', '',
        '/workbench  Files and terminal', '/help       Commands and keyboard controls']
      : [colorText(theme!, 'accent', 'Start with your workspace'), '',
        '/connect    Connect a provider privately',
        '/model      Choose a model', '',
        '/workbench  Edit files without a model',
        'Never paste keys or sign-in codes into chat.'];
    if (terminal.rows < 18) return wrapTextWithAnsi(configured ? '/workbench files · /help controls' : '/connect to begin · /workbench to edit', width);
    return ['', ...content.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 2)))].map(line => ' ' + line);
  }
  /** The art is the first block of the transcript, sized so it fits above the placeholder; it scrolls away with the conversation. */
  function artBlock(width: number, below: number): string[] {
    artViewport = transcript.viewportHeight;
    artHidden = transcript.scrollTop;
    return art.block(width, Math.min(artViewport - 6, artViewport - 3 - below, Math.floor(terminal.rows / 2)), artShown,
      text => colorText(theme!, 'muted', text), artHidden);
  }
  const transcript = new class extends ScrollView {
    // The viewport and scroll position are known only after the content renders: render again when they differ from
    // the ones the art was drawn for (the size, and for the real picture which rows are scrolled away).
    override updateLayout(contentHeight: number, viewportHeight: number, render: () => void): void {
      super.updateLayout(contentHeight, viewportHeight, render);
      if (artMode !== 'off' && (Math.floor(viewportHeight) !== artViewport || (artShown === 'image' && this.scrollTop !== artHidden))) render();
    }
  }({
    invalidate() { conversation.invalidate(); },
    render(width) {
      const hint = placeholder(width);
      const lines = conversation.render(width);
      return [...artBlock(width, hint.length), ...lines.length ? lines : hint];
    },
  }, { primary: true, follow: 'end', scrollbar: 'auto' });

  function refreshRequirements(): void {
    try {
      const state = harness.evaluator.read();
      proofAvailable = state.ok;
      if (!state.ok) return;
      checkedAt = new Date().toISOString().slice(11, 19) + ' UTC';
      checkedItems = state.value.items.map(item => ({ id: item.id, title: item.title, status: item.status }));
      if (!checkedItems.some(item => item.id === selectedId)) {
        selectedId = checkedItems.find(item => ['active', 'proposed', 'stale'].includes(item.status))?.id ?? checkedItems[0]?.id;
      }
    } catch { proofAvailable = false; }
  }

  function setNotice(text: string): void { notice = singleLine(text, 800); requestRender(); }

  function changeTheme(id: string): boolean {
    const next = getTheme(id);
    if (!next) { setNotice(`Unknown theme. Choose: ${THEME_IDS.join(', ')}; draft retained.`); return false; }
    theme = next;
    options.onThemeChange?.(next.id);
    setNotice(`Theme: ${next.name}`);
    return true;
  }
  function closeSetup(): void {
    setup?.dispose();
    setup = undefined;
    setFocus(focus);
    requestRender();
  }
  function openSetup(mode: 'model' | 'connect' | 'theme' | 'settings', query = '', draft?: string): void {
    if (closing) return;
    if ((mode === 'model' || mode === 'connect') && (active || externalBusy || externalCancellation)) {
      setNotice('Wait for current work to finish before changing model credentials; draft retained.');
      return;
    }
    setup?.dispose();
    const shared = { theme: () => theme!, rows: () => terminal.rows,
      bodyRows: () => Math.max(1, terminal.rows - (terminal.rows >= 20 ? 7 : 6) - (notice ? 1 : 0)),
      render: requestRender, close: closeSetup, notice: setNotice };
    setup = mode === 'settings' ? new HarnessSettingsPane(harness, shared)
      : new SetupPane(harness, { ...shared, mode, query, selectTheme: changeTheme });
    if (draft !== undefined) clearDraft(draft);
    notice = '';
    renderer.setFocus(setup.input);
    requestRender();
  }
  function openAccount(mode: 'login' | 'logout' | 'account', draft?: string): void {
    if (closing) return;
    if (mode === 'login' && (active || externalBusy || externalCancellation)) {
      setNotice('Wait for current work before signing in; draft retained.'); return;
    }
    setup?.dispose();
    setup = new AccountPane(harness.account, { mode, theme: () => theme!, render: requestRender, close: closeSetup,
      bodyRows: () => Math.max(1, terminal.rows - (terminal.rows >= 20 ? 7 : 6) - (notice ? 1 : 0)) });
    clearDraft(draft);
    renderer.setFocus(setup.input);
    requestRender();
  }
  function openPalette(): void {
    if (setup) closeSetup();
    paletteInput = paletteInput ? undefined : new Input();
    paletteInput?.handleInput('/');
    notice = ''; setFocus(focus);
  }
  function currentCommands(): readonly OmsCommand[] | undefined {
    const draft = paletteInput?.getValue() ?? input.document.text;
    if (setup || closing || (!paletteInput && (focus !== 'input' || draft === dismissedCommands))) return undefined;
    const choices = commandMatches(draft);
    if (draft !== commandDraft) { commandDraft = draft; commandIndex = 0; }
    if (choices) commandIndex = Math.max(0, Math.min(commandIndex, choices.length - 1));
    return choices;
  }
  function completeCommand(command: OmsCommand, execute: boolean): void {
    if (paletteInput) {
      const value = `/${command.name}${!execute || 'needsArgument' in command ? ' ' : ''}`;
      paletteInput.setValue(value);
      paletteInput.handleInput('\x05');
      if (execute && !('needsArgument' in command)) {
        paletteInput = undefined; setFocus(focus); submit(value, true);
      }
      requestRender(); return;
    }
    input.document.select(0, input.document.text.length);
    input.document.insert(`/${command.name}${!execute || 'needsArgument' in command ? ' ' : ''}`);
    input.focus.invalidate();
    if (execute && !('needsArgument' in command)) submit();
    requestRender();
  }
  function setFocus(next: Focus): void {
    focus = next;
    renderer.setFocus(setup ? setup.input : paletteInput ?? (next === 'input' ? input.focus : next === 'editor' ? workbench.focus :
      next === 'terminal' ? shell.focus : next === 'actions' ? appActions : null));
    requestRender();
  }
  function switchView(next: 'harness' | 'workbench'): void {
    if (closing || setup || next === view) return;
    if (view === 'harness') harnessFocus = focus; else workbenchFocus = focus;
    view = next;
    options.onViewChange?.(next);
    setFocus(next === 'harness' ? harnessFocus : workbenchFocus);
    repairHiddenFocus();
    notice = '';
  }
  function editorAction(action: () => void | Promise<void>): void {
    switchView('workbench');
    setFocus('editor');
    Promise.resolve().then(action).catch(error => setNotice(error instanceof Error ? error.message : 'Editor action failed.'));
  }
  function terminalAction(action: string): void {
    switchView('workbench');
    if (action === 'hide') {
      terminalVisible = false;
      if (focus === 'terminal') setFocus('editor');
    } else if (action === 'stop') {
      terminalVisible = true; setFocus('terminal');
      void shell.stop().catch(error => setNotice(error instanceof Error ? error.message : 'Terminal cleanup failed; use /terminal stop to retry.'));
    } else if (!action || action === 'start') {
      terminalVisible = true; setFocus('terminal'); void shell.start();
    } else setNotice('Use /terminal, /terminal stop or /terminal hide.');
    requestRender();
  }
  function requirementsShown(width = terminal.columns): boolean { return view === 'harness' && requirementsVisible && width >= 78; }
  function repairHiddenFocus(): void {
    if (setup) return;
    if (focus === 'requirements' && !requirementsShown()) setFocus('input');
    if (view === 'harness' && (focus === 'editor' || focus === 'terminal')) setFocus('input');
    if (view === 'workbench' && focus === 'terminal' && !terminalVisible) setFocus('editor');
    if (view === 'workbench' && focus === 'conversation' && (!agentPanelVisible || terminal.columns < 118)) setFocus('input');
  }
  function toggleRequirements(): void {
    requirementsVisible = !requirementsVisible;
    repairHiddenFocus();
    requestRender();
  }
  function selectedModelChoice() {
    const model = harness.session.model;
    return model && harness.listModels().find(choice => choice.provider === model.provider && choice.id === model.id);
  }
  function budgetSummary(): string {
    const budget = harness.budget.snapshot();
    const microUsd = budget.remaining.spendMicroUsd;
    const dollars = `${Math.trunc(microUsd / 1_000_000)}.${String(microUsd % 1_000_000).padStart(6, '0')}`;
    const scope = budget.executionMode === 'interactive' ? 'this turn' : 'run';
    return `${scope}: ${budget.remaining.tokens}t · ${Math.ceil(budget.remaining.wallClockMs / 1000)}s · API $${dollars} left · ${singleLine(budget.accounting, 80)}${budget.exhausted ? ' EXHAUSTED' : ''}`;
  }
  function roleSummary(): string {
    const reservations = harness.budget.reservations();
    const receipts = new Map(harness.budget.receipts().map(receipt => [receipt.dispatchId, receipt]));
    return (['worker'] as const).map(role => {
      const admitted = reservations.filter(item => (item.provenance?.role ?? 'worker') === role);
      if (admitted.length === 0) return '';
      let tokens = 0, cost = 0, cacheRead = 0, cacheWrite = 0, missing = false, unknown = 0;
      for (const item of admitted) {
        const receipt = receipts.get(item.dispatchId);
        if (!receipt || receipt.outcome === 'uncertain') { unknown++; continue; }
        if (receipt.outcome !== 'known') continue;
        tokens += receipt.tokens ?? 0; cost += receipt.spendMicroUsd ?? 0;
        if (receipt.usage) { cacheRead += receipt.usage.cacheReadTokens; cacheWrite += receipt.usage.cacheWriteTokens; }
        else missing = true;
      }
      return `${role}: ${admitted.length} calls · ${tokens} known tokens · $${(cost / 1e6).toFixed(6)} known spend · ${unknown} pending/unknown · ${missing ? 'historical cache counts unavailable' : `cache read ${cacheRead} / write ${cacheWrite}`}`;
    }).filter(Boolean).join('\n');
  }
  function clearDraft(snapshot: string | undefined): void {
    if (snapshot === undefined || input.document.text !== snapshot) return;
    input.document.select(0, snapshot.length);
    input.document.insert('');
    input.focus.invalidate();
  }
  function maybeFinish(): void {
    if (closing && shutdownComplete && !active && !externalBusy && !externalCancellation) {
      if (failure) reject(failure); else resolve();
    }
  }

  function abortAgent(action: Action): void {
    // Invoke immediately: agent_start is the last boundary before the SDK's first request.
    // An earlier abort during async preflight cannot cancel a run that does not exist yet.
    const attempt = (async () => { await harness.session.abort(); })();
    const previous = action.cancellation;
    action.cancellation = (async () => {
      const results = await Promise.allSettled(previous ? [previous, attempt] : [attempt]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    })();
    // Observe immediately, while retaining rejection for the operation's finalizer.
    void action.cancellation.catch(error => { setNotice(`Cancellation failed: ${describeValue(error instanceof Error ? error.message : error)}`); });
  }

  function actionError(kind: ActionKind, error: unknown, provider?: string): string {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : describeValue(error);
    if (kind !== 'agent') return message;
    // Match only known SDK diagnostics; history uses its recorded provider, preflight the current one.
    const loginHelp = 'Use /login to log into a provider via OAuth or API key. See:';
    const missingAuth = message.startsWith(`No API key found for the selected model.\n\n${loginHelp}`) ||
      (!!provider && message.startsWith(`No API key found for ${provider}.\n\n${loginHelp}`));
    const expiredAuth = !!provider && message === `Authentication failed for "${provider}". Credentials may have expired or network is unavailable. Run '/login ${provider}' to re-authenticate.`;
    if (missingAuth || expiredAuth) return `Authentication unavailable${provider ? ` for ${singleLine(provider, 80)}` : ''}. ${MODEL_CONFIGURATION}`;
    if (message.startsWith(`No model selected.\n\n${loginHelp}`) || message.startsWith(`No models available. ${loginHelp}`)) {
      return `Model unavailable. ${MODEL_CONFIGURATION}`;
    }
    return message;
  }

  function cancel(): void {
    if (active) {
      if (active.kind === 'verification' || active.kind === 'review') { setNotice('This operation must finish within its backend timeout; cancellation is unavailable.'); return; }
      if (active.cancellation) return;
      active.controller.abort();
      const action = active;
      setNotice('Cancellation requested; awaiting the actual operation outcome.');
      if (action.kind === 'agent' && action.accepted) abortAgent(action);
      else action.cancellation = Promise.resolve();
    } else if (externalBusy && !externalCancellation) {
      setNotice('Cancellation requested; awaiting the live session outcome.');
      externalCancellation = Promise.resolve().then(() => harness.session.abort()).catch(error => {
        failure = error;
        setNotice(`Cancellation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }).finally(() => { externalCancellation = undefined; maybeFinish(); requestRender(); });
    }
  }

  function quit(force = false): void {
    if (closing) return;
    if (!force && workbench.dirty && !discardConfirmed) {
      discardConfirmed = true;
      setNotice('Ctrl+Q again: discard unsaved files. Any other key keeps them; Ctrl+S saves the active file.');
      return;
    }
    closing = true;
    setNotice('Closing the task controller; awaiting authoritative cleanup.');
    if (active?.kind !== 'verification') cancel();
    shutdown = Promise.resolve().then(() => harness.close()).then(() => {
      shutdownComplete = true;
      maybeFinish();
    }, error => { shutdownComplete = true; fail(error); });
  }

  function begin(kind: ActionKind, draft: string | undefined, operation: (signal: AbortSignal) => Promise<void>): void {
    const action: Action = { kind, draft, accepted: false, controller: new AbortController(), completion: Promise.resolve() };
    active = action;
    notice = '';
    action.completion = Promise.resolve().then(async () => {
      try {
        if (action.controller.signal.aborted) throw new Error('Request cancelled before dispatch; draft retained.');
        await operation(action.controller.signal);
        if (action.error) throw new Error(action.error);
        if (kind !== 'agent' || !action.accepted) clearDraft(draft);
      } catch (error) {
        const message = actionError(kind, error, kind === 'agent' && !action.accepted ? harness.session.model?.provider : undefined);
        // Refusal before agent_start leaves the original text untouched. If an admitted prompt
        // failed after clearing, restore it only when no newer draft would be overwritten.
        if (action.accepted && draft !== undefined && !input.document.text) {
          input.document.insert(draft);
          input.focus.invalidate();
        }
        // An SDK assistant error is already represented by its contextual message.
        if (!action.errorDisplayed) conversation.note(`${kind} failed`, message);
        setNotice(message.endsWith(MODEL_CONFIGURATION) ? message : `${kind} failed; details in conversation. Draft retained.`);
      } finally {
        if (action.cancellation) {
          try { await action.cancellation; }
          catch (error) { failure ??= closing ? error : undefined; }
        }
        if (!closing) refreshRequirements();
        if (active === action) active = undefined;
        requestRender();
        maybeFinish();
      }
    });
    requestRender();
  }

  /** Show a deterministic command's result: a conversation note, and a long result as a read-only workbench report. */
  function showOutput(command: string, output: CommandOutput): void {
    if (closing) return;
    conversation.note(output.title, output.text);
    if (output.report) {
      workbench.openReport(output.report.id, output.report.text, command);
      switchView('workbench'); setFocus('editor');
    } else { switchView('harness'); setFocus('input'); transcript.scrollToEnd(); }
    requestRender();
  }
  function runPrepared(command: string, prepared: Extract<Prepared, { ok: true }>, draft: string | undefined): void {
    if (!READ_ONLY_COMMANDS.has(command)) {
      begin('command', draft, async signal => { showOutput(command, await prepared.run(signal)); });
      return;
    }
    // Reads run beside the agent: they take no action slot and cannot be cancelled, but they are short and bounded.
    clearDraft(draft);
    void prepared.run(new AbortController().signal).then(output => showOutput(command, output), error => {
      if (!closing) conversation.note(`${command} failed`, singleLine(error instanceof Error ? error.message : describeValue(error), 800));
    }).finally(requestRender);
  }
  /** /goal <text>: the agent works until the check passes; settle-gate rules (retry cap, budget, repeated failure) end the loop. */
  function startGoal(text: string, check: string | undefined, draft: string | undefined): void {
    if (!hasModelConfiguration(harness.session.model)) { setNotice(`Model unavailable. ${MODEL_CONFIGURATION}`); return; }
    const choice = selectedModelChoice();
    if (choice?.selectable === false) { setNotice(choice.detail ?? 'Selected model needs setup · /model to choose a connected provider'); return; }
    if (check === undefined && !taskVerifierItem(harness)) {
      setNotice('This task has no open requirement for its verifier to decide. Add a check: /goal <text> --check "<command>"');
      return;
    }
    const current = goal = newGoal(text, check);
    begin('agent', draft, async signal => {
      await runGoalLoop({ goal: current, signal, budget: () => harness.budget.snapshot(),
        say: line => { conversation.note('goal', line); transcript.scrollToEnd(); requestRender(); },
        check: checkSignal => runGoalCheck(harness, current, checkSignal),
        async turn(prompt) {
          await harness.session.prompt(prompt, { expandPromptTemplates: false });
          if (active?.error) throw new Error(active.error);
        } });
    });
  }

  function submit(draft = input.document.text, fromPalette = false): void {
    const composerDraft = fromPalette ? undefined : draft;
    if (!draft.trim()) return;
    const trimmed = draft.trim();
    if (trimmed === '/quit') { quit(); return; }
    if (closing) { setNotice('Closing; draft retained.'); return; }
    if (trimmed === '/quit discard') { quit(true); return; }
    const match = trimmed.startsWith('/') ? /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed) : undefined;
    const command = match?.[1]?.toLowerCase();
    const argument = match?.[2] ?? '';
    if (command === 'newfile') { clearDraft(composerDraft); editorAction(() => workbench.newFile(argument || undefined)); return; }
    if (command === 'theme') {
      if (!argument) { openSetup('theme', '', composerDraft); return; }
      if (!changeTheme(argument)) return;
      clearDraft(composerDraft); requestRender(); return;
    }
    const artModes: Record<string, StartupArtMode> = { on: 'auto', auto: 'auto', image: 'image', truecolor: 'truecolor', 256: '256', off: 'off' };
    if (command === 'art' && (!argument || argument === 'next' || Object.hasOwn(artModes, argument))) {
      clearDraft(composerDraft);
      if (argument && argument !== 'next') {
        artMode = artModes[argument]!;
        artShown = artShow(artMode, process.env);
        options.onStartupArtChange?.(artMode);
        setNotice(`Startup art ${argument}`);
      } else {
        if (argument === 'next') art.next();
        setNotice(`${art.title} · /art next · /art off`);
      }
      void loadArtImage().then(requestRender);
      requestRender(); return;
    }
    if (command === 'web' && ['', 'on', 'off'].includes(argument)) {
      clearDraft(composerDraft);
      if (!harness.web) setNotice('Web access is not available in this session.');
      else {
        if (argument) harness.web.set(argument === 'on');
        const used = harness.web.usage();
        setNotice(`Web ${harness.web.enabled() ? 'on' : 'off'} · ${used.webSearch} searches, ${used.webFetch} fetches, ${used.solanaMcp} Solana MCP calls · /web ${harness.web.enabled() ? 'off' : 'on'}`);
      }
      requestRender(); return;
    }
    if (command === 'model' || command === 'connect' || command === 'settings') { openSetup(command, argument, composerDraft); return; }
    if ((command === 'login' || command === 'logout' || command === 'account') && !argument) { openAccount(command, composerDraft); return; }
    if (command === 'workbench' && !argument) { clearDraft(composerDraft); switchView('workbench'); setFocus('editor'); return; }
    if (command === 'harness' && !argument) { clearDraft(composerDraft); switchView('harness'); setFocus('input'); return; }
    if (command === 'files' && !argument) { clearDraft(composerDraft); editorAction(() => workbench.open()); return; }
    if (command === 'open' && argument) { clearDraft(composerDraft); editorAction(() => workbench.open(argument)); return; }
    if (!argument && command && ['save', 'close', 'find', 'replace', 'next', 'split'].includes(command)) {
      clearDraft(composerDraft);
      editorAction(() => {
        if (command === 'save') return workbench.save();
        if (command === 'close') workbench.closeBuffer();
        if (command === 'find') workbench.find();
        if (command === 'replace') workbench.replace();
        if (command === 'next') workbench.nextBuffer();
        if (command === 'split') workbench.split();
      });
      return;
    }
    if (command === 'terminal') { clearDraft(composerDraft); terminalAction(argument); return; }
    if (command === 'layout' && ['editor', 'balanced', ''].includes(argument)) {
      agentPanelVisible = argument ? argument === 'balanced' : !agentPanelVisible;
      clearDraft(composerDraft); switchView('workbench'); repairHiddenFocus(); requestRender(); return;
    }
    if (command === 'cancel' && !argument) { clearDraft(composerDraft); cancel(); return; }
    if (command === 'help' && !argument) {
      conversation.note('commands', commandHelp() + '\nKeyboard\n' +
        'Commands: type / in the agent composer, empty editor, file browser or stopped terminal. Ctrl+K opens commands anywhere (Alt+/ also works). Plain / in a document, text field or running shell stays text.\n' +
        'Back: Escape closes a menu to its previous pane. From conversation, Escape returns to the agent composer. From the workbench composer, Escape returns to the editor.\n' +
        'Panes: /harness returns to the agent; /workbench focuses the editor; /files opens the browser; /terminal opens the shell. Ctrl+L focuses the composer, Ctrl+P opens files. F6 optionally cycles panes.\n' +
        'Tab/Shift+Tab navigate conversation panes. Editor Tab inserts a tab; terminal Tab goes to the shell.\n' +
        'Toolbar: F10 focuses the toolbar; arrows choose, Enter activates, Esc returns to the pane.\n' +
        'Editor: Ctrl+S save, Ctrl+F find, Ctrl+H replace, Ctrl+W close tab, Ctrl+Tab next tab. Ctrl+\\ changes split side.\n' +
        'Terminal: Ctrl+C interrupts its process; /terminal stop releases it for independent verification.\n' +
        'Agent: Enter sends, Shift/Alt+Enter adds a newline. /cancel requests cancellation. Ctrl+Q quits after cleanup; dirty files need confirmation.\n' +
        'Setup: ↑↓ chooses an authentication method; PgUp/PgDn scrolls disclosures without moving that choice. Ctrl+U clears masked entry. Ctrl+X copies the setup link. Keys and sign-in codes belong only in /connect.');
      clearDraft(composerDraft); switchView('harness'); setFocus('conversation'); transcript.scrollToEnd(); requestRender(); return;
    }
    if (command === 'requirements' && !argument) {
      clearDraft(composerDraft);
      if (terminal.columns < 78) { submit('/status', true); return; }
      switchView('harness'); toggleRequirements(); return;
    }
    const readOnly = !!command && (READ_ONLY_COMMANDS.has(command) || (command === 'goal' && !argument.trim()));
    if ((active || externalBusy || externalCancellation) && !readOnly) {
      setNotice('Work is running. Use /cancel to stop it, or keep editing your next request.'); return;
    }
    if (trimmed.startsWith('/')) {
      if (command === 'status' && !argument) {
        refreshRequirements();
        conversation.note('task status', `Task: ${singleLine(harness.task.id, 120)}\nProof: ${proofAvailable ? 'last checked ' + checkedAt : 'unavailable; prior context retained'}\n` +
          checkedItems.slice(0, 12).map(item => `${singleLine(item.id, 80)}  ${singleLine(item.status, 80)}  ${singleLine(item.title, 160)}`).join('\n') +
          `\nModel: ${selectedModelChoice()?.detail ?? 'Use /model to review connected providers and selection.'}\nToken allowance / spend / time: ${budgetSummary()}\n${roleSummary()}`);
      } else if (command === 'session' && !argument) {
        conversation.note('session', `Session: ${harness.session.sessionManager.getSessionId()}\nRepository: ${harness.workspace.root}\nTask: ${harness.task.id}\nWorktree: ${harness.task.codeRoot}\nBranch: ${harness.task.branch}\nOne live session; changing focus does not dispatch work.`);
      } else if (command === 'review' && !argument) {
        if (workbench.dirty || shell.running) {
          setNotice('Save or close unsaved files and stop the terminal before reviewing.'); return;
        }
        begin('review', composerDraft, async () => {
          conversation.note('security review', REVIEW_DISCLAIMER + '\nRunning offline Phase A static tools.');
          let report: ReviewPresentation | undefined;
          const code = await (options.review ?? runReviewCommand)([harness.task.codeRoot, '--phase', 'A'], {
            stdout() {}, stderr: text => { setNotice(singleLine(text, 500)); }, report: value => { report = value; },
          });
          if (report) {
            const summary = `Confirmed ${report.confirmed} · Suspected ${report.suspected}`;
            conversation.note('security review', summary + '\n' + REVIEW_DISCLAIMER);
            // The editor has a 64 KiB document limit. Keep the full saved report;
            // explicitly mark a bounded preview without splitting Unicode.
            let preview = ''; let bytes = 0;
            for (const character of report.markdown) {
              bytes += Buffer.byteLength(character);
              if (bytes > 60 * 1024) break;
              preview += character;
            }
            if (preview !== report.markdown) preview += '\n[Preview truncated; full report is saved in private review state.]';
            workbench.openReport(report.reviewId, summary + '\n' + preview);
            switchView('workbench'); setFocus('editor');
          }
          if (code !== 0) throw new Error(report ? 'Partial review saved; one or more stages failed.' : 'Review did not produce a report. See the review status.');
        });
        return;
      } else if (command === 'verify' && !/\s/.test(argument)) {
        const id = argument || selectedId;
        begin('verification', composerDraft, async () => {
          const verification = await harness.verify(id);
          const result = verification.result;
          conversation.note('verification', `${verification.itemId}: ${result.closed ? 'closed by independent verification' : result.reason}`);
        });
        return;
      } else if (command === 'run' && argument.trim()) {
        begin('command', composerDraft, async signal => {
          const result = await harness.runCommand(argument, signal);
          conversation.note('sandbox command', `$ ${argument}\nExit: ${result.exitCode}${result.timedOut ? ' · timed out' : ''}${result.cancelled ? ' · cancelled' : ''}\n${result.stdout}\n${result.stderr}${result.truncated ? '\n[backend output truncated]' : ''}`);
          if (result.exitCode !== 0 || result.timedOut || result.cancelled) throw new Error(`Sandbox command did not succeed (exit ${result.exitCode}); draft retained.`);
        });
        return;
      } else if (command === 'goal') {
        const request = parseGoalArguments(argument);
        if (request.kind === 'error') { setNotice(`${request.message} Draft retained.`); return; }
        if (request.kind === 'set') { startGoal(request.text, request.check, composerDraft); return; }
        if (request.kind === 'clear') { goal = undefined; conversation.note('goal', 'Goal cleared.'); }
        else conversation.note('goal', goalSummary(goal, budgetSummary()));
      } else if (command === 'clear') {
        if (argument) { setNotice('Usage: /clear; draft retained.'); return; }
        try {
          harness.session.agent.reset();
          // The session file keeps its history; the next entry starts a new branch, so a resume sees only what follows.
          harness.session.sessionManager.resetLeaf();
        } catch (error) { setNotice(`Could not clear the conversation: ${singleLine(error instanceof Error ? error.message : 'unknown error', 200)}`); return; }
        goal = undefined;
        conversation.clear();
        conversation.note('new conversation', 'Fresh conversation in the same task. Files, worktree and task state are unchanged.');
      } else {
        const prepared = command ? prepareSlash(command, argument, harness, budgetSummary()) : undefined;
        if (!prepared) { setNotice('Unknown or invalid OMS command. Use /help; draft retained.'); return; }
        if (!prepared.ok) { setNotice(`${prepared.message} Draft retained.`); return; }
        runPrepared(command!, prepared, composerDraft);
        return;
      }
      clearDraft(composerDraft);
      switchView('harness');
      setFocus('input');
      transcript.scrollToEnd();
      setNotice('');
      return;
    }
    if (!hasModelConfiguration(harness.session.model)) { setNotice(`Model unavailable. ${MODEL_CONFIGURATION}`); return; }
    const choice = selectedModelChoice();
    if (choice?.selectable === false) {
      const detail = choice.detail ?? 'Selected model needs setup · /model to choose a connected provider';
      conversation.note('model unavailable', detail);
      transcript.scrollToEnd();
      setNotice(detail);
      return;
    }
    begin('agent', draft, async () => { await harness.session.prompt(draft, { expandPromptTemplates: false }); });
  }

  const rail: Component = {
    invalidate() {},
    render(width) {
      const lines = [colorText(theme!, 'muted', 'Requirements'), ''];
      for (const item of checkedItems) {
        const selected = item.id === selectedId;
        lines.push(colorText(theme!, selected ? 'accent' : 'foreground',
          truncateToWidth(`${selected ? '> ' : '  '}${singleLine(item.id, 80)}  ${singleLine(item.status, 80)}`, width)));
        lines.push(truncateToWidth(`  ${singleLine(item.title, 400)}`, width), '');
      }
      if (lines.length === 2) lines.push('Task state unavailable');
      return lines;
    },
  };
  const railView = new ScrollView(rail, { scrollbar: 'auto', overscroll: 'contain' });
  const appActions = new ActionBar(() => [
    { id: 'harness', label: 'Harness', active: view === 'harness', onPress: () => submit('/harness', true) },
    { id: 'workbench', label: 'Workbench', active: view === 'workbench', onPress: () => submit('/workbench', true) },
    { id: 'commands', label: 'Commands', icon: '≡', onPress: () => openPalette() },
    { id: 'files', label: 'Files', icon: '▸', onPress: () => submit('/files', true) },
    { id: 'model', label: 'Model', disabled: !!active || externalBusy, onPress: () => openSetup('model') },
    { id: 'settings', label: 'Settings', onPress: () => openSetup('settings') },
    { id: 'help', label: 'Help', icon: '?', onPress: () => submit('/help', true) },
  ], { theme: () => theme!, render: requestRender, onEscape: () => setFocus(view === 'harness' ? 'input' : 'editor') });
  const composerActions = new ActionBar(() => [
    { id: 'send', label: 'Send', icon: '↑', disabled: !input.document.text.trim() || !!active || externalBusy, onPress: () => submit() },
    { id: 'cancel', label: 'Cancel', icon: '×', disabled: (!active && !externalBusy) || active?.kind === 'verification', onPress: cancel },
    { id: 'commands', label: 'Commands', icon: '/', onPress: () => openPalette() },
  ], { theme: () => theme!, render: requestRender });
  const setupActions = new ActionBar(() => [
    { id: 'back', label: 'Back', icon: '‹', onPress: closeSetup },
    { id: 'confirm', label: 'Confirm', icon: '↵', onPress: () => setup?.handleInput('\r') },
  ], { theme: () => theme!, render: requestRender });
  const component = (render: (width: number) => string[]): Component => ({ render, invalidate() {} });
  const header = component(width => {
    const state = closing ? 'closing' : active ? active.cancellation ? 'cancelling' : active.kind : externalBusy ? 'agent running' : 'idle';
    const workspace = `${colorText(theme!, 'warning', 'oms')} · ${view === 'harness' ? 'Harness' : 'Workbench'} · ${singleLine(basename(harness.workspace.root), 160)}`;
    const activity = `${state}${shell.cleanupUncertain ? ' · shell cleanup unknown' : shell.running ? ' · shell running' : ''}`;
    return [paintThemeRow(theme!, alignEnds(workspace, activity, width), width)];
  });
  const status = component(width => {
    const model = harness.session.model;
    const choice = selectedModelChoice();
    const modelLabel = model && hasModelConfiguration(model)
      ? `${singleLine(model.provider, 80)}/${singleLine(model.id, 120)}${choice?.selectable === false ? ' · unavailable · /model' : ''}` : 'No model · /connect or /model';
    const budget = harness.budget.snapshot();
    const scope = budget.executionMode === 'interactive'
      ? (['tokens', 'wallClockMs'] as const) : (['tokens', 'spendMicroUsd', 'wallClockMs'] as const);
    const low = scope.some(key => budget.remaining[key] <= 0 || budget.remaining[key] <= budget.caps[key] * 0.1);
    const exhausted = budget.exhausted;
    const risk = exhausted ? `Budget EXHAUSTED${budget.accounting === 'unknown' ? ' · unknown' : ''}`
      : budget.accounting === 'unknown' ? 'Budget unknown' : low ? 'Budget low' : '';
    const tail = modelLabel;
    const summary = risk ? `${risk} · /status${width >= 65 ? '  |  ' + tail : ''}` : tail;
    return [truncateToWidth(colorText(theme!, risk ? 'warning' : 'muted', summary), width)];
  });
  const inputLabel = component(width => {
    const label = truncateToWidth(setup ? setup.label : paletteInput ? '─ Commands · Esc back' :
      `─ ${focus === 'input' ? '> ' : ''}Agent · / commands${width >= 55 ? ' · Enter send · Shift+Enter newline' : ' · Enter send'}`, width, '');
    return [colorText(theme!, 'accent', label) + colorText(theme!, 'muted', '─'.repeat(Math.max(0, width - visibleWidth(label))))];
  });
  const noticeRow = component(width => [truncateToWidth(colorText(theme!, 'warning', notice), width)]);
  const footer = component(width => [truncateToWidth(colorText(theme!, 'muted',
    setup ? setup.hint :
      paletteInput ? '↑↓ choose · Enter run · Esc back' :
      focus === 'editor' || focus === 'terminal' ? `${focus} · Ctrl+K commands · Ctrl+L agent${width >= 65 ? ' · /help keys' : ''}` :
        `${focus} · Ctrl+K commands · /help${width >= 65 ? ' keys · Ctrl+L agent' : ''}`), width, '')]);
  const commandMenu = component(width => {
    const choices = currentCommands();
    if (!choices) return [];
    if (!choices.length) return [colorText(theme!, 'warning', 'No matching commands. Use /help.')];
    const count = Math.max(1, Math.min(10, terminal.rows - 10));
    const start = Math.max(0, commandIndex - count + 1);
    return [colorText(theme!, 'muted', `Commands · ${commandIndex + 1}/${choices.length}`),
      ...choices.slice(start, start + count).map((command, offset) => colorText(theme!,
        start + offset === commandIndex ? 'accent' : 'foreground',
        truncateToWidth(`${start + offset === commandIndex ? '> ' : '  '}/${command.name.padEnd(12)} ${command.group}${width >= 65 ? ' · ' + command.description : ''}`, width, '')))];
  });
  const setupBody = component(width => setup?.body.render(width) ?? []);
  const setupInput = component(width => setup?.input.render(width) ?? []);
  const conversationFrame = new PaneFrame(transcript, { theme: () => theme!, title: () => 'Conversation',
    focused: () => focus === 'conversation', rows: () => terminal.rows, compact: () => terminal.rows < 20,
    onFocus: () => setFocus('conversation') });
  const composerBody = new VStack([
    { component: input.view, basis: 0, grow: 1, minSize: 1 },
    { component: composerActions, basis: 1, shrink: 0, visible: () => terminal.rows >= 20 },
  ]);
  const composerFrame = new PaneFrame(composerBody, { theme: () => theme!, title: () => 'Agent · Enter send · / commands',
    focused: () => focus === 'input', rows: () => terminal.rows, compact: () => terminal.rows < 20,
    onFocus: () => setFocus('input') });
  const setupFrame = new PaneFrame(setupBody, { theme: () => theme!, title: () => setup?.label ?? 'Setup',
    focused: () => !!setup, rows: () => terminal.rows, compact: () => terminal.rows < 20 });
  const paletteField = component(width => paletteInput?.render(width) ?? []);
  const body = new HStack([
    { component: railView, basis: 27, shrink: 0, visible: viewport => requirementsShown(viewport.width) },
    { component: conversationFrame, basis: 0, grow: 1, shrink: 1, minSize: 1 },
  ], { gap: 2 });
  const workbenchBody = new HStack([
    { component: workbench.body, basis: 0, grow: 1, minSize: 1 },
    { component: conversationFrame, basis: 36, shrink: 0, visible: viewport => agentPanelVisible && viewport.width >= 118 },
  ], { gap: 2 });
  const workbenchLayout = new VStack([
    { component: workbenchBody, basis: 0, grow: 1, minSize: 1,
      visible: () => terminal.rows >= 20 || focus !== 'terminal' || !terminalVisible },
    { component: shell.body, basis: 10, shrink: 1, minSize: 3,
      visible: () => terminalVisible && (terminal.rows >= 20 || focus === 'terminal') },
  ]);
  const approvalRow = component(width => hostApproval ? wrapTextWithAnsi(displayText(hostApproval.text, 4096), width) : []);
  const layoutRoot = new VStack([
    { component: approvalRow, basis: 'auto', shrink: 0, visible: () => !!hostApproval },
    { component: header, basis: 'auto', shrink: 1, minSize: 1 },
    { component: appActions, basis: 1, shrink: 0, visible: () => !setup && !paletteInput },
    { component: body, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => !setup && view === 'harness' },
    { component: workbenchLayout, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => !setup && view === 'workbench' },
    { component: setupFrame, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => !!setup },
    { component: commandMenu, basis: 'auto', shrink: 0, visible: () => currentCommands() !== undefined },
    { component: inputLabel, basis: 1, shrink: 0,
      visible: () => !!paletteInput || (!!setup && terminal.rows < 20) ||
        (terminal.rows < 20 && (view === 'harness' || focus === 'input')) },
    { component: composerFrame, basis: terminal.rows >= 24 ? 7 : terminal.rows >= 20 ? 6 : 3, shrink: 1, minSize: 1,
      visible: () => !setup && !paletteInput && (view === 'harness' || focus === 'input') },
    { component: paletteField, basis: 1, shrink: 0, visible: () => !!paletteInput },
    { component: setupInput, basis: 1, shrink: 0, visible: () => !!setup },
    { component: setupActions, basis: 1, shrink: 0, visible: () => !!setup },
    { component: noticeRow, basis: 1, shrink: 0, visible: () => !!notice },
    { component: status, basis: 1, shrink: 0 },
    { component: footer, basis: 1, shrink: 0 },
  ]);
  const composerLayoutEntry = layoutRoot[LAYOUT_NODE]().entries.find(entry => entry.component === composerFrame)!;
  renderer.setLayoutRoot(layoutRoot);
  setFocus(focus);
  function changeFocus(backward = false): void {
    const order: Focus[] = view === 'harness'
      ? requirementsShown() ? ['input', 'requirements', 'conversation'] : ['input', 'conversation']
      : ['editor', ...(terminalVisible ? ['terminal' as const] : []), 'input',
        ...(agentPanelVisible && terminal.columns >= 118 ? ['conversation' as const] : [])];
    setFocus(order[(order.indexOf(focus) + (backward ? order.length - 1 : 1)) % order.length]!);
  }
  harness.setHostApproval?.((request, signal) => new Promise<boolean>(resolve => {
    if (closing || signal?.aborted || hostApproval) { resolve(false); return; }
    const abort = () => finish(false);
    const finish = (allowed: boolean) => {
      signal?.removeEventListener('abort', abort);
      hostApproval = undefined;
      requestRender();
      resolve(allowed);
    };
    hostApproval = { text: `Allow host command? ${request.reasons.join(', ')}\n${request.command}\nY = allow · N / Escape = deny`, answer: finish };
    signal?.addEventListener('abort', abort, { once: true });
    conversation.note('Host approval required', hostApproval.text);
    requestRender();
  }));
  const removeInput = renderer.addInputListener(data => {
    try {
      repairHiddenFocus();
      if (isKeyRelease(data)) return { consume: true };
      if (hostApproval) {
        if (data.toLowerCase() === 'y') hostApproval.answer(true);
        else if (data.toLowerCase() === 'n' || matchesKey(data, 'escape')) hostApproval.answer(false);
        else if (matchesKey(data, 'ctrl+q') || matchesKey(data, 'ctrl+c')) { hostApproval.answer(false); quit(); }
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+q') || (matchesKey(data, 'ctrl+c') && focus !== 'terminal' && focus !== 'editor')) {
        quit(); return { consume: true };
      }
      if (discardConfirmed) notice = '';
      discardConfirmed = false;
      if (closing) return { consume: true };
      const slashNavigation = data === '/' && !setup && !paletteInput &&
        ((focus === 'editor' && !workbench.acceptsText) || (focus === 'terminal' && !shell.running));
      if (matchesKey(data, 'ctrl+k') || matchesKey(data, 'alt+/') || slashNavigation) {
        openPalette(); return { consume: true };
      }
      if (setup && !matchesKey(data, 'f8')) { setup.handleInput(data); return { consume: true }; }
      if (paletteInput) {
        if (matchesKey(data, 'escape')) { paletteInput = undefined; setFocus(focus); return { consume: true }; }
        const choices = currentCommands() ?? [];
        if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
          commandIndex = Math.max(0, Math.min(choices.length - 1, commandIndex + (matchesKey(data, 'up') ? -1 : 1)));
        } else if ((matchesKey(data, 'tab') || matchesKey(data, 'enter')) && choices[commandIndex]) {
          completeCommand(choices[commandIndex]!, matchesKey(data, 'enter'));
        } else if (matchesKey(data, 'enter')) {
          const draft = paletteInput.getValue();
          paletteInput = undefined; setFocus(focus);
          if (draft.startsWith('/')) submit(draft, true);
        } else {
          paletteInput.handleInput(data);
          paletteInput.setValue(paletteInput.getValue().replace(/[\r\n]/g, ' ').slice(0, 1024));
        }
        requestRender(); return { consume: true };
      }
      if (matchesKey(data, 'f3')) { switchView(view === 'harness' ? 'workbench' : 'harness'); return { consume: true }; }
      if (matchesKey(data, 'f10')) { setFocus('actions'); return { consume: true }; }
      if (focus === 'actions') { appActions.handleInput(data); return { consume: true }; }
      if (matchesKey(data, 'f6')) { changeFocus(); return { consume: true }; }
      if (matchesKey(data, 'ctrl+l')) { setFocus('input'); return { consume: true }; }
      if (matchesKey(data, 'ctrl+p')) { editorAction(() => workbench.open()); return { consume: true }; }
      if (matchesKey(data, 'f4')) { openSetup('model'); return { consume: true }; }
      if (matchesKey(data, 'f8')) {
        changeTheme(THEME_IDS[(THEME_IDS.indexOf(theme!.id) + 1) % THEME_IDS.length]!);
        return { consume: true };
      }
      if (focus === 'terminal') { shell.focus.handleInput?.(data); return { consume: true }; }
      if (focus === 'editor') { workbench.handleInput(data); return { consume: true }; }
      if (matchesKey(data, 'escape')) {
        if (currentCommands() !== undefined) { dismissedCommands = input.document.text; requestRender(); }
        else if (focus !== 'input') setFocus('input');
        else if (view === 'workbench') setFocus('editor');
        else cancel();
        return { consume: true };
      }
      if (matchesKey(data, 'f2')) { toggleRequirements(); return { consume: true }; }
      // Paste is handled only by the shared lossless editor, never parsed as an action.
      if (data.startsWith('\x1b[200~')) {
        if (focus === 'input') input.focus.handleInput?.(data);
        return { consume: true };
      }
      const commands = currentCommands();
      if (commands && focus === 'input') {
        if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
          commandIndex = Math.max(0, Math.min(commands.length - 1, commandIndex + (matchesKey(data, 'up') ? -1 : 1)));
          requestRender(); return { consume: true };
        }
        const selected = commands[commandIndex];
        if ((matchesKey(data, 'tab') || matchesKey(data, 'enter')) && selected) {
          completeCommand(selected, matchesKey(data, 'enter'));
          return { consume: true };
        }
      }
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) { changeFocus(matchesKey(data, 'shift+tab')); return { consume: true }; }
      if (focus === 'input') {
        if (matchesKey(data, 'shift+enter') || matchesKey(data, 'alt+enter') || data === '\x1b\r') {
          input.focus.handleInput?.('\r'); return { consume: true };
        }
        if (matchesKey(data, 'enter')) { submit(); return { consume: true }; }
        return undefined;
      }
      if (focus === 'requirements') {
        const items = checkedItems;
        let selected = items.findIndex(item => item.id === selectedId);
        const up = matchesKey(data, 'up');
        const down = matchesKey(data, 'down');
        const pageUp = matchesKey(data, 'pageUp');
        const pageDown = matchesKey(data, 'pageDown');
        const first = matchesKey(data, 'home') || matchesKey(data, 'ctrl+home');
        const last = matchesKey(data, 'end') || matchesKey(data, 'ctrl+end');
        if (up || down || pageUp || pageDown || first || last) {
          const distance = pageUp || pageDown ? Math.max(1, Math.floor(railView.viewportHeight / 3)) : 1;
          selected = first ? 0 : last ? items.length - 1 : Math.max(0, Math.min(items.length - 1, selected + (up || pageUp ? -distance : distance)));
          selectedId = items[selected]?.id;
          railView.scrollTo(Math.max(0, selected * 3 - 1));
        }
        if (matchesKey(data, 'enter')) { focus = 'input'; renderer.setFocus(input.focus); }
      } else {
        if (matchesKey(data, 'up')) transcript.scrollBy(-1);
        if (matchesKey(data, 'down')) transcript.scrollBy(1);
        if (matchesKey(data, 'pageUp')) transcript.scrollBy(-Math.max(1, transcript.viewportHeight - 1));
        if (matchesKey(data, 'pageDown')) transcript.scrollBy(Math.max(1, transcript.viewportHeight - 1));
        if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+home')) transcript.scrollToStart();
        if (matchesKey(data, 'end') || matchesKey(data, 'ctrl+end')) transcript.scrollToEnd();
      }
      requestRender();
      return { consume: true };
    } catch (error) { fail(error); return { consume: true }; }
  });
  let unsubscribe: (() => void) | undefined;
  let clock: NodeJS.Timeout | undefined;
  const onSignal = () => quit(true);
  try {
    // The fullscreen renderer consults the public registry before dispatching input.
    // Disable its navigation/search defaults so only the currently focused OMS pane owns keys.
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, ownedBindings));
    refreshRequirements();
    unsubscribe = harness.session.subscribe(event => {
      try {
        conversation.accept(event);
        if (event.type === 'message_end' && active?.kind === 'agent' && event.message.role === 'assistant' &&
          event.message.stopReason === 'error') {
          active.error = actionError('agent', event.message.errorMessage || 'The provider request failed.', event.message.provider);
          active.errorDisplayed = !!event.message.errorMessage;
        }
        if (event.type === 'agent_start') {
          externalBusy = true;
          if (active?.kind === 'agent') {
            active.accepted = true;
            clearDraft(active.draft);
            if (active.controller.signal.aborted) abortAgent(active);
          }
        }
        if (event.type === 'agent_settled') {
          externalBusy = false;
          if (!closing) refreshRequirements();
          sessionSettled?.();
          maybeFinish();
        }
        if (event.type === 'tool_execution_end' && ['write', 'edit', 'bash', 'propose_done'].includes(event.toolName) && !closing) refreshRequirements();
        requestRender();
      } catch (error) { fail(error); }
    });
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    if (!options.terminal) {
      await settleKittyGraphics(artMode, process.env);
      artShown = artShow(artMode, process.env);
    }
    await loadArtImage();
    renderer.start();
    terminal.write('\x1b[22;0t');
    titleSaved = true;
    terminal.setTitle(`oms · ${singleLine(basename(harness.workspace.root), 120)} / ${singleLine(harness.task.id, 80)}`);
    clock = setInterval(requestRender, 1000);
    await finished;
  } finally {
    closing = true;
    hostApproval?.answer(false);
    harness.setHostApproval?.(undefined);
    clearInterval(clock);
    process.off('SIGINT', onSignal);
    setup?.dispose();
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    removeInput();
    // Even an exceptional render/input failure cannot leave a dispatched operation unobserved.
    try {
      if (active) { cancel(); await active.completion; }
      if (externalBusy) {
        const settled = new Promise<void>(yes => { sessionSettled = yes; });
        cancel();
        await settled;
      }
      if (externalCancellation) await externalCancellation;
      if (shutdown) await shutdown;
    } finally {
      workbench.dispose();
      await shell.dispose();
      unsubscribe?.();
      disposed = true;
      try { await terminal.drainInput(200, 25); }
      finally {
        try { renderer.stop({ preserveScreen: true }); }
        catch (error) {
          // A renderer reset failure must not skip the terminal's own mode restoration.
          terminal.stop();
          terminal.showCursor();
          throw error;
        }
        finally {
          try { if (titleSaved) terminal.write('\x1b[23;0t'); }
          finally { setKeybindings(previousKeybindings); }
        }
      }
    }
  }
}
