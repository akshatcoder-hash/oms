use crate::{Analysis, Hit, Location};
use syn::{spanned::Spanned, visit::Visit};

pub fn append(analysis: &mut Analysis, path: &str, source: &str, lock: &str) -> Result<(), String> {
    let document: toml::Value = toml::from_str(lock).map_err(|_| "invalid Cargo.lock TOML")?;
    let packages = document.get("package").and_then(toml::Value::as_array).ok_or("Cargo.lock lacks package array")?;
    let mut affected = false;
    let range = semver::VersionReq::parse(">=1.0.0, <1.0.2").unwrap();
    for package in packages {
        let name = package.get("name").and_then(toml::Value::as_str).ok_or("lock package lacks name")?;
        let version = package.get("version").and_then(toml::Value::as_str).ok_or("lock package lacks version")?;
        let version = semver::Version::parse(version).map_err(|_| "invalid lock package version")?;
        affected |= name == "anchor-lang" && range.matches(&version);
    }
    analysis.implemented_rules.push("anchor-cve-2026-45137/inline-instruction");
    if affected {
        let tree = syn::parse_file(source).map_err(|_| "invalid Rust syntax")?;
        scan_items(&tree.items, path, analysis);
    }
    Ok(())
}

fn type_path(ty: &syn::Type) -> Option<&syn::Path> {
    match ty {
        syn::Type::Reference(reference) => type_path(&reference.elem),
        syn::Type::Paren(paren) => type_path(&paren.elem),
        syn::Type::Group(group) => type_path(&group.elem),
        syn::Type::Path(path) if path.qself.is_none() => Some(&path.path),
        _ => None,
    }
}
fn type_argument<'a>(ty: &'a syn::Type, wrapper: &str) -> Option<&'a syn::Path> {
    let segment = type_path(ty)?.segments.last()?;
    if segment.ident != wrapper { return None; }
    let syn::PathArguments::AngleBracketed(arguments) = &segment.arguments else { return None; };
    let types: Vec<_> = arguments.args.iter().filter_map(|arg| match arg {
        syn::GenericArgument::Type(ty) => Some(ty), _ => None,
    }).collect();
    if types.len() != 1 { return None; }
    type_path(types[0])
}
fn system_program(ty: &syn::Type) -> bool {
    type_argument(ty, "Program").is_some_and(|path| path.segments.last().is_some_and(|part| part.ident == "System"))
}
fn expression_path(expr: &syn::Expr) -> Option<Vec<String>> {
    match crate::unparen(expr) {
        syn::Expr::Reference(reference) => expression_path(&reference.expr),
        syn::Expr::Path(path) if path.qself.is_none() => path.path.get_ident().map(|id| vec![id.to_string()]),
        syn::Expr::Field(field) => {
            let syn::Member::Named(name) = &field.member else { return None; };
            let mut path = expression_path(&field.base)?;
            path.push(name.to_string());
            Some(path)
        }
        syn::Expr::MethodCall(call) if call.args.is_empty() && call.turbofish.is_none()
            && matches!(call.method.to_string().as_str(), "to_account_info" | "clone") => expression_path(&call.receiver),
        _ => None,
    }
}
fn scan_items(items: &[syn::Item], path: &str, analysis: &mut Analysis) {
    let mut bodies = Bodies { items, path, analysis };
    for item in items { bodies.visit_item(item); }
}

/// Parameter bindings belong to one body. Context structs are resolved only
/// against the current lexical module, never by inheriting another body's args.
struct Bodies<'a> {
    items: &'a [syn::Item],
    path: &'a str,
    analysis: &'a mut Analysis,
}
impl Bodies<'_> {
    fn check(&mut self, sig: &syn::Signature, body: &syn::Block) {
        let mut programs = Vec::new();
        for arg in &sig.inputs {
            let syn::FnArg::Typed(arg) = arg else { continue; };
            let syn::Pat::Ident(name) = arg.pat.as_ref() else { continue; };
            if name.subpat.is_some() { continue; }
            if system_program(&arg.ty) { programs.push(vec![name.ident.to_string()]); }
            let Some(accounts) = type_argument(&arg.ty, "Context").and_then(syn::Path::get_ident) else { continue; };
            let structs: Vec<_> = self.items.iter().filter_map(|item| match item {
                syn::Item::Struct(item) if item.ident == *accounts => Some(item), _ => None,
            }).collect();
            if structs.len() != 1 { continue; }
            for field in &structs[0].fields {
                if system_program(&field.ty) {
                    if let Some(field_name) = &field.ident {
                        programs.push(vec![name.ident.to_string(), "accounts".into(), field_name.to_string()]);
                    }
                }
            }
        }
        Calls { programs, path: self.path, handler: sig.ident.to_string(), analysis: self.analysis }.visit_block(body);
    }
}
impl<'ast> Visit<'ast> for Bodies<'_> {
    fn visit_item_mod(&mut self, module: &'ast syn::ItemMod) {
        if let Some((_, children)) = &module.content {
            scan_items(children, self.path, self.analysis);
        }
    }
    fn visit_item_fn(&mut self, function: &'ast syn::ItemFn) {
        self.check(&function.sig, &function.block);
        syn::visit::visit_item_fn(self, function);
    }
    fn visit_impl_item_fn(&mut self, method: &'ast syn::ImplItemFn) {
        self.check(&method.sig, &method.block);
        syn::visit::visit_impl_item_fn(self, method);
    }
    fn visit_trait_item_fn(&mut self, method: &'ast syn::TraitItemFn) {
        if let Some(body) = &method.default { self.check(&method.sig, body); }
        syn::visit::visit_trait_item_fn(self, method);
    }
}

struct Calls<'a> {
    programs: Vec<Vec<String>>,
    path: &'a str,
    handler: String,
    analysis: &'a mut Analysis,
}
impl<'ast> Visit<'ast> for Calls<'_> {
    // Nested declarations cannot inherit the enclosing function's bindings.
    fn visit_item(&mut self, _: &'ast syn::Item) {}
    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        let syn::Expr::Path(function) = crate::unparen(&call.func) else {
            syn::visit::visit_expr_call(self, call); return;
        };
        let invoke = function.qself.is_none() && function.path.segments.last().is_some_and(|part|
            (part.ident == "invoke" && call.args.len() == 2)
            || (part.ident == "invoke_signed" && call.args.len() == 3));
        if invoke {
            let mut arg = crate::unparen(&call.args[0]);
            if let syn::Expr::Reference(reference) = arg { arg = crate::unparen(&reference.expr); }
            if let syn::Expr::Struct(instruction) = arg {
                let instruction_type = instruction.qself.is_none()
                    && instruction.path.segments.last().is_some_and(|part| part.ident == "Instruction");
                let from_account = instruction.fields.iter().any(|field| {
                    if !matches!(&field.member, syn::Member::Named(name) if name == "program_id") { return false; }
                    let syn::Expr::MethodCall(key) = crate::unparen(&field.expr) else { return false; };
                    key.method == "key" && key.args.is_empty() && key.turbofish.is_none()
                        && expression_path(&key.receiver).is_some_and(|path| self.programs.contains(&path))
                });
                if instruction_type && from_account {
                    self.analysis.hits.push(Hit {
                        tool: "oms-sast", rule_id: "anchor-cve-2026-45137/inline-instruction", class: "anchor-cve-2026-45137", severity: "high",
                        location: Location { file: self.path.into(), line: call.span().start().line, handler: Some(self.handler.clone()) },
                        message: "Cargo.lock contains affected anchor-lang and this inline CPI instruction takes its program id from a Program<System> account. Review RUSTSEC-2026-0144; dependency reachability, type resolution and manual validation are not proven.",
                    });
                }
            }
        }
        syn::visit::visit_expr_call(self, call);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn lock(version: &str) -> String {
        format!("version = 4\n[[package]]\nname = 'anchor-lang'\nversion = '{version}'\n")
    }
    fn source(program: &str) -> String {
        format!("fn pay(system_program: Program<'_, System>) {{\ninvoke(&Instruction {{ program_id: {program}, accounts: vec![], data: vec![] }}, accounts);\n}}")
    }
    fn hits(source: &str, lock: &str) -> Result<Vec<Hit>, String> {
        let mut result = crate::analyze("src/lib.rs", source).unwrap();
        append(&mut result, "src/lib.rs", source, lock)?;
        Ok(result.hits.into_iter().filter(|h| h.class == "anchor-cve-2026-45137").collect())
    }
    #[test]
    fn requires_affected_lock_typed_system_and_account_derived_cpi_id() {
        for version in ["1.0.0", "1.0.1", "1.0.1+build"] {
            let found = hits(&source("system_program.key()"), &lock(version)).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].location.line, 2);
            assert_eq!(found[0].location.handler.as_deref(), Some("pay"));
        }
        for version in ["0.32.3", "1.0.2", "1.2.2", "1.0.0-rc.1"] {
            assert!(hits(&source("system_program.key()"), &lock(version)).unwrap().is_empty());
        }
        for program in ["System::id()", "other.key()", "fixed_id"] {
            assert!(hits(&source(program), &lock("1.0.1")).unwrap().is_empty());
        }
        assert!(hits(&source("system_program.key()").replace("System>", "Token>"), &lock("1.0.1")).unwrap().is_empty());
        assert!(hits(&source("system_program.key()"), &lock("1.0.1").replace("anchor-lang", "other")).unwrap().is_empty());
    }
    #[test]
    fn context_fields_and_signed_inline_instructions_are_supported() {
        let src = "struct Pay<'info> { system_program: Program<'info, System> }\nfn pay(ctx: Context<Pay>) {\ninvoke_signed(&Instruction { program_id: ctx.accounts.system_program.key(), accounts: vec![], data: vec![] }, accounts, seeds);\n}";
        let found = hits(src, &lock("1.0.1")).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].location.line, 3);
        assert!(hits(&src.replace("Context<Pay>", "Context<Other>"), &lock("1.0.1")).unwrap().is_empty());
        assert!(hits(&src.replace("ctx.accounts.system_program", "other.accounts.system_program"), &lock("1.0.1")).unwrap().is_empty());
    }
    #[test]
    fn unused_instructions_comments_macros_and_nested_scope_do_not_match() {
        for body in [
            "let ix = Instruction { program_id: system_program.key() };",
            "// invoke(&Instruction { program_id: system_program.key() }, accounts);\n",
            "example!(invoke(&Instruction { program_id: system_program.key() }, accounts));",
            "fn nested() { invoke(&Instruction { program_id: system_program.key() }, accounts); }",
            "other(&Instruction { program_id: system_program.key() }, accounts);",
            "CpiContext::new(system_program.to_account_info(), accounts);",
        ] {
            let src = format!("fn pay(system_program: Program<'_, System>) {{ {body} }}");
            assert!(hits(&src, &lock("1.0.1")).unwrap().is_empty(), "{body}");
        }
    }
    #[test]
    fn malformed_lock_or_package_metadata_fails_instead_of_reporting_clean() {
        for lock in ["invalid toml", "version = 4", "package = 'bad'", "[[package]]\nname='anchor-lang'", "[[package]]\nname='anchor-lang'\nversion='broken'"] {
            assert!(hits(&source("system_program.key()"), lock).is_err(), "{lock}");
        }
    }
}
