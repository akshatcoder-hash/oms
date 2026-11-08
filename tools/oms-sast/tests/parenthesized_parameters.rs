use oms_sast::analyze;

#[test]
fn transparent_type_parentheses_preserve_parameter_signals() {
    for ty in ["(AccountInfo)", "((AccountInfo<'info>))", "&(UncheckedAccount)", "(&AccountInfo)", "&mut ((AccountInfo))"] {
        let source = format!("fn process(authority: {ty}, program: {ty}) {{\n authority.borrow_data();\n CpiContext::new(program, accounts);\n }}");
        let hits = analyze("src/lib.rs", &source).unwrap().hits;
        let ids: Vec<_> = hits.iter().map(|hit| (hit.rule_id, hit.location.line)).collect();
        assert_eq!(ids, [
            ("missing-signer/unchecked-parameter", 1),
            ("missing-owner/unchecked-parameter-read", 2),
            ("arbitrary-cpi/unchecked-parameter-context", 3),
        ], "{source}");
        assert!(hits.iter().all(|hit| hit.location.handler.as_deref() == Some("process")));
    }
}

#[test]
fn parentheses_preserve_guarded_and_typed_controls() {
    for source in [
        "fn process(authority: (AccountInfo)) { if !authority.is_signer { return Err(Error); } if authority.owner != expected { return Err(Error); } authority.borrow_data(); }",
        "fn process(authority: (Signer), data: (Account<State>), program: (Program<Token>)) { data.borrow_data(); CpiContext::new(program, accounts); }",
        "fn process(authority: (AccountInfo,), program: (AccountInfo,)) {}",
        "fn process(authority: Option<AccountInfo>, program: Box<AccountInfo>) {}",
    ] { assert!(analyze("src/lib.rs", source).unwrap().hits.is_empty(), "{source}"); }
}

#[test]
fn parenthesized_method_and_trait_parameters_are_checked() {
    let source = "impl Processor { fn process(authority: (AccountInfo)) { authority.try_borrow_mut_data(); } } trait Handler { fn fallback(program: &(AccountInfo)) { CpiContext::new(program, accounts); } }";
    let hits = analyze("src/lib.rs", source).unwrap().hits;
    assert_eq!(hits.iter().map(|hit| (hit.rule_id, hit.location.handler.as_deref())).collect::<Vec<_>>(), [
        ("missing-signer/unchecked-parameter", Some("process")),
        ("missing-owner/unchecked-parameter-read", Some("process")),
        ("arbitrary-cpi/unchecked-parameter-context", Some("fallback")),
    ]);
}
