// Checks shared by the generator (fail before writing) and the tests (fail on the checked-in file).
import type { ProgramReferenceData } from '../../packages/engine/src/runtime/program-reference-data.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(text: string): number[] | undefined {
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) return undefined;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i]! * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of text) { if (ch !== '1') break; bytes.push(0); }
  return bytes.reverse();
}

/** Allowed discriminator widths in bytes. Token-2022 adds extension sub-tags (2 bytes) and the 8-byte SPL interface hashes to its 1-byte tags. */
const WIDTHS = { u8: [1, 2, 8], u32: [4], anchor8: [8], count: [0], none: [0] } as const;

export function validateProgramReference(data: ProgramReferenceData): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const program of data.programs) {
    const at = program.name;
    if (base58Decode(program.id)?.length !== 32) problems.push(`${at}: id ${program.id} is not base58 of 32 bytes`);
    if (ids.has(program.id)) problems.push(`${at}: duplicate program id`);
    ids.add(program.id);
    if ((program.style === 'count') !== !!program.count) problems.push(`${at}: count layout is present exactly for count-prefixed programs`);
    for (const client of program.clients ?? []) if (!/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(client)) problems.push(`${at}: client ${client} is not a scoped npm package name`);
    if (!program.purpose || !program.source.url || !program.source.version || !program.source.licence) problems.push(`${at}: missing purpose or source`);
    const names = new Set<string>();
    const discriminators = new Set<string>();
    for (const ix of program.instructions) {
      if (names.has(ix.name)) problems.push(`${at}: duplicate instruction ${ix.name}`);
      names.add(ix.name);
      if (!/^(?:[0-9a-f]{2})*$/.test(ix.discriminator)) problems.push(`${at}.${ix.name}: discriminator is not hex`);
      const width = ix.discriminator.length / 2;
      if (!(WIDTHS[program.style] as readonly number[]).includes(width)) problems.push(`${at}.${ix.name}: ${width}-byte discriminator in a ${program.style} program`);
      if (program.style !== 'none' && discriminators.has(ix.discriminator)) problems.push(`${at}.${ix.name}: discriminator ${ix.discriminator} repeats`);
      discriminators.add(ix.discriminator);
      if (program.factsOnly && (ix.args || ix.accounts.some(a => a.signer !== undefined || a.writable !== undefined))) problems.push(`${at}.${ix.name}: factsOnly entry carries more than names`);
    }
  }
  return problems;
}
