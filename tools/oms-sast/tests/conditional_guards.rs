use oms_sast::analyze;

#[test]
fn conditional_signer_and_owner_guards_do_not_suppress_findings() {
    for (rule, condition, action) in [
        ("missing-signer/unchecked-parameter", "!authority.is_signer", "transfer()"),
        ("missing-signer/unchecked-parameter", "!authority.is_signer()", "transfer()"),
        ("missing-owner/unchecked-parameter-read", "authority.owner != expected", "authority.borrow_data()"),
        ("missing-owner/unchecked-parameter-read", "authority.owner() != expected", "authority.try_borrow_data()?"),
        ("missing-owner/unchecked-parameter-read", "!authority.is_owned_by(expected)", "authority.borrow_data()"),
    ] {
        for (branch_attr, return_attr, expected) in [
            ("#[cfg(any())]", "", 1),
            ("", "#[cfg(any())]", 1),
            ("#[cfg_attr(feature = \"omit\", cfg(any()))]", "", 1),
            ("", "#[cfg_attr(feature = \"omit\", cfg(any()))]", 1),
            ("", "", 0),
        ] {
            let source = format!("fn f(authority: &AccountInfo) {{ {branch_attr} if {condition} {{ {return_attr} return Err(Error::Invalid); }} {action}; }}");
            let hits = analyze("lib.rs", &source).unwrap().hits;
            assert_eq!(hits.iter().filter(|hit| hit.rule_id == rule).count(), expected, "{rule}: {source}");
        }
    }
}
