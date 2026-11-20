export function omsCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.npm_command === 'exec' ? 'npx @barestate/oms' : 'oms';
}
