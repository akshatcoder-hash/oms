// Turns one interface source (Codama IDL, Anchor/Shank IDL, Rust instruction enum) into the common instruction shape.
// Every adapter throws on anything it does not recognise: a missing discriminator or account list is never guessed.
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import type { DiscriminatorStyle, ReferenceAccount, ReferenceArg, ReferenceInstruction } from '../../packages/engine/src/runtime/program-reference-data.ts';

export interface Adapted { style: DiscriminatorStyle; address?: string; instructions: ReferenceInstruction[]; count?: { lead: string; layout: string } }
type Json = any;

const hex = (bytes: number[]): string => bytes.map(b => b.toString(16).padStart(2, '0')).join('');
const littleEndian = (value: number | bigint, width: number): number[] =>
  Array.from({ length: width }, (_, i) => Number((BigInt(value) >> BigInt(8 * i)) & 0xffn));
const FORMAT_WIDTH: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, i8: 1, i16: 2, i32: 4, i64: 8 };

const styleOf = (width: number): DiscriminatorStyle => (width === 8 ? 'anchor8' : width === 4 ? 'u32' : width === 0 ? 'none' : 'u8');

/** Anchor's own rule for an instruction without an explicit discriminator: sha256("global:" + snake_case(name))[0..8]. */
export function anchorDiscriminator(name: string): string {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return createHash('sha256').update(`global:${snake}`).digest().subarray(0, 8).toString('hex');
}

// ---------------------------------------------------------------- Codama

function codamaType(t: Json): string {
  switch (t.kind) {
    case 'numberTypeNode': return t.format;
    case 'booleanTypeNode': return 'bool';
    case 'publicKeyTypeNode': return 'pubkey';
    case 'stringTypeNode': return 'string';
    case 'bytesTypeNode': return 'bytes';
    case 'optionTypeNode': case 'zeroableOptionTypeNode': return `option<${codamaType(t.item)}>`;
    case 'remainderOptionTypeNode': return `option<${codamaType(t.item)}>`;
    case 'sizePrefixTypeNode': return codamaType(t.type);
    case 'fixedSizeTypeNode': return `${codamaType(t.type)}[${t.size}]`;
    case 'hiddenPrefixTypeNode': case 'hiddenSuffixTypeNode': case 'preOffsetTypeNode': case 'postOffsetTypeNode': case 'sentinelTypeNode':
      return codamaType(t.type);
    case 'arrayTypeNode': return t.count.kind === 'fixedCountNode' ? `${codamaType(t.item)}[${t.count.value}]` : `vec<${codamaType(t.item)}>`;
    case 'setTypeNode': return `vec<${codamaType(t.item)}>`;
    case 'mapTypeNode': return `map<${codamaType(t.key)},${codamaType(t.value)}>`;
    case 'tupleTypeNode': return `(${t.items.map(codamaType).join(',')})`;
    case 'structTypeNode': return `{${t.fields.map((f: Json) => `${f.name}:${codamaType(f.type)}`).join(',')}}`;
    case 'enumTypeNode': return `enum{${t.variants.map((v: Json) => v.name).join('|')}}`;
    case 'definedTypeLinkNode': return t.name;
    case 'amountTypeNode': case 'dateTimeTypeNode': case 'solAmountTypeNode': return codamaType(t.number);
    default: throw new Error(`unhandled Codama type ${t.kind}`);
  }
}

/** The constant bytes an argument contributes at the front of the instruction data, or undefined when it is not constant. */
function codamaConstant(arg: Json): number[] | undefined {
  const value = arg.defaultValue;
  if (!value) return undefined;
  if (value.kind === 'numberValueNode') {
    const width = FORMAT_WIDTH[arg.type.format];
    if (!width) throw new Error(`discriminator ${arg.name} has unexpected format ${arg.type.format}`);
    return littleEndian(value.number, width);
  }
  if (value.kind === 'bytesValueNode' && value.encoding === 'base16') return [...Buffer.from(value.data, 'hex')];
  throw new Error(`discriminator ${arg.name} has unhandled default ${value.kind}`);
}

export function adaptCodama(idl: Json): Adapted {
  const widths = new Set<number>();
  const instructions = idl.program.instructions.map((ix: Json): ReferenceInstruction => {
    const nodes: Json[] = ix.discriminators ?? [];
    const prefix: number[] = [];
    const used = new Set<string>();
    for (const node of nodes) {
      if (node.kind !== 'fieldDiscriminatorNode') throw new Error(`${ix.name}: unhandled discriminator ${node.kind}`);
      const arg = ix.arguments.find((a: Json) => a.name === node.name);
      const bytes = arg && codamaConstant(arg);
      if (!bytes) throw new Error(`${ix.name}: discriminator field ${node.name} has no constant`);
      for (const [i, b] of bytes.entries()) prefix[node.offset + i] = b;
      used.add(node.name);
    }
    if (prefix.some(b => b === undefined)) throw new Error(`${ix.name}: no contiguous discriminator`);
    widths.add(prefix.length);
    const args: ReferenceArg[] = (ix.arguments ?? []).filter((a: Json) => !used.has(a.name))
      .map((a: Json) => ({ name: a.name, type: codamaType(a.type) }));
    const accounts: ReferenceAccount[] = (ix.accounts ?? []).map((a: Json) => ({ name: a.name, signer: a.isSigner, writable: a.isWritable, ...(a.isOptional ? { optional: true } : {}) }));
    const alias = ix.idlName && ix.idlName.toLowerCase() !== ix.name.toLowerCase() ? ix.idlName : undefined;
    return { name: ix.name, ...(alias ? { alias } : {}), discriminator: hex(prefix), accounts, args };
  });
  // Native and SPL programs dispatch on a leading u8 or u32; Token-2022 extensions add a second byte to that same 1-byte tag.
  return { style: styleOf(Math.min(...widths)), address: idl.program.publicKey, instructions };
}

/**
 * A Codama IDL whose single instruction has no discriminator: its data starts with a count-prefixed list (Config's `store`
 * starts with the short_vec of keys). The count format, entry type and trailing field are read from the IDL, never assumed.
 */
export function adaptCountPrefixed(idl: Json): Adapted {
  const adapted = adaptCodama(idl);
  const [instruction, ...rest] = idl.program.instructions as Json[];
  const [list, tail] = (instruction?.arguments ?? []) as Json[];
  const type = idl.program.definedTypes?.find((t: Json) => t.name === list?.type?.name)?.type;
  if (rest.length || (instruction?.discriminators ?? []).length || !tail || type?.kind !== 'arrayTypeNode' || type.count.kind !== 'prefixedCountNode') {
    throw new Error('not a count-prefixed single-instruction program');
  }
  const format = type.count.prefix.format === 'shortU16' ? 'short_vec' : type.count.prefix.format;
  const entry = type.item.kind === 'tupleTypeNode'
    ? `(${type.item.items.map((i: Json) => (i.kind === 'booleanTypeNode' ? `bool as ${i.size.format}` : codamaType(i))).join(', ')})`
    : codamaType(type.item);
  const remaining = (instruction.remainingAccounts ?? []).some((r: Json) => r.isSigner) ? ' The signer keys are passed after the config account as remaining signer accounts.' : '';
  const layout = `${list.name}: ${format} length n, then n entries of ${entry}; then ${tail.name}: ${codamaType(tail.type)} to the end of the data. ${(list.docs ?? []).join(' ')}${remaining}`.replace(/\.$/, '');
  return { ...adapted, style: 'count', count: { lead: `data starts with a ${format} count of ${list.name}`, layout } };
}

// ---------------------------------------------------------------- Anchor / Shank

function anchorType(t: Json): string {
  if (typeof t === 'string') return t === 'publicKey' ? 'pubkey' : t;
  if (t.vec) return `vec<${anchorType(t.vec)}>`;
  if (t.option) return `option<${anchorType(t.option)}>`;
  if (t.coption) return `option<${anchorType(t.coption)}>`;
  if (t.array) return `${anchorType(t.array[0])}[${t.array[1]}]`;
  if (t.defined) return typeof t.defined === 'string' ? t.defined : t.defined.name;
  if (t.tuple) return `(${t.tuple.map(anchorType).join(',')})`;
  if (t.hashMap) return `map<${anchorType(t.hashMap[0])},${anchorType(t.hashMap[1])}>`;
  if (t.bTreeMap) return `map<${anchorType(t.bTreeMap[0])},${anchorType(t.bTreeMap[1])}>`;
  if (t.hashSet || t.bTreeSet) return `vec<${anchorType(t.hashSet ?? t.bTreeSet)}>`;
  throw new Error(`unhandled Anchor type ${JSON.stringify(t)}`);
}

function anchorAccounts(list: Json[], prefix = ''): ReferenceAccount[] {
  return list.flatMap((a: Json): ReferenceAccount[] => {
    const name = `${prefix}${a.name}`;
    if (a.accounts) return anchorAccounts(a.accounts, `${name}.`);
    return [{ name, signer: !!(a.signer ?? a.isSigner), writable: !!(a.writable ?? a.isMut),
      ...(a.optional || a.isOptional ? { optional: true } : {}) }];
  });
}

export function adaptAnchor(idl: Json): Adapted {
  const widths = new Set<number>();
  const instructions = idl.instructions.map((ix: Json): ReferenceInstruction => {
    let discriminator: string;
    if (Array.isArray(ix.discriminator)) discriminator = hex(ix.discriminator);
    else if (ix.discriminant) {
      const width = FORMAT_WIDTH[ix.discriminant.type];
      if (!width) throw new Error(`${ix.name}: unexpected discriminant type ${ix.discriminant.type}`);
      discriminator = hex(littleEndian(ix.discriminant.value, width));
    } else discriminator = anchorDiscriminator(ix.name);
    widths.add(discriminator.length / 2);
    return { name: ix.name, discriminator, accounts: anchorAccounts(ix.accounts),
      args: ix.args.map((a: Json) => ({ name: a.name, type: anchorType(a.type) })) };
  });
  if (widths.size !== 1) throw new Error(`mixed discriminator widths ${[...widths]}`);
  return { style: styleOf([...widths][0]!), address: idl.address ?? idl.metadata?.address, instructions };
}

/** An IDL exported as a JS object literal (`export const IDL = {...}`), read without running anything but the literal. */
export function parseJsIdl(source: string): Json {
  const start = source.indexOf('{', source.search(/\bIDL\s*=/));
  const end = source.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no IDL object literal');
  return runInNewContext(`(${source.slice(start, end + 1)})`, Object.create(null), { timeout: 2000 });
}

// ---------------------------------------------------------------- Rust

export interface RustVariant { name: string; index: number; docs: string[]; fields: ReferenceArg[] }

const depthDelta = (text: string): number => [...text].reduce((d, c) => d + ('({['.includes(c) ? 1 : ')}]'.includes(c) ? -1 : 0), 0);

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, angle = 0, current = '';
  for (const c of text) {
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (c === '<') angle++;
    else if (c === '>' ) angle = Math.max(0, angle - 1);
    if (c === ',' && depth === 0 && angle === 0) { parts.push(current); current = ''; } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Variants of `pub enum <name>` in declaration order, with their doc lines and field list. Borsh and bincode both number variants by position. */
export function parseRustEnum(source: string, name: string): RustVariant[] {
  const open = new RegExp(`^pub enum ${name}\\s*\\{`, 'm').exec(source);
  if (!open) throw new Error(`enum ${name} not found`);
  const variants: RustVariant[] = [];
  let docs: string[] = [], text = '', depth = 0, attr = 0, index = 0;
  for (const raw of source.slice(open.index + open[0].length).split('\n')) {
    const line = raw.trim();
    if (attr > 0) { attr += depthDelta(line); continue; }
    if (depth === 0) {
      if (line.startsWith('///')) { docs.push(line.slice(3)); continue; }
      if (line.startsWith('//') || line === '') continue;
      if (line.startsWith('}') ) break;
    } else if (line.startsWith('//')) continue;
    if (line.startsWith('#[')) { attr = depthDelta(line); continue; }
    text += ` ${line}`;
    depth += depthDelta(line);
    if (depth === 0 && text.trimEnd().endsWith(',')) {
      const body = text.trim().slice(0, -1).trim();
      const head = /^(\w+)\s*(?:=\s*(\d+))?\s*(.*)$/s.exec(body);
      if (!head) throw new Error(`unparsable variant in ${name}: ${body.slice(0, 60)}`);
      if (head[2] !== undefined) index = Number(head[2]);
      const rest = head[3]!.trim();
      const fields: ReferenceArg[] = rest.startsWith('{')
        ? splitTopLevel(rest.slice(1, -1)).map(f => { const [n, ...t] = f.split(':'); return { name: n!.trim(), type: t.join(':').replace(/\s+/g, ' ').trim() }; })
        : rest.startsWith('(') ? splitTopLevel(rest.slice(1, -1)).map((t, i) => ({ name: `arg${i}`, type: t.replace(/\s+/g, ' ') })) : [];
      variants.push({ name: head[1]!, index: index++, docs, fields });
      docs = []; text = '';
    }
  }
  if (variants.length === 0) throw new Error(`enum ${name} has no variants`);
  return variants;
}

const ACCOUNT_LINE = /^\s*(?:\*\s*)?(\d+)\.\s*[`']?\[([^\]]*)\][`']?\s*(.*)$/;

/** Accounts from a doc comment's numbered list. Alternative lists (numbering restarts) are ambiguous, so none is returned. */
export function docAccounts(docs: string[]): { accounts: ReferenceAccount[]; ambiguous: boolean } {
  const accounts: ReferenceAccount[] = [];
  let ambiguous = false;
  for (const line of docs) {
    const m = ACCOUNT_LINE.exec(line);
    if (!m) continue;
    if (Number(m[1]) !== accounts.length) { ambiguous = true; continue; }
    const flags = m[2]!.toLowerCase().split(/[\s,|]+/);
    const description = m[3]!.replace(/\s+/g, ' ').replace(/\s*\(.*$/, '').replace(/[.:]+$/, '').slice(0, 60).trim();
    accounts.push({ name: description || `account${m[1]}`, signer: flags.some(f => f === 's' || f === 'ws' || f === 'sw' || f.startsWith('sign')),
      writable: flags.some(f => f === 'w' || f === 'ws' || f === 'sw' || f.startsWith('writ')) });
  }
  return ambiguous ? { accounts: [], ambiguous: true } : { accounts, ambiguous: false };
}

const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** `width` is the instruction-tag width in bytes: 1 for borsh enums, 4 for bincode ones. */
export function adaptRustEnum(source: string, enumName: string, width: 1 | 4): Adapted {
  const instructions = parseRustEnum(source, enumName).map((v): ReferenceInstruction => {
    const { accounts, ambiguous } = docAccounts(v.docs);
    return { name: snake(v.name), alias: v.name, discriminator: hex(littleEndian(v.index, width)), accounts, args: v.fields,
      ...(ambiguous ? { note: 'accounts differ by case; see the source docs' } : {}) };
  });
  return { style: styleOf(width), instructions };
}

/** Field list of `pub struct <name>`. */
export function parseRustStruct(source: string, name: string): ReferenceArg[] {
  const open = new RegExp(`^pub struct ${name}\\s*\\{`, 'm').exec(source);
  if (!open) throw new Error(`struct ${name} not found`);
  const body = source.slice(open.index + open[0].length);
  const text = body.slice(0, body.indexOf('}')).split('\n').map(l => l.replace(/\/\/.*$/, '').trim()).filter(l => l && !l.startsWith('#[')).join(' ');
  return splitTopLevel(text).map(f => { const [n, ...t] = f.replace(/^pub\s+/, '').split(':'); return { name: n!.trim(), type: t.join(':').trim() }; });
}

/**
 * The signature-verify precompiles have no dispatch tag. Their instruction data is a count byte (plus a padding byte for
 * ed25519 and secp256r1) followed by an array of offset records; the record fields and both sizes are read from the source.
 */
export function adaptPrecompile(source: string, offsetsStruct: string): Adapted {
  const constant = (name: string): number => {
    const found = new RegExp(`^\\s*pub const ${name}: usize = (\\w+)(?: \\+ (\\w+))?;`, 'm').exec(source);
    if (!found) throw new Error(`constant ${name} not found`);
    const value = (token: string): number => (/^\d+$/.test(token) ? Number(token) : constant(token));
    return value(found[1]!) + (found[2] ? value(found[2]) : 0);
  };
  const recordSize = constant('SIGNATURE_OFFSETS_SERIALIZED_SIZE');
  const header = constant('DATA_START') - recordSize;
  const fields = parseRustStruct(source, offsetsStruct);
  const bytes = fields.reduce((sum, f) => sum + (FORMAT_WIDTH[f.type] ?? NaN), 0);
  if (bytes !== recordSize) throw new Error(`${offsetsStruct} fields total ${bytes} bytes, source says ${recordSize}`);
  if (header !== 1 && header !== 2) throw new Error(`unexpected precompile header of ${header} bytes`);
  const record = `{${fields.map(f => `${f.name}:${f.type}`).join(',')}}`;
  const args: ReferenceArg[] = [{ name: 'num_signatures', type: 'u8' }, ...(header === 2 ? [{ name: 'padding', type: 'u8' }] : []),
    { name: 'offsets', type: `${record}[num_signatures]` }];
  const layout = `u8 num_signatures, ${header === 2 ? 'u8 padding, ' : ''}then num_signatures records of ${recordSize} bytes ${record}; each *_instruction_index names the transaction instruction whose data holds the signature, key or message`;
  return { style: 'count', count: { lead: 'first byte = number of signatures', layout }, instructions: [{ name: 'verify', discriminator: '', accounts: [], args,
    note: 'no dispatch tag: the instruction data starts with the signature count; the signature, key and message bytes sit wherever the offset records point, after the records or in another instruction' }] };
}
