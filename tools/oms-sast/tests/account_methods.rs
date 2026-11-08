use oms_sast::analyze;

fn sites(source: &str) -> Vec<(String, usize, String)> {
    analyze("lib.rs", source).unwrap().hits.into_iter().map(|hit|
        (hit.rule_id.into(), hit.location.line, hit.location.handler.unwrap())).collect()
}

#[test]
fn unchecked_method_parameters_receive_signer_owner_and_cpi_checks() {
    for wrapper in ["impl Processor", "impl Handler for Processor", "trait Handler"] {
        let source = format!("{wrapper} {{
 fn process(&self, authority: &AccountInfo, account: UncheckedAccount, program: &AccountInfo) {{
  account.borrow_data();
  CpiContext::new(program.clone(), accounts);
 }}
}}");
        assert_eq!(sites(&source), vec![
            ("missing-signer/unchecked-parameter".into(), 2, "process".into()),
            ("missing-owner/unchecked-parameter-read".into(), 3, "process".into()),
            ("arbitrary-cpi/unchecked-parameter-context".into(), 4, "process".into()),
        ], "{source}");
    }
}

#[test]
fn method_parameters_preserve_existing_guard_and_type_boundaries() {
    for wrapper in ["impl Processor", "trait Handler"] {
        for body in [
            "fn process(authority: &AccountInfo, account: &AccountInfo) { if !authority.is_signer() { return Err(Error); } if !account.is_owned_by(expected) { return Err(Error); } account.borrow_data(); }",
            "fn process(authority: Signer, account: Account<State>, program: Program<Token>) { account.borrow_data(); CpiContext::new(program, accounts); }",
        ] { assert!(sites(&format!("{wrapper} {{ {body} }}")).is_empty()); }
        for guard in [
            "#[cfg(any())] if !authority.is_signer { return Err(Error); }",
            "if !authority.is_signer { #[cfg(any())] return Err(Error); }",
            "if !other.is_signer { return Err(Error); }",
        ] {
            let source = format!("{wrapper} {{ fn process(authority: &AccountInfo) {{ {guard} }} }}");
            assert_eq!(sites(&source), vec![("missing-signer/unchecked-parameter".into(), 1, "process".into())]);
        }
    }
    assert!(sites("trait Handler { fn process(authority: &AccountInfo, account: &AccountInfo); }").is_empty());
}

#[test]
fn nested_method_scopes_do_not_inherit_parameters_or_handler_names() {
    let source = "fn outer(program: &AccountInfo) {
 impl Processor {
  fn local() { CpiContext::new(program, accounts); state.value + 1; }
  fn process(program: &AccountInfo) {
   fn nested() { CpiContext::new(program, accounts); state.value + 1; }
   CpiContext::new(program, accounts);
  }
 }
 trait Handler { fn fallback() { state.value + 1; } }
 state.value + 1;
}";
    assert_eq!(sites(source), vec![
        ("arithmetic/field-operation".into(), 3, "local".into()),
        ("arbitrary-cpi/unchecked-parameter-context".into(), 6, "process".into()),
        ("arithmetic/field-operation".into(), 5, "nested".into()),
        ("arithmetic/field-operation".into(), 9, "fallback".into()),
        ("arithmetic/field-operation".into(), 10, "outer".into()),
    ]);
}

#[test]
fn method_owner_guards_do_not_leak_into_nested_or_deferred_reads() {
    for body in [
        "if account.owner != expected { return Err(Error); } let later = || account.borrow_data();",
        "if account.owner != expected { return Err(Error); } let later = async { account.borrow_data() };",
        "#[cfg(any())] if account.owner != expected { return Err(Error); } account.borrow_data();",
        "if other.owner != expected { return Err(Error); } account.borrow_data();",
    ] {
        for wrapper in ["impl Processor", "trait Handler"] {
            let source = format!("{wrapper} {{ fn process(account: &AccountInfo) {{ {body} }} }}");
            assert_eq!(sites(&source), vec![("missing-owner/unchecked-parameter-read".into(), 1, "process".into())], "{source}");
        }
    }
}
