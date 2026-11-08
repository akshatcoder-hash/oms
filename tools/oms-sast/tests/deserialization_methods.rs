use oms_sast::analyze;

fn sites(source: &str) -> Vec<(usize, String)> {
    analyze("src/lib.rs", source).unwrap().hits.into_iter()
        .filter(|hit| hit.rule_id == "type-cosplay/unchecked-deserialization")
        .map(|hit| (hit.location.line, hit.location.handler.unwrap())).collect()
}

#[test]
fn impl_and_trait_default_methods_are_checked() {
    for source in [
        "impl Processor { fn process(&self, data: &[u8]) {\n State::try_from_slice(data)?;\n } }",
        "impl Handler for Processor { fn process(data: &[u8]) {\n borsh::try_from_slice_unchecked::<State>(data)?;\n } }",
        "trait Handler { fn process(data: &[u8]) {\n State::try_from_slice(data)?;\n } }",
    ] { assert_eq!(sites(source), vec![(2, "process".into())], "{source}"); }
}

#[test]
fn methods_preserve_local_discriminator_guard_rules() {
    for body in [
        "if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } State::try_from_slice(data)?;",
        "if State::DISCRIMINATOR != data[0..8] { return Err(Error::Type); } borsh::try_from_slice_unchecked::<State>(data)?;",
    ] {
        assert!(sites(&format!("impl Processor {{ fn process(data: &[u8]) {{ {body} }} }}")).is_empty());
        assert!(sites(&format!("trait Handler {{ fn process(data: &[u8]) {{ {body} }} }}")).is_empty());
    }
    for body in [
        "if data[..8] != Other::DISCRIMINATOR { return Err(Error::Type); } State::try_from_slice(data)?;",
        "#[cfg(any())] if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } State::try_from_slice(data)?;",
        "if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } let later = || State::try_from_slice(data);",
        "if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } let later = async { State::try_from_slice(data) };",
    ] {
        for source in [format!("impl Processor {{ fn process(data: &[u8]) {{ {body} }} }}"),
            format!("trait Handler {{ fn process(data: &[u8]) {{ {body} }} }}")] {
            assert_eq!(sites(&source), vec![(1, "process".into())], "{source}");
        }
    }
}

#[test]
fn nested_methods_and_functions_have_independent_guards_and_attribution() {
    let source = "fn outer() {
 impl Processor {
  fn guarded(data: &[u8]) {
   if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); }
   State::try_from_slice(data)?;
  }
  fn process(data: &[u8]) {
   fn nested() { State::try_from_slice(data); }
   State::try_from_slice(data);
  }
 }
 trait Handler { fn fallback() { State::try_from_slice(data); } }
 State::try_from_slice(data);
}";
    assert_eq!(sites(source), vec![(8, "nested".into()), (9, "process".into()),
        (12, "fallback".into()), (13, "outer".into())]);
}

#[test]
fn declarations_checked_calls_and_macro_tokens_are_not_deserializations() {
    for source in [
        "trait Handler { fn process(data: &[u8]); }",
        "impl Processor { fn process() { State::try_deserialize(&mut data)?; } }",
        "trait Handler { fn process() { State::unpack(data)?; } }",
        "impl Processor { fn process() { quote!(State::try_from_slice(data)); } }",
        "trait Handler { fn process() { let text = \"State::try_from_slice(data)\"; } }",
    ] { assert!(sites(source).is_empty(), "{source}"); }
}
