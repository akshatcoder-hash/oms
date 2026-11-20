import {
  SettingsList,
  truncateToWidth,
  type Component,
  type Focusable,
  type SettingItem,
} from '@earendil-works/pi-tui';
import type { HarnessSession, HarnessSettingsSnapshot } from '@oms/engine';
import { glyphsFor } from './glyphs.ts';
import { colorText, type OmsTheme } from './theme.ts';
import { displayText } from './transcript.ts';

interface HarnessSettingsOptions {
  theme: () => OmsTheme;
  rows: () => number;
  bodyRows?: () => number;
  render: () => void;
  close: () => void;
  notice: (message: string) => void;
}

/** The upstream settings list, with only live harness controls and explicit noninteractive policy rows. */
export class HarnessSettingsPane {
  readonly body: Component;
  readonly input: Component & Focusable;
  private readonly harness: Pick<HarnessSession, 'settings'>;
  private readonly options: HarnessSettingsOptions;
  private list: SettingsList | undefined;
  private listRows = 0;
  private pending = false;
  private disposed = false;
  private message = '';

  constructor(harness: Pick<HarnessSession, 'settings'>, options: HarnessSettingsOptions) {
    this.harness = harness;
    this.options = options;
    this.body = { invalidate: () => this.list?.invalidate(), render: (width) => this.renderBody(width) };
    this.input = {
      focused: false,
      invalidate() {},
      handleInput: (data) => this.handleInput(data),
      render: (width) => [
        truncateToWidth(
          colorText(options.theme(), 'muted', this.pending ? 'Saving preference…' : 'Type to filter'),
          width,
          '',
        ),
      ],
    };
  }

  get label(): string {
    return 'Settings';
  }
  get hint(): string {
    return '↑↓ choose · enter change · type to filter · esc close';
  }

  private items(state: HarnessSettingsSnapshot): SettingItem[] {
    return [
      {
        id: 'thinking',
        label: 'Thinking',
        currentValue: state.supportsThinking ? state.thinkingLevel : 'unavailable',
        description: state.supportsThinking
          ? 'Applies now and saves the default plus this model’s thinking preference.'
          : 'The current model does not support thinking. Choose a reasoning model with /model.',
        ...(state.supportsThinking ? { values: state.availableThinkingLevels } : {}),
      },
      {
        id: 'steering',
        label: 'Steering queue',
        currentValue: state.steeringMode,
        values: ['one-at-a-time', 'all'],
        description: 'How queued steering messages reach the live agent. Existing messages are retained.',
      },
      {
        id: 'followup',
        label: 'Follow-up queue',
        currentValue: state.followUpMode,
        values: ['one-at-a-time', 'all'],
        description:
          'How queued follow-ups reach the live agent after its current work. Existing messages are retained.',
      },
      {
        id: 'http',
        label: 'HTTP idle (ms)',
        currentValue: String(state.httpIdleTimeoutMs),
        values: [...new Set(['30000', '60000', '120000', '300000', '0', String(state.httpIdleTimeoutMs)])],
        description:
          'Applies to the next provider request. 0 disables the idle timeout; the task wall-clock budget still applies.',
      },
      {
        id: 'model',
        label: 'Default model',
        currentValue: displayText(state.defaultModel, 200),
        description: 'Use /model to choose and save a model from the configured provider catalog.',
      },
      {
        id: 'compaction',
        label: 'Compaction',
        currentValue: 'off · policy',
        description:
          'Budget guard: automatic summaries and branch summaries would create additional unmetered model calls.',
      },
      {
        id: 'warming',
        label: 'Cache warming',
        currentValue: 'off · policy',
        description: 'Budget guard: no background or speculative model requests.',
      },
      {
        id: 'retry',
        label: 'Retries',
        currentValue: 'off · policy',
        description: 'Budget guard: provider and agent retries cannot create hidden extra requests.',
      },
      {
        id: 'transport',
        label: 'Transport',
        currentValue: 'SSE · policy',
        description:
          'Only the priced, metered streaming path is enabled; websocket and cached transports are constrained.',
      },
      {
        id: 'resources',
        label: 'Host resources',
        currentValue: 'off · policy',
        description:
          'No repository/global executable discovery, packages, extensions, skills or prompts. Project settings are never trusted.',
      },
      {
        id: 'tools',
        label: 'Execution backend',
        currentValue: state.executionBackend ?? 'docker',
        description:
          state.executionBackend === 'host'
            ? 'No sandbox. Commands need approval; network is unrestricted. Set OMS_SANDBOX=docker or launch with --sandbox docker for a new task.'
            : 'Strict Docker sandbox. Set OMS_SANDBOX=host or launch with --sandbox host for a new task. Backend identity is pinned per task.',
      },
      {
        id: 'telemetry',
        label: 'Telemetry',
        currentValue: 'off · policy',
        description:
          'Analytics and install telemetry are disabled. Credentials and device identity are never shown in settings.',
      },
    ];
  }

  private ensureList(): SettingsList {
    const rows = Math.max(1, Math.min(10, (this.options.bodyRows?.() ?? this.options.rows() - 5) - 9));
    if (!this.list || rows !== this.listRows) {
      const palette = () => this.options.theme();
      this.list = new SettingsList(
        this.items(this.harness.settings.snapshot()),
        rows,
        {
          label: (text, selected) => colorText(palette(), selected ? 'accent' : 'foreground', text),
          value: (text, selected) => colorText(palette(), selected ? 'accent' : 'muted', text),
          description: (text) => colorText(palette(), 'muted', text),
          cursor: `${glyphsFor().pointer} `,
          hint: (text) => colorText(palette(), 'muted', text),
        },
        (id, value) => {
          void this.change(id, value);
        },
        this.options.close,
        { enableSearch: true },
      );
      this.listRows = rows;
    }
    return this.list;
  }

  private renderBody(width: number): string[] {
    const palette = this.options.theme();
    const lines = [
      colorText(palette, 'muted', 'Harness settings are private and saved on this device.'),
      ...(this.message ? [colorText(palette, 'warning', this.message)] : []),
      ...this.ensureList().render(Math.max(48, width)),
    ];
    return lines
      .slice(0, Math.max(1, this.options.bodyRows?.() ?? this.options.rows() - 5))
      .map((line) => truncateToWidth(line, width, ''));
  }

  private async change(id: string, value: string): Promise<void> {
    if (this.pending || this.disposed) return;
    this.pending = true;
    this.message = '';
    this.options.render();
    try {
      const controls = this.harness.settings;
      if (id === 'thinking') {
        const level = controls.snapshot().availableThinkingLevels.find((level) => level === value);
        if (level === undefined) throw new Error('Unsupported thinking level');
        await controls.setThinkingLevel(level);
      } else if (id === 'steering' || id === 'followup') {
        if (value !== 'all' && value !== 'one-at-a-time') throw new Error('Unsupported queue mode');
        if (id === 'steering') await controls.setSteeringMode(value);
        else await controls.setFollowUpMode(value);
      } else if (id === 'http') await controls.setHttpIdleTimeoutMs(Number(value));
      if (!this.disposed) this.options.notice('Harness preference saved. No model request was sent.');
    } catch {
      if (!this.disposed)
        this.message = 'Preference could not be saved. Check private settings; the current session may have changed.';
    } finally {
      this.pending = false;
      if (!this.disposed) {
        for (const item of this.items(this.harness.settings.snapshot()))
          this.list?.updateValue(item.id, item.currentValue);
        this.options.render();
      }
    }
  }

  handleInput(data: string): void {
    if (this.disposed || this.pending) return;
    this.ensureList().handleInput(data);
    this.options.render();
  }

  dispose(): void {
    this.disposed = true;
  }
}
