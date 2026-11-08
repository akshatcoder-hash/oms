use oms_sast::analyze;

fn sites(source: &str) -> Vec<(usize, String)> {
    analyze("src/lib.rs", source).unwrap().hits.into_iter()
        .filter(|hit| hit.rule_id == "type-cosplay/unchecked-deserialization")
        .map(|hit| (hit.location.line, hit.location.handler.unwrap())).collect()
}

#[test]
fn qualified_deserialization_is_not_silently_excluded() {
    for call in [
        "<State as BorshDeserialize>::try_from_slice(data)",
        "<State>::try_from_slice(data)",
        "<module::State as borsh::BorshDeserialize>::try_from_slice(data)",
        "<Decoder as Decode>::try_from_slice_unchecked::<State>(data)",
    ] {
        for source in [
            format!("fn process() {{\n {call}?;\n}}"),
            format!("impl Processor {{ fn process() {{\n {call}?;\n}} }}"),
            format!("trait Handler {{ fn process() {{\n {call}?;\n}} }}"),
        ] { assert_eq!(sites(&source), vec![(2, "process".into())], "{source}"); }
    }
}

#[test]
fn unresolved_qualified_type_keeps_the_signal_even_with_a_guard() {
    // No trait/type resolution is performed; do not infer protection from a
    // syntactically similar constant until qualified types are resolved.
    for call in ["<State as Decode>::try_from_slice(data)", "<State>::try_from_slice(data)"] {
        let source = format!("fn process() {{\n if data[..8] != State::DISCRIMINATOR {{ return Err(Error::Type); }}\n {call}?;\n}}");
        assert_eq!(sites(&source), vec![(3, "process".into())]);
    }
}

#[test]
fn other_qualified_calls_and_noncode_remain_excluded() {
    for source in [
        "fn process() { <State as Decode>::try_deserialize(data); }",
        "fn process() { <State as Decode>::try_from_slice(); }",
        "fn process() { <State as Decode>::try_from_slice(data, extra); }",
        "fn process() { quote!(<State as Decode>::try_from_slice(data)); }",
        "fn process() { let text = \"<State as Decode>::try_from_slice(data)\"; }",
    ] { assert!(sites(source).is_empty(), "{source}"); }
}
