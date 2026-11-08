//! Matcher boundaries, not an exploitability corpus. Negative cases exercise
//! recognized alternatives; absence of a syntax signal is not a safety verdict.
use oms_sast::{analyze, cve, manifest};
use std::collections::BTreeSet;

#[test]
fn every_source_rule_has_two_positive_and_two_negative_boundaries() {
    let fixtures = [
        ("type-cosplay/unchecked-deserialization", [
            "fn f() { State::try_from_slice(data); }",
            "fn f() { borsh::try_from_slice_unchecked::<State>(data)?; }",
        ], [
            "fn f() { if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } State::try_from_slice(data); }",
            "fn f() { if State::DISCRIMINATOR != data[0..8] { return Err(Error::Type); } borsh::try_from_slice_unchecked::<State>(data)?; }",
        ]),
        ("missing-signer/anchor-field", [
            "struct A { authority: UncheckedAccount<'info> }",
            "struct A { admin: AccountInfo<'info> }",
        ], [
            "struct A { authority: Signer<'info> }",
            "struct A { #[account(signer)] admin: AccountInfo<'info> }",
        ]),
        ("revival-reinit/init-if-needed", [
            "struct A { #[account(init_if_needed)] vault: Account<Vault> }",
            "struct A { #[account(mut, init_if_needed, payer = payer)] state: Account<State> }",
        ], [
            "struct A { #[account(init)] vault: Account<Vault> }",
            "struct A { #[account(mut)] state: Account<State> }",
        ]),
        ("duplicate-mutable/anchor-dup", [
            "struct A { #[account(dup)] vault: Account<Vault> }",
            "struct A { #[account(mut, dup)] state: Account<State> }",
        ], [
            "struct A { #[account(mut)] vault: Account<Vault> }",
            "struct A { #[account(constraint = dup)] state: Account<State> }",
        ]),
        ("pda-bump/explicit-derivation", [
            "fn f() { Pubkey::create_program_address(seeds, id); }",
            "fn f() { solana_program::pubkey::Pubkey::create_program_address(seeds, id)?; }",
        ], [
            "fn f() { Pubkey::find_program_address(seeds, id); }",
            "fn f() { Pubkey::try_find_program_address(seeds, id); }",
        ]),
        ("unchecked-sysvar-id/instruction-reader", [
            "fn f() { load_instruction_at(0, data); }",
            "fn f() { instructions::load_instruction_at(index, data)?; }",
        ], [
            "fn f() { load_instruction_at_checked(0, account); }",
            "fn f() { instructions::load_instruction_at_checked(index, account)?; }",
        ]),
        ("arithmetic/field-operation", [
            "fn f() { vault.amount += amount; }",
            "fn f() { let n = state.count * factor; }",
        ], [
            "fn f() { vault.amount = vault.amount.checked_add(amount).ok_or(Error::Overflow)?; }",
            "fn f() { let n = state.count.checked_mul(factor).ok_or(Error::Overflow)?; }",
        ]),
        ("pda-bump/explicit-constraint", [
            "struct A { #[account(bump = args.bump)] vault: Account<Vault> }",
            "struct A { #[account(seeds = [b\"vault\"], bump = supplied)] vault: Account<Vault> }",
        ], [
            "struct A { #[account(bump)] vault: Account<Vault> }",
            "struct A { #[account(seeds = [b\"vault\"], bump)] vault: Account<Vault> }",
        ]),
        ("arithmetic/integer-cast", [
            "fn f() { let n = amount as u8; }",
            "fn f() { let n = amount as i16; }",
        ], [
            "fn f() { let n = u8::try_from(amount)?; }",
            "fn f() { let n: i16 = amount.try_into()?; }",
        ]),
        ("token2022/unchecked-transfer", [
            "fn f() { token::transfer(ctx, amount); }",
            "fn f() { spl_token_2022::instruction::transfer(program, source, destination, authority, signers, amount); }",
        ], [
            "fn f() { token::transfer_checked(ctx, amount, decimals); }",
            "fn f() { spl_token_2022::instruction::transfer_checked(program, source, mint, destination, authority, signers, amount, decimals); }",
        ]),
        ("token2022/legacy-rent-size", [
            "fn f() { rent.minimum_balance(165); }",
            "fn f() { Rent::minimum_balance(&rent, 165usize); }",
        ], [
            "fn f() { rent.minimum_balance(extension_account_len); }",
            "fn f() { Rent::minimum_balance(&rent, calculated_len); }",
        ]),
        ("token2022/legacy-account-space", [
            "struct A { #[account(space = 165)] vault: AccountInfo<'info> }",
            "struct A { #[account(init, space = 165usize)] vault: AccountInfo<'info> }",
        ], [
            "struct A { #[account(space = extension_len)] vault: AccountInfo<'info> }",
            "struct A { #[account(init, space = calculated_len)] vault: AccountInfo<'info> }",
        ]),
        ("missing-constraint/account-authority", [
            "struct Vault { authority: Pubkey } struct A { vault: Account<Vault>, authority: Signer<'info> }",
            "struct State { admin: Pubkey } struct A { state: Account<State>, admin: Signer<'info> }",
        ], [
            "struct Vault { authority: Pubkey } struct A { #[account(has_one = authority)] vault: Account<Vault>, authority: Signer<'info> }",
            "struct State { admin: Pubkey } struct A { #[account(constraint = state.admin == admin.key())] state: Account<State>, admin: Signer<'info> }",
        ]),
        ("type-cosplay/literal-discriminator-prefix", [
            "#[account(discriminator = [1])] struct A {} #[account(discriminator = [1,2])] struct B {}",
            "#[account(discriminator = [3,4])] struct A {} #[account(discriminator = [3,4])] struct B {}",
        ], [
            "#[account(discriminator = [1])] struct A {} #[account(discriminator = [2])] struct B {}",
            "#[account(discriminator = [3,4])] struct A {} #[account(discriminator = [3,5])] struct B {}",
        ]),
        ("signer-seeds/field-derived-cpi", [
            "fn f() { invoke_signed(&ix, accounts, args.seeds); }",
            "fn f() { invoke_signed_unchecked(&ix, accounts, &[state.seed]); }",
        ], [
            "fn f() { invoke_signed(&ix, accounts, &[b\"constant\"]); }",
            "fn f() { invoke_signed_unchecked(&ix, accounts, &[b\"other\"]); }",
        ]),
        ("missing-owner/unchecked-parameter-read", [
            "fn f(data: AccountInfo) { data.try_borrow_data()?; }",
            "fn f(data: &UncheckedAccount) { data.borrow_data(); }",
        ], [
            "fn f(data: AccountInfo) { if data.owner != expected { return Err(Error::Owner); } data.try_borrow_data()?; }",
            "fn f(data: &UncheckedAccount) { if expected != data.owner { return Err(Error::Owner); } let bytes = data.borrow_data(); }",
        ]),
        ("signer-seeds/anchor-cpi-context", [
            "fn f() { CpiContext::new_with_signer(program, accounts, args.seeds); }",
            "fn f() { anchor_lang::context::CpiContext::new_with_signer(program, accounts, &[state.seed]); }",
        ], [
            "fn f() { CpiContext::new_with_signer(program, accounts, &[b\"constant\"]); }",
            "fn f() { CpiContext::new(program, accounts); }",
        ]),
        ("arbitrary-cpi/unchecked-parameter-context", [
            "fn f(program: AccountInfo) { CpiContext::new(program, accounts); }",
            "fn f(program: &UncheckedAccount) { CpiContext::new_with_signer(program.to_account_info(), accounts, seeds); }",
        ], [
            "fn f(program: Program<Token>) { CpiContext::new(program, accounts); }",
            "fn f(program: Interface<TokenInterface>) { CpiContext::new_with_signer(program.to_account_info(), accounts, seeds); }",
        ]),
        ("missing-signer/unchecked-parameter", [
            "fn f(authority: AccountInfo) {}",
            "fn f(admin: &UncheckedAccount) { update(); }",
        ], [
            "fn f(authority: AccountInfo) { if !authority.is_signer { return Err(Error::Signer); } update(); }",
            "fn f(admin: &UncheckedAccount) { if !admin.is_signer() { return Err(Error::Signer); } update(); }",
        ]),
        ("unchecked-sysvar-id/account-reader", [
            "fn f() { Sysvar::from_account_info(account); }",
            "fn f() { <Clock as Sysvar>::from_account_info(account); }",
        ], [
            "fn f() { Clock::get(); }",
            "fn f() { Rent::get(); }",
        ]),
        ("unchecked-sysvar-id/remaining-accounts", [
            "fn f() { consume(ctx.remaining_accounts); }",
            "fn f() { let first = ctx.remaining_accounts[0]; }",
        ], [
            "fn f() { consume(ctx.accounts.vault); }",
            "fn f() { let first = ctx.accounts.authority; }",
        ]),
        ("revival-reinit/manual-lamport-zero", [
            "fn f() { **account.try_borrow_mut_lamports()? = 0; }",
            "fn f() { **account.borrow_mut_lamports() = 0u64; }",
        ], [
            "fn f() { account.close(destination)?; }",
            "struct A { #[account(close = destination)] state: Account<State> }",
        ]),
        ("duplicate-mutable/account-loader", [
            "struct A { #[account(mut)] a: AccountLoader<State>, #[account(mut)] b: AccountLoader<State> }",
            "struct A { #[account(mut)] first: AccountLoader<'info, state::Vault>, #[account(mut)] second: AccountLoader<'info, state::Vault> }",
        ], [
            "struct A { #[account(mut, constraint = a.key() != b.key())] a: AccountLoader<State>, #[account(mut)] b: AccountLoader<State> }",
            "struct A { #[account(mut)] first: AccountLoader<Vault>, #[account(mut, constraint = second.key() != first.key())] second: AccountLoader<Vault> }",
        ]),
        ("token2022/interface-mint", [
            "struct A { mint: InterfaceAccount<Mint> }",
            "struct A { mint: anchor_lang::prelude::InterfaceAccount<'info, token_interface::Mint> }",
        ], [
            "struct A { mint: Account<Mint> }",
            "struct A { token: InterfaceAccount<TokenAccount> }",
        ]),
        ("token2022/amount-only-close", [
            "fn f() { if vault.amount == 0 { token_interface::close_account(ctx); } }",
            "fn f() { if 0u64 == vault.amount { token_2022::close_account(ctx)?; } }",
        ], [
            "fn f() { if can_close_with_extensions(&vault) { token_interface::close_account(ctx); } }",
            "fn f() { if vault.amount == 0 && extensions_ok { token_2022::close_account(ctx)?; } }",
        ]),
    ];
    let advertised = analyze("src/lib.rs", "").unwrap().implemented_rules;
    let ids: BTreeSet<_> = fixtures.iter().map(|(id, _, _)| *id).collect();
    assert_eq!(ids.len(), fixtures.len(), "duplicate fixture rule");
    assert_eq!(ids, advertised.into_iter().collect(), "every advertised rule needs boundaries");
    for (id, positive, negative) in fixtures {
        assert_ne!(positive[0], positive[1], "distinct positive fixtures: {id}");
        assert_ne!(negative[0], negative[1], "distinct negative fixtures: {id}");
        for (expected, sources) in [(true, positive), (false, negative)] {
            for source in sources {
                let report = analyze("src/lib.rs", source).unwrap();
                assert_eq!(report.hits.iter().any(|hit| hit.rule_id == id), expected, "{id}: {source}");
                assert!(report.hits.iter().all(|hit| hit.rule_id == id), "unexpected cross-rule hit in {id}: {source}");
            }
        }
    }
}

#[test]
fn supplementary_rules_have_positive_and_negative_boundaries() {
    let id = "anchor-cve-2026-45137/inline-instruction";
    let source = "fn f(system: Program<System>) { invoke(&Instruction { program_id: system.key(), accounts: vec![], data: vec![] }, accounts); }";
    // Independently remove each of the three required conjuncts. A lockfile-only,
    // type-only or account-independent CPI must never satisfy the CVE matcher.
    for (version, source, expected) in [
        ("1.0.0", source.to_owned(), true),
        ("1.0.1", source.replace("invoke(", "invoke_signed(").replace("}, accounts);", "}, accounts, seeds);"), true),
        ("1.0.2", source.to_owned(), false),
        ("1.0.1", source.replace("Program<System>", "Program<Token>"), false),
        ("1.0.1", source.replace("system.key()", "System::id()"), false),
    ] {
        let mut report = analyze("src/lib.rs", &source).unwrap();
        cve::append(&mut report, "src/lib.rs", &source,
            &format!("[[package]]\nname='anchor-lang'\nversion='{version}'\n")).unwrap();
        assert!(report.implemented_rules.contains(&id));
        assert_eq!(report.hits.iter().any(|hit| hit.rule_id == id), expected, "{version}: {source}");
        assert!(report.hits.iter().all(|hit| hit.rule_id == id));
    }
    for (source, expected) in [
        ("[package]\nname='fixture'", true),
        ("[profile.release]\noverflow-checks=false", true),
        ("[profile.release]\noverflow-checks=true", false),
        ("profile.release.overflow-checks=true", false),
    ] {
        let report = manifest::analyze("Cargo.toml", source).unwrap();
        assert_eq!(report.implemented_rules, ["arithmetic/release-overflow-checks"]);
        assert_eq!(report.hits.len(), usize::from(expected), "{source}");
        assert!(report.hits.iter().all(|hit| hit.rule_id == "arithmetic/release-overflow-checks"));
    }
}
