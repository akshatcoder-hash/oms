//! Syntax coverage only: no transaction execution or exploitability assertion.
use oms_sast::{analyze, cve};

fn sites(source: &str, version: &str) -> Vec<(String, usize)> {
    let mut result = analyze("lib.rs", source).unwrap();
    cve::append(&mut result, "lib.rs", source,
        &format!("[[package]]\nname='anchor-lang'\nversion='{version}'\n")).unwrap();
    result.hits.into_iter().filter(|hit| hit.class == "anchor-cve-2026-45137")
        .map(|hit| (hit.location.handler.unwrap(), hit.location.line)).collect()
}

#[test]
fn typed_system_parameters_are_checked_in_all_method_bodies() {
    for wrapper in ["impl Processor", "impl Handler for Processor", "trait Handler"] {
        for ty in ["Program<System>", "&(Program<'info, System>)"] {
            let source = format!("{wrapper} {{
 fn pay(&self, system: {ty}) {{
  invoke(&Instruction {{ program_id: system.key(), accounts: vec![], data: vec![] }}, accounts);
 }}
}}");
            assert_eq!(sites(&source, "1.0.1"), vec![("pay".into(), 3)], "{source}");
            assert!(sites(&source, "1.0.2").is_empty());
            assert!(sites(&source.replace("System>", "Token>"), "1.0.1").is_empty());
            assert!(sites(&source.replace("system.key()", "System::id()"), "1.0.1").is_empty());
        }
    }
}

#[test]
fn methods_resolve_only_current_module_context_structs() {
    let source = "struct Pay { system: Program<System> }
impl Processor {
 fn pay(ctx: Context<Pay>) {
  invoke_signed(&Instruction { program_id: ctx.accounts.system.key(), accounts: vec![], data: vec![] }, accounts, seeds);
 }
}
mod inner {
 struct Pay { system: Program<Token> }
 impl Processor { fn safe(ctx: Context<Pay>) {
  invoke(&Instruction { program_id: ctx.accounts.system.key(), accounts: vec![], data: vec![] }, accounts);
 } }
}
mod other {
 struct Pay { system: Program<System> }
 trait Handler { fn fallback(ctx: Context<Pay>) {
  invoke(&Instruction { program_id: ctx.accounts.system.key(), accounts: vec![], data: vec![] }, accounts);
 } }
}";
    assert_eq!(sites(source, "1.0.1"), vec![("pay".into(), 4), ("fallback".into(), 16)]);
    assert!(sites(&source.replace("Context<Pay>", "Context<Other>"), "1.0.1").is_empty());
}

#[test]
fn nested_bodies_have_independent_parameters_and_handler_names() {
    let source = "fn outer(system: Program<System>) {
 fn unrelated() { invoke(&Instruction { program_id: system.key() }, accounts); }
 fn nested(system: Program<System>) {
  invoke(&Instruction { program_id: system.key() }, accounts);
 }
 impl Local {
  fn unrelated() { invoke(&Instruction { program_id: system.key() }, accounts); }
  fn local(system: Program<System>) {
   invoke(&Instruction { program_id: system.key() }, accounts);
  }
 }
 invoke(&Instruction { program_id: system.key() }, accounts);
}";
    assert_eq!(sites(source, "1.0.1"), vec![("outer".into(), 12), ("nested".into(), 4), ("local".into(), 9)]);
}

#[test]
fn method_non_calls_and_untyped_receivers_do_not_satisfy_cve_conjunction() {
    for body in [
        "let ix = Instruction { program_id: system.key() };",
        "CpiContext::new(system.to_account_info(), accounts);",
        "example!(invoke(&Instruction { program_id: system.key() }, accounts));",
        "invoke(&Instruction { program_id: self.system.key() }, accounts);",
    ] {
        let source = format!("impl Processor {{ fn pay(&self, system: Program<System>) {{ {body} }} }}");
        assert!(sites(&source, "1.0.1").is_empty(), "{source}");
    }
    assert!(sites("trait Handler { fn pay(system: Program<System>); }", "1.0.1").is_empty());
}
