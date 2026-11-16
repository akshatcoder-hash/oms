/** Shape of the generated Solana program reference (program-reference.json). Written only by scripts/gen-program-reference.ts. */
/** count: no dispatch tag, the data starts with a count (see ReferenceProgram.count). none: no tag and no count. */
export type DiscriminatorStyle = 'u8' | 'u32' | 'anchor8' | 'count' | 'none';

export interface ReferenceAccount {
  name: string;
  /** Absent for factsOnly entries, which carry names and order only. "either" means signer or not (e.g. a token authority or multisig). */
  signer?: boolean | 'either';
  writable?: boolean;
  optional?: boolean;
}
export interface ReferenceArg {
  name: string;
  type: string;
}
export interface ReferenceInstruction {
  name: string;
  /** The program's own spelling when it differs from `name` (System's `TransferSol` is the Transfer instruction). */
  alias?: string;
  /** Lowercase hex of the instruction-data prefix the program dispatches on; empty when the program has no dispatch prefix. */
  discriminator: string;
  accounts: ReferenceAccount[];
  /** Absent for factsOnly entries. */
  args?: ReferenceArg[];
  note?: string;
}
export interface ReferenceSource {
  url: string;
  version: string;
  licence: string;
}
export interface ReferenceProgram {
  name: string;
  id: string;
  /** Solana native and SPL programs, or applications chosen by the ranking. */
  category: 'native' | 'application';
  purpose: string;
  /** SDK-verified deployment prerequisites and user flows, shown only in lookup results. */
  deploymentNote?: string;
  /** Extra text for the system-prompt index, for a program whose instruction list is too long to print. */
  indexHint?: string;
  /** Its whole lifecycle runs on accounts a wallet creates itself, with no existing protocol state to find first. */
  standalone?: true;
  style: DiscriminatorStyle;
  source: ReferenceSource;
  /** The interface source's licence is not on the allowlist or is unclear: only program id, names, discriminators and account order are kept. */
  factsOnly?: true;
  /** npm packages that are the program's official TypeScript client, each verified against its published manifest. Absent when there is none. */
  clients?: string[];
  /** Present exactly when style is "count": how the first bytes of the instruction data read, and the layout that follows. */
  count?: { lead: string; layout: string };
  /** Why this program is on the list, from the pinned usage-ranking snapshot. */
  rank?: string;
  instructions: ReferenceInstruction[];
}
export interface ProgramReferenceData {
  schema: 'oms.program-reference/1';
  generator: string;
  ranking: { source: string; asOf: string; method: string };
  programs: ReferenceProgram[];
}
