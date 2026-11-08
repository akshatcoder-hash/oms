use oms_sast::{analyze, cve, manifest};
use std::collections::BTreeSet;

#[test]
fn every_source_matcher_reports_its_specific_rule_id() {
    let fixtures = [
        ("type-cosplay/unchecked-deserialization", "fn f() { State::try_from_slice(data); }"),
        ("missing-signer/anchor-field", "struct A { authority: UncheckedAccount<'info> }"),
        ("revival-reinit/init-if-needed", "struct A { #[account(init_if_needed)] vault: Account<Vault> }"),
        ("duplicate-mutable/anchor-dup", "struct A { #[account(dup)] vault: Account<Vault> }"),
        ("pda-bump/explicit-derivation", "fn f() { Pubkey::create_program_address(seeds, id); }"),
        ("unchecked-sysvar-id/instruction-reader", "fn f() { load_instruction_at(0, data); }"),
        ("arithmetic/field-operation", "fn f() { vault.amount += amount; }"),
        ("pda-bump/explicit-constraint", "struct A { #[account(bump = args.bump)] vault: Account<Vault> }"),
        ("arithmetic/integer-cast", "fn f() { let n = amount as u8; }"),
        ("token2022/unchecked-transfer", "fn f() { token::transfer(ctx, amount); }"),
        ("token2022/legacy-rent-size", "fn f() { rent.minimum_balance(165); }"),
        ("token2022/legacy-account-space", "struct A { #[account(space = 165)] vault: AccountInfo<'info> }"),
        ("missing-constraint/account-authority", "struct Vault { authority: Pubkey } struct A { vault: Account<Vault>, authority: Signer<'info> }"),
        ("type-cosplay/literal-discriminator-prefix", "#[account(discriminator = [1])] struct A {} #[account(discriminator = [1,2])] struct B {}"),
        ("signer-seeds/field-derived-cpi", "fn f() { invoke_signed(&ix, accounts, args.seeds); }"),
        ("missing-owner/unchecked-parameter-read", "fn f(data: AccountInfo) { data.try_borrow_data()?; }"),
        ("signer-seeds/anchor-cpi-context", "fn f() { CpiContext::new_with_signer(program, accounts, args.seeds); }"),
        ("arbitrary-cpi/unchecked-parameter-context", "fn f(program: AccountInfo) { CpiContext::new(program, accounts); }"),
        ("missing-signer/unchecked-parameter", "fn f(authority: AccountInfo) {}"),
        ("unchecked-sysvar-id/account-reader", "fn f() { Sysvar::from_account_info(account); }"),
        ("unchecked-sysvar-id/remaining-accounts", "fn f() { consume(ctx.remaining_accounts); }"),
        ("revival-reinit/manual-lamport-zero", "fn f() { **account.try_borrow_mut_lamports()? = 0; }"),
        ("duplicate-mutable/account-loader", "struct A { #[account(mut)] a: AccountLoader<State>, #[account(mut)] b: AccountLoader<State> }"),
        ("token2022/interface-mint", "struct A { mint: InterfaceAccount<Mint> }"),
        ("token2022/amount-only-close", "fn f() { if vault.amount == 0 { token_interface::close_account(ctx); } }"),
    ];
    let advertised = analyze("src/lib.rs", "").unwrap().implemented_rules;
    assert_eq!(advertised.iter().copied().collect::<BTreeSet<_>>(),
        fixtures.iter().map(|(id, _)| *id).collect::<BTreeSet<_>>());
    assert_eq!(advertised.len(), fixtures.len(), "no duplicate advertised rules");
    for (id, source) in fixtures {
        let report = analyze("src/lib.rs", source).unwrap();
        assert!(!report.hits.is_empty(), "{id} must fire");
        for hit in report.hits {
            assert_eq!(hit.rule_id, id, "{source}");
            assert_eq!(hit.class, id.split_once('/').unwrap().0);
            assert!(report.implemented_rules.contains(&hit.rule_id));
        }
    }
}

#[test]
fn supplemental_matchers_use_their_advertised_ids() {
    let source = "fn f(system: Program<System>) { invoke(&Instruction { program_id: system.key(), accounts: vec![], data: vec![] }, accounts); }";
    let mut report = analyze("src/lib.rs", source).unwrap();
    cve::append(&mut report, "src/lib.rs", source,
        "[[package]]\nname = 'anchor-lang'\nversion = '1.0.1'\n").unwrap();
    assert_eq!(report.hits.len(), 1);
    assert_eq!(report.hits[0].rule_id, "anchor-cve-2026-45137/inline-instruction");
    assert!(report.implemented_rules.contains(&report.hits[0].rule_id));
    let report = manifest::analyze("Cargo.toml", "[package]\nname = 'fixture'\n").unwrap();
    assert_eq!(report.hits.len(), 1);
    assert_eq!(report.hits[0].rule_id, "arithmetic/release-overflow-checks");
    assert!(report.implemented_rules.contains(&report.hits[0].rule_id));
}
