import {
  readProject,
  checkToolchain,
  planToolchainFix,
  applyToolchainFix,
  verifyToolchainProject,
  omsCommand,
} from '@oms/engine';
export async function toolchainCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action !== 'check' && action !== 'fix')
    throw new Error(`Usage: ${omsCommand()} toolchain check|fix [--project <path>] [--apply] [--verify]`);
  let project = process.cwd(),
    apply = false,
    verify = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--project') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error('--project needs a path');
      project = value;
    } else if (rest[i] === '--apply') apply = true;
    else if (rest[i] === '--verify') verify = true;
    else throw new Error(`unknown toolchain option: ${rest[i]}`);
  }
  if (verify && (!apply || action !== 'fix')) throw new Error('--verify requires toolchain fix --apply');
  if (apply && action !== 'fix') throw new Error('--apply is only valid for toolchain fix');
  const snapshot = readProject(project);
  if (action === 'check') {
    const report = checkToolchain(snapshot);
    console.log(JSON.stringify(report, null, 2));
    return report.findings.some((f) => f.severity !== 'info') ? 1 : 0;
  }
  const plan = planToolchainFix(snapshot);
  if (apply) applyToolchainFix(snapshot, plan);
  const verification = verify ? await verifyToolchainProject(snapshot.root) : undefined;
  console.log(JSON.stringify({ ...plan, applied: apply, ...(verification ? { verification } : {}) }, null, 2));
  return verification && verification.status !== 'build and tests passed' ? 1 : 0;
}
