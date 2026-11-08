import type { ProjectSnapshot } from './project.ts';

/** Honor the explicit v3 requirement described by RULES.arch; never infer flags from source text. */
export function toolchainBuildCommand(project: ProjectSnapshot, kind: 'cargo' | 'anchor'): string[] {
  const command = kind === 'anchor' ? ['anchor', 'build', '--ignore-keys'] : ['cargo', 'build-sbf'];
  if (project.files.some(file => file.path.endsWith('Cargo.toml') &&
      file.data?.package?.metadata?.oms?.['required-sbpf-arch'] === 'v3')) {
    command.push('--arch', 'v3');
  }
  return command;
}
