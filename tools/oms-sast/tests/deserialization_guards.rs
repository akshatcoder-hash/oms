use oms_sast::analyze;

#[test]
fn conditional_or_wrong_type_guards_retain_the_signal() {
    for source in [
        "fn f() { #[cfg(any())] if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } State::try_from_slice(data); }",
        "fn f() { if data[..8] != State::DISCRIMINATOR { #[cfg(any())] return Err(Error::Type); } State::try_from_slice(data); }",
        "fn f() { if data[..8] != Other::DISCRIMINATOR { return Err(Error::Type); } State::try_from_slice(data); }",
        "fn f() { if data[..8] != State::DISCRIMINATOR { return Err(Error::Type); } borsh::try_from_slice_unchecked::<Other>(data); }",
        "fn f() { if data[..8] != DISCRIMINATOR { return Err(Error::Type); } State::try_from_slice(data); }",
    ] {
        let hits = analyze("lib.rs", source).unwrap().hits;
        assert_eq!(hits.iter().filter(|hit| hit.rule_id == "type-cosplay/unchecked-deserialization").count(), 1, "{source}");
    }
}
