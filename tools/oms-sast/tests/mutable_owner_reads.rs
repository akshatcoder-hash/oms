use oms_sast::analyze;

fn owners(source: &str) -> Vec<oms_sast::Hit> {
    analyze("src/lib.rs", source).unwrap().hits.into_iter()
        .filter(|hit| hit.rule_id == "missing-owner/unchecked-parameter-read").collect()
}

#[test]
fn unchecked_mutable_borrows_require_owner_review() {
    for method in ["borrow_mut_data", "try_borrow_mut_data"] {
        for ty in ["AccountInfo", "&UncheckedAccount"] {
            let source = format!("fn update(data: {ty}) {{\n data.{method}();\n }}");
            let hits = owners(&source);
            assert_eq!(hits.len(), 1, "{source}");
            assert_eq!(hits[0].location.line, 2);
            assert_eq!(hits[0].location.handler.as_deref(), Some("update"));
        }
    }
}

#[test]
fn mutable_borrows_use_only_immediate_rejecting_owner_guards() {
    for method in ["borrow_mut_data", "try_borrow_mut_data"] {
        for (guard, expected) in [
            ("if data.owner != expected { return Err(Error::Owner); }", 0),
            ("if !data.is_owned_by(expected) { return Err(Error::Owner); }", 0),
            ("if other.owner != expected { return Err(Error::Owner); }", 1),
            ("if data.owner != expected { log(); }", 1),
            ("#[cfg(any())] if data.owner != expected { return Err(Error::Owner); }", 1),
            ("if data.owner != expected { return Err(Error::Owner); } mutate();", 1),
        ] {
            let source = format!("fn update(data: &AccountInfo) {{ {guard} let bytes = data.{method}()?; }}");
            assert_eq!(owners(&source).len(), expected, "{source}");
        }
    }
}

#[test]
fn mutable_borrow_scope_and_typed_controls() {
    let source = "impl State { fn update(data: &AccountInfo) { if data.owner != expected { return Err(Error::Owner); } let deferred = || data.borrow_mut_data(); } } trait Updates { fn update(data: &UncheckedAccount) { data.try_borrow_mut_data(); } }";
    assert_eq!(owners(source).len(), 2);
    for source in [
        "fn f(data: Account<State>) { data.borrow_mut_data(); }",
        "fn f(data: &AccountInfo) { data.borrow_mut_lamports(); }",
        "fn f(data: &AccountInfo) { quote!(data.borrow_mut_data()); }",
        "fn f(data: &AccountInfo) { fn nested(data: Account<State>) { data.borrow_mut_data(); } }",
    ] { assert!(owners(source).is_empty(), "{source}"); }
}
