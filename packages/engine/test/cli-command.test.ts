import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

test('folder, Docker and ownership hints use the launch command without changing stored paths', () => {
  const engine = new URL('../src/index.ts', import.meta.url).href;
  for (const [npm_command, command] of [
    ['exec', 'npx @barestate/oms'],
    ['start', 'oms'],
  ]) {
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { scratchNotice, ChatBusyError, DOCKER_CHAT_REFUSAL } from ${JSON.stringify(engine)};
      console.log(JSON.stringify([
        scratchNotice('/a project'), new ChatBusyError(123).message, DOCKER_CHAT_REFUSAL,
      ]));
    `,
      ],
      { encoding: 'utf8', env: { ...process.env, npm_command } },
    );
    assert.deepEqual(JSON.parse(output), [
      `No project here, so this chat uses a scratch folder (/a project). cd into a project folder and run ${command} to work on it.`,
      `OMS is already open in this folder (process 123). Close that window, or run ${command} in another folder.`,
      `Run \`${command} help advanced\` for workspace and task setup instructions. Docker mode requires a pinned task and does not support folder chat.`,
    ]);
  }
});
