# Offline review tools

This image is separate from the toolchain. It contains cargo-audit 0.22.2 and
oms-sast; RustSec data is pinned to commit
`309392b18f6b17022f82c701f300433126901068`. The advisory database carries its own
license and attribution files. No runtime fetch is permitted. The Dockerfile verifies the archive SHA-256
`71dfac691f8435115ca2381f1b3d13b6dfd8bd1861d75c8e2c9852376a9e6976`.
The analyzer dependencies are frozen in `tools/oms-sast/Cargo.lock`.

Build from the repository root after the local toolchain image
(`scripts/build-toolchain.sh`, or `OMS_TOOLCHAIN_IMAGE`). Prepare the advisory
archive from a clean checkout of that exact commit, then build:

```sh
mkdir -p .tmp/review-tools
git clone https://github.com/RustSec/advisory-db.git .tmp/review-tools/advisory-db
git -C .tmp/review-tools/advisory-db checkout 309392b18f6b17022f82c701f300433126901068
git -C .tmp/review-tools/advisory-db archive --format=tar --output=../advisory-db.tar 309392b18f6b17022f82c701f300433126901068
scripts/build-review-tools.sh
```

The script records the resulting host-local image ID in
`.tmp/review-tools/image.json`; `OMS_REVIEW_TOOLS_IMAGE` overrides it. Image IDs
are machine-local, so the committed runtime manifest pins none; no registry push
is implied. arm64 remains unsupported until separately built and tested. The
image tests skip without an image; run them with `OMS_REQUIRE_REVIEW_TOOLS=1`
to make a missing image fail instead of skip. With an image configured,
`OMS_REQUIRE_DOCKER=1` also fails when Docker lacks it. The analyzer currently implements `missing-signer/anchor-field`,
`revival-reinit/init-if-needed`, `duplicate-mutable/anchor-dup`,
`pda-bump/explicit-derivation`, `unchecked-sysvar-id/instruction-reader`, and
`arithmetic/field-operation`, `pda-bump/explicit-constraint`, and
`arithmetic/integer-cast`, `token2022/unchecked-transfer`,
`token2022/legacy-rent-size`, `token2022/legacy-account-space`, and
`missing-constraint/account-authority`, `type-cosplay/literal-discriminator-prefix`, `signer-seeds/field-derived-cpi`, `missing-owner/unchecked-parameter-read`, and `signer-seeds/anchor-cpi-context`, `arbitrary-cpi/unchecked-parameter-context`, `missing-signer/unchecked-parameter`, `unchecked-sysvar-id/account-reader`, `unchecked-sysvar-id/remaining-accounts`, `revival-reinit/manual-lamport-zero`.
The manual-close rule flags literal zero assignments through double-dereferenced
`borrow_mut_lamports()` or `try_borrow_mut_lamports()?` calls. Reassignment,
receiver types and control flow are not resolved, so correctly closed accounts
can be flagged. Framework `close` helpers, aliases of mutable borrows, computed
zero values and other lamport APIs are not covered. This is a closure-review
signal, not proof that an account can be revived.
The remaining-accounts rule flags explicit `.remaining_accounts` field accesses,
including length queries and arguments to validation routines. It does not
resolve receiver types, aliases, dataflow or manual guards, so already validated
accounts and unrelated types with that field name may be flagged. Methods named
`remaining_accounts`, bare identifiers and macro tokens are excluded. This is a validation review
signal, not proof that supplied accounts are unvalidated.
The sysvar account-reader rule flags one-argument calls explicitly naming
`Sysvar::from_account_info`, including qualified trait calls. It does not resolve
implementations, aliases or caller guards. The implementation may already check
identity; this signal is not proof of a spoofable sysvar. Concrete type calls
(such as `Clock::from_account_info`) and methods are not covered. `Clock::get`
and `Rent::get` do not consume a supplied account and are excluded.
The signer-parameter rule checks named `AccountInfo`/`UncheckedAccount` function
parameters whose underscore-separated name contains authority, admin, owner or
payer. It recognizes initial consecutive `if !parameter.is_signer { return
Err(...); }` guards (also zero-argument `is_signer()`), ignoring item declarations.
Guards or rejection returns with attributes retain the signal because cfg selection
is not resolved. Nested functions are checked independently. Other checks, aliases, account arrays,
cfg selection, shadowing and reassignment are not resolved. Typed `Signer`
parameters and other parameter names are excluded. Names do not establish a
signer requirement: permissionless and unused parameters can be flagged. A
recognized entry guard does not prove authorization throughout the handler.
The unchecked CPI program rule checks named `AccountInfo`/`UncheckedAccount`
function parameters used as the first argument of `CpiContext::new` or
`CpiContext::new_with_signer`. References, parentheses, and zero-argument
`clone`/`to_account_info` wrappers are recognized. Typed `Program`/`Interface`
parameters are excluded. Nested items do not inherit enclosing parameter names;
nested functions are independently scanned. Aliases, account-struct fields,
shadowing, manual validation and type resolution remain
unresolved; a validated parameter may still be flagged. This is a suspected
program-validation signal, not proof of arbitrary code invocation.
The owner rule checks direct `borrow_data`/`try_borrow_data` and
`borrow_mut_data`/`try_borrow_mut_data` calls on named
function parameters declared as `AccountInfo` or `UncheckedAccount` (including
references). It recognizes only an immediately preceding `if account.owner !=
expected { return Err(...); }` guard, with a simple expected-owner identifier
(optionally immutably borrowed). The `.owner()` accessor and
`if !account.is_owned_by(expected) { return Err(...); }` are also recognized;
reversed comparison operands work. The check must reject with one immediate
`return Err(...)` and have no else branch. Generic method arguments, compound
conditions, computed expected owners and non-rejecting checks do not suppress
the signal. Guards or rejection returns with attributes also retain the signal.
Suppression applies only when the next
statement directly borrows data (optionally with parentheses or `?`), either as
an expression or a local initializer. Closures, compound expressions and calls
wrapping the borrow retain the signal. Item declarations do not interrupt a
guard. Other guards, aliases, shadowing, imported types, account arrays,
and general control flow are unresolved. The expected owner's trustworthiness
is not established. A suppressed signal is not proof of correct ownership;
unrecognized legitimate guards may produce suspected findings.
The Anchor CPI context rule flags field accesses in the third argument of
`CpiContext::new_with_signer`, including qualified paths and generic arguments.
It also checks the seed argument in a direct
`CpiContext::new(program, accounts).with_signer(seeds)` expression, including
parenthesized constructors. It does not resolve the named type or trace opaque
seed variables, context variables or intervening builder calls. Literal seeds and opaque seed
identifiers are not flagged; constant field expressions may still be flagged.
The signer-seeds rule flags field accesses inside the third argument of named
`invoke_signed` and `invoke_signed_unchecked` calls. It does not resolve aliases,
trace local variables, infer caller control or prove missing validation. Validated
fields may be safe; opaque seed variables remain unreviewed. Nested item
declarations and macro tokens are not treated as seed expressions.
The discriminator rule compares explicit literal byte arrays on account structs
in the same lexical module, reporting each overlapping struct once. Equal
discriminators and empty prefixes also overlap. Constants, computed values,
repeat expressions, cross-module types, default discriminators, macro expansion
and cfg selection are not resolved. An overlap is a suspected type-separation
signal, not proof that either account can be substituted successfully.
The authority rule matches `Account<T>` against a unique state struct in the
same lexical module. Authority/admin/owner-like `Pubkey` fields need a
`has_one` link to a signer or a direct equality to a signer key in an account
constraint (including conjunctions). Unrelated constraints and disjunctions
do not suppress the signal. Imported state types, aliases, cfg resolution and
manual handler checks are not resolved; permissionless operations can be safe
without such a link. This signal does not prove missing authorization.
Token signals cover named `token`, `token_2022`, `token_interface` transfer paths
and `spl_token{,_2022}::instruction::transfer`, plus literal 165-byte rent or
Anchor `space` arguments. Checked transfers and dynamic sizes are not flagged
by these subrules; that does not establish extension safety. Legacy-only token
accounts may legitimately use these APIs and sizes. Imports, receiver types,
and Token-2022 extension policies are not resolved.
Explicit `bump = expression` constraints are flagged
for provenance review; stored validated bumps may be safe. Integer `as` casts
are potential truncation or signedness signals, including safe widening casts:
the scanner does not infer source types. Checked conversions are not flagged.
The expression rules identify explicit
`Pubkey::create_program_address` calls, `load_instruction_at` calls, and field
addition/subtraction/multiplication (including compound assignment). They are
suspected review signals: names and types are not resolved, aliases and macro
expansions are not analyzed, and manual guards are not proven. They do not
establish a vulnerability or complete coverage of any class. Its JSON
`implementedRules` field states that limited coverage; every other rule remains
unreviewed. `--file <relative.rs>` parses syntax without building user code.
Syntax failures, symlinks and traversal fail closed. SR2 is not complete; a
version check alone is not static-analysis evidence.

With `--file <relative.rs> --lockfile <relative Cargo.lock>`, the scanner also
checks `anchor-cve-2026-45137/inline-instruction`. It requires an anchor-lang
version in `>=1.0.0, <1.0.2`, a syntactically typed `Program<System>` parameter
(or a field of a same-module `Context` account struct), and an inline
`Instruction` passed to `invoke`/`invoke_signed` whose `program_id` calls that
account's `key()`. A fixed `System::id()` and a CPI context constructor alone
do not satisfy this rule. Lockfile inputs have the same confinement, symlink
and size checks as source inputs; malformed metadata fails the scan.

This is a suspected signal, not proof of dependency reachability or a reproduced
vulnerability. Multiple anchor-lang versions, workspace dependency selection,
import/type resolution, cfg selection, shadowing/reassignment, manual checks and cross-module
account structs remain unresolved. Instruction
variables, aliases and helper functions are not traced. Without `--lockfile` the CVE rule is not run or listed
as implemented coverage. TOML and semantic-version parsing use pinned Rust
crates already available in the toolchain build cache; no npm dependency is added.

`--manifest <relative Cargo.toml>` separately checks
`arithmetic/release-overflow-checks`. It reports a manifest-level suspected signal
at line 1 when `[profile.release] overflow-checks` is absent or false; malformed
profile table/boolean values fail the scan. Explicit `true` suppresses this
signal, including TOML dotted-key and inline-table forms. Build overrides and
per-package settings do not establish global protection. Supply the workspace
root manifest: member profiles, Cargo configuration, environment overrides,
custom profiles and actual arithmetic safety are not resolved. This command
parses only the supplied TOML and never runs Cargo or build scripts. A finding
is not proof that overflow occurs; an explicit true setting is not proof that
all arithmetic is safe.

`duplicate-mutable/account-loader` checks pairs of explicit `#[account(mut)]`
`AccountLoader` fields with identical nongeneric state-type paths in one struct.
It reports each implicated field once. A direct `a.key() != b.key()` account
constraint (either order, optionally within `&&`) suppresses that pair; `||`,
unrelated comparisons and equality do not. Normal `Account<T>` fields are not
covered by this rule. Aliases, generic state types, cfg selection, actual type
resolution, implicit mutability and manual handler checks remain unresolved.
Permissionless or alias-safe handlers can be flagged. A matched constraint is
not proof of safety; this is a suspected aliasing signal, not a confirmed bug
or complete duplicate-account coverage.

`token2022/interface-mint` flags fields spelled `InterfaceAccount<Mint>`
(including qualified paths and a lifetime argument) for extension-policy review.
It does not resolve imports, aliases, actual framework types, handler checks or
extension allowlists. Arbitrary account constraints do not suppress it: a
constraint can validate decimals or a single extension without restricting all
extensions. Safe mints with a policy enforced elsewhere can be flagged. Legacy
`Account<Mint>` and `InterfaceAccount<TokenAccount>` are outside this subrule;
their absence is not evidence of safety. Findings remain suspected syntax
signals, not proof of a missing allowlist or full SR2 acceptance.

`token2022/amount-only-close` locates explicit `token`, `token_2022` or
`token_interface::close_account` calls inside the then branch of a literal
`.amount == 0` condition (either operand order). Nested item, closure and async
bodies are excluded from the enclosing branch search. Compound conditions,
early-return guards, imported close functions and aliases are not covered.
Account identity, types, extension state and other guards are unresolved: a
legacy-only or properly validated close can be flagged. A missing signal does
not establish a safe close. This remains a suspected review site, not a finding
that extensions are actually unchecked or full SR2 acceptance.

Every hit carries the specific matcher ID from `implementedRules` in `ruleId`
(for example `arithmetic/integer-cast`); `class` remains the broad vulnerability
class. This identifies which syntax check fired without implying that every
check for that class ran or that its absence proves safety.

The host-side `parseSastResult` in `@oms/review` validates this output against
the scanned snapshot file. It rejects failed, timed-out, truncated or malformed
results. Invalid individual findings and handler locations are dropped and
counted, valid findings are retained, and the scan is marked failed. Rule IDs
must belong to the output's declared inventory and match the finding's class.
An empty result never creates a `clear` coverage verdict. This parser does not
launch containers or establish complete SR2 coverage; engine orchestration is
still pending.

`parseAuditResult` consumes pinned cargo-audit JSON against the scanned lockfile
in the snapshot. A consistent nonempty vulnerability report with exit code 1 is
a successful scan; crashes, timeouts, truncation, malformed data and inconsistent
counts fail. Invalid entries are dropped and counted while valid hits survive.
Ignore, severity and target filters are refused. Informational warnings currently
mark the scan failed with an explicit unsupported reason, rather than disappearing
into an apparently clean result. Vulnerability advisories receive the fixed
`dependency-advisory` rule priority `high`, not a calculated CVSS severity or an
exploitability claim. Their location is lockfile line 1, not dependency source.
Prose is bounded and redacted. No confirmed label or clear verdict is produced.
The execution port still must enforce the pinned image/database and offline flags;
this parser does not attest invocation provenance or launch containers.

`type-cosplay/unchecked-deserialization` also checks inherent/trait impl methods
and trait default-method bodies, with the same immediate discriminator-guard
rules as free functions. Nested functions and methods have independent guards;
closures and async blocks cannot inherit a preceding guard. Handler labels are
source method names, not resolved entrypoints or fully qualified symbols. Trait
declarations without bodies and macro tokens are not scanned as executable code.
This extends syntax coverage only: aliases, qualified type resolution, constant trust
and general control flow remain unresolved.

Qualified calls such as `<State as BorshDeserialize>::try_from_slice(data)`
also produce this signal. Qualified types are not resolved, so a preceding
discriminator comparison does not suppress those calls. This conservative
behavior can flag correctly guarded code; it does not establish a vulnerability.

The signer, owner-read and CPI-program parameter checks also run on inherent
methods, trait impl methods and trait default bodies. Only explicit typed,
named parameters are checked; receiver fields and aliases are not resolved.
Nested methods/functions have independent parameter and guard state. Expression
findings use the containing method name instead of an enclosing free function;
these names are not fully qualified or resolved entrypoints. Trait declarations
without bodies do not receive parameter checks. The public free-function
inventory is unchanged and is not a complete instruction-handler inventory.

Authority-name heuristics strip Rust's `r#` raw-identifier prefix before checking
underscore-separated authority/admin/owner/payer words. Raw spelling does not
remove a signer or authority-link signal. This normalization does not resolve
aliases or infer whether the account actually requires authorization.

Unchecked parameter checks unwrap references and transparent type parentheses.
Tuple types and generic wrappers such as `Option<AccountInfo>` remain outside
these checks; this does not add type or alias resolution.

The CVE conjunction also checks inherent methods, trait impl methods, trait
default bodies and nested functions with their own typed parameters. Transparent
parentheses around parameter types are unwrapped. Context account structs are
looked up only in the current lexical module; imports, block-local structs,
receiver fields, aliases, shadowing and type resolution remain unsupported.
Nested bodies cannot inherit the surrounding function's parameter bindings.
Method labels are source names, not resolved instruction entrypoints. All
three conjunction requirements remain necessary, and findings remain suspected.
