import type { Idl } from "./solana-diagnosis.ts";

/**
 * Offline error tables for the programs and frameworks a Solana task meets most: the Anchor framework (codes below 6000), System,
 * SPL Token, Token-2022 (its Token-compatible codes) and the Associated Token program. The knowledge service's decode_error
 * covers the rest. Programs report these as `custom program error: 0x..` / `{"Custom": n}`.
 */
export interface ErrorMatch { program: string; name: string; message: string; source: "built-in table" | "local IDL" }
type Table = Array<[code: number, name: string, message: string]>;

const ANCHOR: Table = [
  [100, "InstructionMissing", "8 byte instruction identifier not provided"],
  [101, "InstructionFallbackNotFound", "Fallback functions are not supported"],
  [102, "InstructionDidNotDeserialize", "The program could not deserialize the given instruction"],
  [103, "InstructionDidNotSerialize", "The program could not serialize the given instruction"],
  [1000, "IdlInstructionStub", "The program was compiled without idl instructions"],
  [1001, "IdlInstructionInvalidProgram", "The transaction was given an invalid program for the IDL instruction"],
  [1002, "IdlAccountNotEmpty", "IDL account must be empty in order to resize, try closing first"],
  [1500, "EventInstructionStub", "The program was compiled without `event-cpi` feature"],
  [2000, "ConstraintMut", "A mut constraint was violated"],
  [2001, "ConstraintHasOne", "A has one constraint was violated"],
  [2002, "ConstraintSigner", "A signer constraint was violated"],
  [2003, "ConstraintRaw", "A raw constraint was violated"],
  [2004, "ConstraintOwner", "An owner constraint was violated"],
  [2005, "ConstraintRentExempt", "A rent exemption constraint was violated"],
  [2006, "ConstraintSeeds", "A seeds constraint was violated"],
  [2007, "ConstraintExecutable", "An executable constraint was violated"],
  [2008, "ConstraintState", "Deprecated Error, feel free to replace with something else"],
  [2009, "ConstraintAssociated", "An associated constraint was violated"],
  [2010, "ConstraintAssociatedInit", "An associated init constraint was violated"],
  [2011, "ConstraintClose", "A close constraint was violated"],
  [2012, "ConstraintAddress", "An address constraint was violated"],
  [2013, "ConstraintZero", "Expected zero account discriminant"],
  [2014, "ConstraintTokenMint", "A token mint constraint was violated"],
  [2015, "ConstraintTokenOwner", "A token owner constraint was violated"],
  [2016, "ConstraintMintMintAuthority", "A mint mint authority constraint was violated"],
  [2017, "ConstraintMintFreezeAuthority", "A mint freeze authority constraint was violated"],
  [2018, "ConstraintMintDecimals", "A mint decimals constraint was violated"],
  [2019, "ConstraintSpace", "A space constraint was violated"],
  [2020, "ConstraintAccountIsNone", "A required account for the constraint is None"],
  [2021, "ConstraintTokenTokenProgram", "A token account token program constraint was violated"],
  [2022, "ConstraintMintTokenProgram", "A mint token program constraint was violated"],
  [2023, "ConstraintAssociatedTokenTokenProgram", "An associated token account token program constraint was violated"],
  [2500, "RequireViolated", "A require expression was violated"],
  [2501, "RequireEqViolated", "A require_eq expression was violated"],
  [2502, "RequireKeysEqViolated", "A require_keys_eq expression was violated"],
  [2503, "RequireNeqViolated", "A require_neq expression was violated"],
  [2504, "RequireKeysNeqViolated", "A require_keys_neq expression was violated"],
  [2505, "RequireGtViolated", "A require_gt expression was violated"],
  [2506, "RequireGteViolated", "A require_gte expression was violated"],
  [3000, "AccountDiscriminatorAlreadySet", "The account discriminator was already set on this account"],
  [3001, "AccountDiscriminatorNotFound", "No discriminator was found on the account"],
  [3002, "AccountDiscriminatorMismatch", "The account discriminator did not match what was expected"],
  [3003, "AccountDidNotDeserialize", "Failed to deserialize the account"],
  [3004, "AccountDidNotSerialize", "Failed to serialize the account"],
  [3005, "AccountNotEnoughKeys", "Not enough account keys given to the instruction"],
  [3006, "AccountNotMutable", "The given account is not mutable"],
  [3007, "AccountOwnedByWrongProgram", "The given account is owned by a different program than expected"],
  [3008, "InvalidProgramId", "Program ID was not as expected"],
  [3009, "InvalidProgramExecutable", "Program account is not executable"],
  [3010, "AccountNotSigner", "The given account did not sign"],
  [3011, "AccountNotSystemOwned", "The given account is not owned by the system program"],
  [3012, "AccountNotInitialized", "The program expected this account to be already initialized"],
  [3013, "AccountNotProgramData", "The given account is not a program data account"],
  [3014, "AccountNotAssociatedTokenAccount", "The given account is not the associated token account"],
  [3015, "AccountSysvarMismatch", "The given public key does not match the required sysvar"],
  [3016, "AccountReallocExceedsLimit", "The account reallocation exceeds the MAX_PERMITTED_DATA_INCREASE limit"],
  [3017, "AccountDuplicateReallocs", "The account was duplicated for more than one reallocation"],
  [4000, "StateInvalidAddress", "The given state account does not have the correct address"],
  [4100, "DeclaredProgramIdMismatch", "The declared program id does not match the actual program id"],
  [4101, "TryingToInitPayerAsProgramAccount", "You cannot/should not initialize the payer account as a program account"],
  [4102, "InvalidNumericConversion", "The program could not perform the numeric conversion, out of range integral type conversion attempted"],
  [5000, "Deprecated", "The API being used is deprecated and should no longer be used"],
];

const SYSTEM: Table = [
  [0, "AccountAlreadyInUse", "an account with the same address already exists"],
  [1, "ResultWithNegativeLamports", "account does not have enough SOL to perform the operation"],
  [2, "InvalidProgramId", "cannot assign account to this program id"],
  [3, "InvalidAccountDataLength", "cannot allocate account data of this length"],
  [4, "MaxSeedLengthExceeded", "length of requested seed is too long"],
  [5, "AddressWithSeedMismatch", "provided address does not match addressed derived from seed"],
  [6, "NonceNoRecentBlockhashes", "advancing stored nonce requires a populated RecentBlockhashes sysvar"],
  [7, "NonceBlockhashNotExpired", "stored nonce is still in recent_blockhashes"],
  [8, "NonceUnexpectedBlockhashValue", "specified nonce does not match stored nonce"],
];

const TOKEN: Table = [
  [0, "NotRentExempt", "Lamport balance below rent-exempt threshold"],
  [1, "InsufficientFunds", "Insufficient funds"],
  [2, "InvalidMint", "Invalid Mint"],
  [3, "MintMismatch", "Account not associated with this Mint"],
  [4, "OwnerMismatch", "Owner does not match"],
  [5, "FixedSupply", "Fixed supply"],
  [6, "AlreadyInUse", "Already in use"],
  [7, "InvalidNumberOfProvidedSigners", "Invalid number of provided signers"],
  [8, "InvalidNumberOfRequiredSigners", "Invalid number of required signers"],
  [9, "UninitializedState", "State is uninitialized"],
  [10, "NativeNotSupported", "Instruction does not support native tokens"],
  [11, "NonNativeHasBalance", "Non-native account can only be closed if its balance is zero"],
  [12, "InvalidInstruction", "Invalid instruction"],
  [13, "InvalidState", "State is invalid for requested operation"],
  [14, "Overflow", "Operation overflowed"],
  [15, "AuthorityTypeNotSupported", "Account does not support specified authority type"],
  [16, "MintCannotFreeze", "This token mint cannot freeze accounts"],
  [17, "AccountFrozen", "Account is frozen"],
  [18, "MintDecimalsMismatch", "The provided decimals value different from the Mint decimals"],
  [19, "NonNativeNotSupported", "Instruction does not support non-native tokens"],
];

const ASSOCIATED_TOKEN: Table = [[0, "InvalidOwner", "Associated token account owner does not match address derived from seeds"]];

interface Source { name: string; id?: string; aliases: string[]; table: Table; note?: string }
const SOURCES: Source[] = [
  { name: "Anchor framework", aliases: ["anchor", "framework"], table: ANCHOR },
  { name: "System", id: "11111111111111111111111111111111", aliases: ["system"], table: SYSTEM },
  { name: "SPL Token", id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", aliases: ["token", "spl-token", "spl token"], table: TOKEN },
  { name: "Token-2022", id: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", aliases: ["token-2022", "token2022", "spl-token-2022"], table: TOKEN,
    note: "Token-2022 codes above 19 are extension errors; they are not in the offline table" },
  { name: "Associated Token", id: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", aliases: ["ata", "associated-token", "associated token", "associated"], table: ASSOCIATED_TOKEN },
];

export interface ErrorDecoding {
  matches: ErrorMatch[];
  /** The program argument named a program with no offline table (and no local IDL), so only the knowledge service can answer. */
  unknownProgram?: string;
  notes: string[];
}

const idlName = (idl: Idl) => idl.metadata?.name ?? idl.name ?? "program";
const idlAddress = (idl: Idl) => idl.address ?? idl.metadata?.address;

/** Parse `3012`, `0xbc4` or `custom program error: 0xbc4`; undefined when it is not one non-negative integer. */
export function parseErrorCode(text: string): number | undefined {
  const match = /^(?:custom program error:\s*)?(0x[0-9a-f]+|\d+)$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : undefined;
}

/** Decode a custom error code with the offline tables and the task's own IDLs. `program` is a name, alias or program id. */
export function decodeProgramError(code: number, program: string | undefined, idls: readonly Idl[] = []): ErrorDecoding {
  const wanted = program?.trim();
  const lower = wanted?.toLowerCase();
  const builtIn = wanted ? SOURCES.filter(source => source.id === wanted || source.aliases.includes(lower!) || source.name.toLowerCase() === lower) : SOURCES;
  const owned = wanted ? idls.filter(idl => idlAddress(idl) === wanted || idlName(idl).toLowerCase() === lower) : [...idls];
  const matches: ErrorMatch[] = [];
  const notes: string[] = [];
  for (const source of builtIn) {
    const row = source.table.find(entry => entry[0] === code);
    if (row) matches.push({ program: source.name, name: row[1], message: row[2], source: "built-in table" });
    else if (wanted && source.note && code > 19) notes.push(source.note);
  }
  for (const idl of owned) {
    const row = idl.errors?.find(entry => entry.code === code);
    if (row) matches.push({ program: idlName(idl), name: row.name, message: row.msg ?? "", source: "local IDL" });
  }
  // An Anchor program also raises the framework's own codes.
  if (wanted && owned.length && !builtIn.includes(SOURCES[0]!)) {
    const row = ANCHOR.find(entry => entry[0] === code);
    if (row) matches.push({ program: "Anchor framework", name: row[1], message: row[2], source: "built-in table" });
  }
  if (code >= 6000 && !matches.length) notes.push("Codes from 6000 are defined by the program itself: its IDL (target/idl/*.json) or source lists them");
  return { matches, notes, ...(wanted && !builtIn.length && !owned.length ? { unknownProgram: wanted } : {}) };
}

/** A program id or name for one of the built-in tables, for naming the failing program of a transaction. */
export function builtInProgramName(id: string): string | undefined {
  return SOURCES.find(source => source.id === id)?.name;
}
