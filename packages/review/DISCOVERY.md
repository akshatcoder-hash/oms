# Program discovery

`discoverPrograms(snapshot, port)` reads only the filtered, immutable review
snapshot. It invokes the pinned `oms-sast --inventory` parser through the same
restricted offline Docker port as static analysis. It does not invoke Cargo,
build scripts, macro expansion, RPC, a model, or the knowledge service.

Programs require a Cargo package with a recognized direct dependency
(`anchor-lang`, `pinocchio`, `solana-program`, or `solana-account-info`), an
available library source, and exactly one top-level literal `declare_id!` in
that library. Renamed direct dependencies and target-specific dependency tables are supported.
Target conditions are not evaluated: discovery considers their union, and conflicting
Anchor/Pinocchio declarations remain unresolved. Build/dev dependencies are excluded. Invalid manifests,
unknown frameworks, unavailable sources, and ambiguous identities are recorded
as issues rather than clean reviews. No result proves that the crate builds or
that the declared address is a valid review target on any chain.

An IDL present in the snapshot is used only when its address matches the source
ID and every instruction maps to exactly one source function. Snake/camel-case
names are matched after removing underscores and folding case. Ambiguous or
invalid matches retain the syntax inventory and produce an issue. Generated
`target/idl` files remain excluded by the snapshot policy; users can supply a
source-controlled IDL outside excluded directories. Multiple matching IDLs are
not silently selected.

Without a usable IDL, free functions in the library's source directory become
review candidates, including helpers and nested functions. This is explicitly
`handlerSource: 'syntax'`, not a claim that each function is an instruction.
Nested Cargo crates, crate-level tests/examples/benches and build.rs are excluded.
Module graphs, cfg flags, macro-generated functions, associated methods,
workspace-inherited dependency aliases, and
Anchor version resolution are not implemented. Failed source inventory is
visible in `issues`; callers must keep affected coverage unreviewed.

The pass admits at most 2,000 captured paths, five minutes of parser work and
16 MiB of returned output. Each invocation keeps the static port's offline,
read-only, memory/CPU/pid, timeout, and output limits. Exception text from the
port is never copied into discovery diagnostics.
