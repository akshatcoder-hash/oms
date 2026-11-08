use oms_sast::{analyze, Hit};

fn hits(source: &str) -> Vec<Hit> {
    analyze("src/lib.rs", source).unwrap().hits.into_iter()
        .filter(|hit| hit.class == "signer-seeds").collect()
}

#[test]
fn direct_context_builder_checks_field_derived_seeds() {
    for expression in [
        "CpiContext::new(program, accounts).with_signer(args.seeds)",
        "(anchor_lang::context::CpiContext::<Transfer>::new(program, accounts)).with_signer(&[&[state.seed.as_ref()]])",
    ] {
        let source = format!("fn transfer() {{\n {expression};\n}}");
        let found = hits(&source);
        assert_eq!(found.len(), 1, "{source}");
        assert_eq!(found[0].rule_id, "signer-seeds/anchor-cpi-context");
        assert_eq!(found[0].location.line, 2);
        assert_eq!(found[0].location.handler.as_deref(), Some("transfer"));
    }
}

#[test]
fn builder_signal_requires_direct_constructor_and_seed_field() {
    for expression in [
        "CpiContext::new(program, accounts).with_signer(&[&[b\"vault\", &[255]]])",
        "CpiContext::new(state.program, args.accounts).with_signer(validated_seeds)",
        "Other::new(program, accounts).with_signer(args.seeds)",
        "context.with_signer(args.seeds)",
        "CpiContext::new(program).with_signer(args.seeds)",
        "CpiContext::new(program, accounts).with_signer(args.seeds, extra)",
        "CpiContext::new(program, accounts).with_signer({ fn helper() { state.seed; } SEEDS })",
        "quote!(CpiContext::new(program, accounts).with_signer(args.seeds))",
        "\"CpiContext::new(program, accounts).with_signer(args.seeds)\"",
    ] {
        assert!(hits(&format!("fn transfer() {{ {expression}; }}")).is_empty(), "{expression}");
    }
}

#[test]
fn builder_findings_keep_method_and_nested_handler_scope() {
    let source = "impl Processor { fn outer() { CpiContext::new(p, a).with_signer(state.seeds); fn inner() { CpiContext::new(p, a).with_signer(args.seeds); } CpiContext::new(p, a).with_signer(state.seeds); } }";
    assert_eq!(hits(source).iter().map(|hit| hit.location.handler.as_deref()).collect::<Vec<_>>(),
        [Some("outer"), Some("inner"), Some("outer")]);
}
