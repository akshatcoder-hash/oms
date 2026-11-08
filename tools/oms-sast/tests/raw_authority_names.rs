use oms_sast::analyze;

fn rules(source: &str) -> Vec<&'static str> {
    analyze("lib.rs", source).unwrap().hits.into_iter().map(|hit| hit.rule_id).collect()
}

#[test]
fn raw_authority_names_keep_signer_signals() {
    for name in ["authority", "admin", "owner", "payer", "authority_key"] {
        for ty in ["AccountInfo", "UncheckedAccount"] {
            assert_eq!(rules(&format!("struct Accounts {{ r#{name}: {ty} }}")), vec!["missing-signer/anchor-field"]);
            for wrapper in ["", "impl Processor", "trait Processor"] {
                let body = format!("fn process(r#{name}: {ty}) {{ work(); }}");
                let source = if wrapper.is_empty() { body } else { format!("{wrapper} {{ {body} }}") };
                assert_eq!(rules(&source), vec!["missing-signer/unchecked-parameter"], "{source}");
            }
        }
    }
}

#[test]
fn raw_names_preserve_signer_controls_and_unrelated_names() {
    for name in ["authority", "admin", "owner", "payer"] {
        for source in [
            format!("struct Accounts {{ #[account(signer)] r#{name}: AccountInfo }}"),
            format!("struct Accounts {{ r#{name}: Signer }}"),
            format!("fn process(r#{name}: AccountInfo) {{ if !r#{name}.is_signer {{ return Err(Error); }} work(); }}"),
            format!("fn process(r#{name}: AccountInfo) {{ if !r#{name}.is_signer() {{ return Err(Error); }} work(); }}"),
        ] { assert!(rules(&source).is_empty(), "{source}"); }
    }
    for name in ["authorityish", "administrator", "ownership", "repayer", "data"] {
        assert!(rules(&format!("struct Accounts {{ r#{name}: AccountInfo }} fn process(r#{name}: AccountInfo) {{ work(); }}")).is_empty());
    }
}

#[test]
fn raw_state_authority_field_keeps_link_signal() {
    for name in ["authority", "admin", "owner"] {
        let source = format!("struct Vault {{ r#{name}: Pubkey }} struct Accounts {{ vault: Account<Vault>, signer: Signer }}");
        assert_eq!(rules(&source), vec!["missing-constraint/account-authority"], "{source}");
    }
}
