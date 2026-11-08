use oms_sast::analyze;

fn sites(source: &str) -> Vec<(usize, String)> {
    analyze("src/lib.rs", source).unwrap().hits.into_iter()
        .filter(|hit| hit.rule_id == "type-cosplay/unchecked-deserialization")
        .map(|hit| (hit.location.line, hit.location.handler.unwrap())).collect()
}

#[test]
fn unchecked_deserialization_requires_a_local_discriminator_guard() {
    for call in ["State::try_from_slice(data)", "borsh::try_from_slice_unchecked::<State>(data)"] {
        assert_eq!(sites(&format!("fn process(data: &[u8]) {{\n let state = {call}?;\n}}")), vec![(2, "process".into())]);
    }
    for guard in [
        "if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); }",
        "if State::DISCRIMINATOR != data[0..8] { return Err(Error::Type); }",
    ] {
        assert!(sites(&format!("fn process(data: &[u8]) {{ {guard} let state = State::try_from_slice(data)?; }}")).is_empty());
    }
}

#[test]
fn unrelated_or_ineffective_guards_do_not_hide_deserialization() {
    for guard in [
        "if other[..8] != State::DISCRIMINATOR { return Err(Error::Type); }",
        "if data[..8] == State::DISCRIMINATOR { return Err(Error::Type); }",
        "if data[..0] != State::DISCRIMINATOR { return Err(Error::Type); }",
        "if data[1..8] != State::DISCRIMINATOR { return Err(Error::Type); }",
        "if data[..8] != State::DISCRIMINATOR { log(); }",
        "if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } else { log(); }",
        "if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } modify();",
        "if data[..8] != expected() { return Err(Error::Type); }",
        "if data[..8] != State::DISCRIMINATOR && enabled { return Err(Error::Type); }",
    ] {
        let source = format!("fn process(data: &[u8]) {{ {guard} let state = State::try_from_slice(data)?; }}");
        assert_eq!(sites(&source).len(), 1, "{source}");
    }
}

#[test]
fn nested_execution_cannot_inherit_a_guard() {
    for statement in [
        "let later = || State::try_from_slice(data);",
        "let later = async { State::try_from_slice(data) };",
        "if enabled { State::try_from_slice(data); }",
        "let state = wrap(State::try_from_slice(data));",
    ] {
        let source = format!("fn process(data: &[u8]) {{ if data[..8] != State::DISCRIMINATOR {{ return Err(Error::Type); }} {statement} }}");
        assert_eq!(sites(&source).len(), 1, "{source}");
    }
    assert_eq!(sites("fn outer() { fn inner() { State::try_from_slice(data); } State::try_from_slice(data); }"),
        vec![(1, "inner".into()), (1, "outer".into())]);
}

#[test]
fn checked_deserializers_and_noncode_are_not_this_signal() {
    for source in [
        "fn process() { State::try_deserialize(&mut data)?; }",
        "fn process() { State::unpack(data)?; }",
        "fn process() { let text = \"State::try_from_slice(data)\"; }",
        "fn process() { quote!(State::try_from_slice(data)); }",
    ] { assert!(sites(source).is_empty(), "{source}"); }
}
