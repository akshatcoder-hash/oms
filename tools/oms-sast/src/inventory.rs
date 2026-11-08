//! Syntax-only discovery. No Cargo evaluation, macro expansion, or filesystem reads.
use serde::Serialize;
use syn::{spanned::Spanned, visit::Visit};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    name: Option<String>,
    framework: Option<&'static str>,
    lib_path: String,
}

pub fn manifest(source: &str) -> Result<Manifest, String> {
    let doc: toml::Value = toml::from_str(source).map_err(|_| "invalid manifest")?;
    let package = doc.get("package").map(|v| v.as_table().ok_or("invalid package table")).transpose()?;
    let name = package.map(|v| v.get("name").and_then(|n| n.as_str()).filter(|n| !n.is_empty()).map(String::from).ok_or("invalid package name")).transpose()?;
    let lib = doc.get("lib").map(|v| v.as_table().ok_or("invalid lib table")).transpose()?;
    let lib_path = lib.and_then(|v| v.get("path")).map(|v| v.as_str().ok_or("invalid library path")).transpose()?.unwrap_or("src/lib.rs").to_string();
    let dependencies = doc.get("dependencies").map(|v| v.as_table().ok_or("invalid dependencies table")).transpose()?;
    let mut tables = Vec::new();
    if let Some(deps) = dependencies { tables.push(deps); }
    if let Some(targets) = doc.get("target") {
        for target in targets.as_table().ok_or("invalid target table")?.values() {
            let target = target.as_table().ok_or("invalid target definition")?;
            if let Some(deps) = target.get("dependencies") {
                tables.push(deps.as_table().ok_or("invalid target dependencies")?);
            }
        }
    }
    // Inventory all declared target dependencies without evaluating cfg. Conflicting
    // framework declarations remain unresolved, even across mutually exclusive targets.
    let mut frameworks = std::collections::BTreeSet::new();
    for deps in tables {
        for (key, value) in deps {
            if !value.is_str() && !value.is_table() { return Err("invalid dependency".into()); }
            let package = value.get("package").map(|v| v.as_str().ok_or("invalid dependency package")).transpose()?.unwrap_or(key);
            match package {
                "anchor-lang" => { frameworks.insert("anchor"); }
                "pinocchio" => { frameworks.insert("pinocchio"); }
                "solana-program" | "solana-account-info" => { frameworks.insert("native"); }
                _ => {}
            }
        }
    }
    // Anchor and Pinocchio may also depend on native Solana crates.
    let framework = if frameworks.contains("anchor") && frameworks.contains("pinocchio") { None }
        else if frameworks.contains("anchor") { Some("anchor") }
        else if frameworks.contains("pinocchio") { Some("pinocchio") }
        else if frameworks.contains("native") { Some("native") } else { None };
    Ok(Manifest { name, framework, lib_path })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    program_ids: Vec<String>,
    handlers: Vec<Handler>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStruct { file: String, line: usize, end_line: usize }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Handler {
    #[serde(flatten)]
    location: crate::Handler,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_struct: Option<AccountStruct>,
}
#[derive(Default)]
struct Names(std::collections::HashMap<String, usize>);
impl Names {
    fn add(&mut self, name: &syn::Ident) { *self.0.entry(name.to_string()).or_default() += 1; }
    fn imports(&mut self, tree: &syn::UseTree) {
        match tree {
            syn::UseTree::Name(n) => self.add(&n.ident),
            syn::UseTree::Rename(n) => self.add(&n.rename),
            syn::UseTree::Path(n) => self.imports(&n.tree),
            syn::UseTree::Group(n) => for item in &n.items { self.imports(item); },
            syn::UseTree::Glob(_) => {}, // wildcard identity cannot be resolved by syntax
        }
    }
}
impl<'ast> Visit<'ast> for Names {
    fn visit_item_struct(&mut self, n: &'ast syn::ItemStruct) { self.add(&n.ident); syn::visit::visit_item_struct(self, n); }
    fn visit_item_enum(&mut self, n: &'ast syn::ItemEnum) { self.add(&n.ident); syn::visit::visit_item_enum(self, n); }
    fn visit_item_type(&mut self, n: &'ast syn::ItemType) { self.add(&n.ident); syn::visit::visit_item_type(self, n); }
    fn visit_type_param(&mut self, n: &'ast syn::TypeParam) { self.add(&n.ident); }
    fn visit_item_use(&mut self, n: &'ast syn::ItemUse) { self.imports(&n.tree); }
}
struct Inventory<'a> { file: &'a str, result: Source, structs: Vec<&'a syn::ItemStruct>, names: Names }
impl<'ast> Visit<'ast> for Inventory<'_> {
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        // This is a source candidate, never Rust name/type resolution. Only a
        // single Context<T> argument and a unique top-level Accounts struct are
        // supported. Imports, aliases and cross-file definitions stay unresolved.
        let contexts: Vec<_> = node.sig.inputs.iter().filter_map(|arg| {
            let syn::FnArg::Typed(arg) = arg else { return None; };
            let syn::Type::Path(ty) = arg.ty.as_ref() else { return None; };
            if ty.qself.is_some() { return None; }
            let segment = ty.path.segments.last()?;
            if segment.ident != "Context" { return None; }
            let syn::PathArguments::AngleBracketed(args) = &segment.arguments else { return None; };
            let types: Vec<_> = args.args.iter().filter_map(|a| match a {
                syn::GenericArgument::Type(t) => Some(t), _ => None,
            }).collect();
            if types.len() != 1 { return None; }
            let syn::Type::Path(t) = types[0] else { return None; };
            if t.qself.is_some() { return None; }
            t.path.get_ident()
        }).collect();
        let account_struct = if contexts.len() == 1 && self.names.0.get(&contexts[0].to_string()) == Some(&1) {
            let matches: Vec<_> = self.structs.iter().filter(|s| s.ident == *contexts[0]).collect();
            if matches.len() == 1 { let s = matches[0];
                Some(AccountStruct { file: self.file.into(), line: s.span().start().line, end_line: s.span().end().line })
            } else { None }
        } else { None };
        self.result.handlers.push(Handler { location: crate::Handler { name: node.sig.ident.to_string().trim_start_matches("r#").into(),
            file: self.file.into(), line: node.sig.fn_token.span().start().line }, account_struct });
        syn::visit::visit_item_fn(self, node);
    }
}
pub fn source(file: &str, source: &str) -> Result<Source, String> {
    let ast = syn::parse_file(source).map_err(|_| "invalid Rust source")?;
    let structs = ast.items.iter().filter_map(|item| match item {
        syn::Item::Struct(s) if s.attrs.iter().any(|a| a.path().is_ident("derive") &&
            a.parse_args_with(syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated)
                .is_ok_and(|paths| paths.iter().any(|p| p.segments.last().is_some_and(|s| s.ident == "Accounts")))) => Some(s),
        _ => None,
    }).collect();
    let mut names = Names::default();
    names.visit_file(&ast);
    let mut visitor = Inventory { file, structs, names, result: Source { program_ids: vec![], handlers: vec![] } };
    for item in &ast.items {
        if let syn::Item::Macro(node) = item {
            if node.mac.path.segments.last().is_some_and(|s| s.ident == "declare_id") {
                if let Ok(id) = syn::parse2::<syn::LitStr>(node.mac.tokens.clone()) {
                    visitor.result.program_ids.push(id.value());
                }
            }
        }
    }
    visitor.visit_file(&ast);
    visitor.result.program_ids.sort();
    visitor.result.program_ids.dedup();
    Ok(visitor.result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frameworks_and_renamed_dependencies() {
        for (dep, expected) in [("a={package='anchor-lang',version='1'}", "anchor"),
            ("pinocchio='0.12'", "pinocchio"), ("solana-program='4'", "native")] {
            let result = manifest(&format!("[package]\nname='counter'\n[dependencies]\n{dep}")).unwrap();
            assert_eq!(result.framework, Some(expected));
            assert_eq!(result.name.as_deref(), Some("counter"));
            assert_eq!(result.lib_path, "src/lib.rs");
        }
        assert_eq!(manifest("[dev-dependencies]\nanchor-lang='1'").unwrap().framework, None);
        assert_eq!(manifest("[dependencies]\nanchor-lang='1'\npinocchio='0.12'").unwrap().framework, None);
        for bad in ["[", "package=1", "[package]\nname=123", "[lib]\npath=123", "dependencies=1", "[dependencies]\nanchor-lang=3"] {
            assert!(manifest(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn target_dependencies_are_syntax_candidates_not_cfg_resolution() {
        for (dep, expected) in [("a={package='anchor-lang',version='1'}", "anchor"),
            ("pinocchio='0.12'", "pinocchio"), ("solana-account-info='3'", "native")] {
            let text = format!("[package]\nname='counter'\n[target.'cfg(target_os = \"solana\")'.dependencies]\n{dep}");
            assert_eq!(manifest(&text).unwrap().framework, Some(expected));
        }
        assert_eq!(manifest("[target.a.dev-dependencies]\nanchor-lang='1'\n[target.a.build-dependencies]\npinocchio='0.12'").unwrap().framework, None);
        assert_eq!(manifest("[target.a.dependencies]\nanchor-lang='1'\n[target.b.dependencies]\npinocchio='0.12'").unwrap().framework, None);
        assert_eq!(manifest("[dependencies]\nanchor-lang='1'\n[target.a.dependencies]\nsolana-program='4'").unwrap().framework, Some("anchor"));
        for bad in ["target=1", "[target]\na=1", "[target.a]\ndependencies=1", "[target.a.dependencies]\nanchor-lang=1"] {
            assert!(manifest(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn account_context_is_a_bounded_source_location_candidate() {
        let code = "#[derive(Accounts)]\npub struct Withdraw<'info> { authority: Signer<'info> }\nmod program { pub fn withdraw(ctx: Context<Withdraw>) {} }";
        let result = source("src/lib.rs", code).unwrap();
        let context = result.handlers[0].account_struct.as_ref().unwrap();
        assert_eq!((context.file.as_str(), context.line, context.end_line), ("src/lib.rs", 1, 2));
        for code in [
            "struct Withdraw {} fn f(ctx: Context<Withdraw>) {}",
            "#[derive(Accounts)] struct Withdraw {} fn f(ctx: Other<Withdraw>) {}",
            "#[derive(Accounts)] struct Withdraw {} fn f(ctx: Context<other::Withdraw>) {}",
            "#[derive(Accounts)] struct Withdraw {} fn f(a: Context<Withdraw>, b: Context<Withdraw>) {}",
            "#[derive(Accounts)] struct Withdraw {} #[derive(Accounts)] struct Withdraw {} fn f(ctx: Context<Withdraw>) {}",
            "#[derive(Accounts)] struct Withdraw {} mod p { struct Withdraw {} fn f(ctx: Context<Withdraw>) {} }",
            "#[derive(Accounts)] struct Withdraw {} mod p { use other::Withdraw; fn f(ctx: Context<Withdraw>) {} }",
            "#[derive(Accounts)] struct Withdraw {} mod p { use other::{Account as Withdraw}; fn f(ctx: Context<Withdraw>) {} }",
            "#[derive(Accounts)] struct Withdraw {} fn f<Withdraw>(ctx: Context<Withdraw>) {}",
        ] { assert!(source("lib.rs", code).unwrap().handlers[0].account_struct.is_none(), "{code}"); }
    }
    #[test]
    fn source_inventory_ignores_comments_and_strings() {
        let result = source("src/lib.rs", "// declare_id!(\"fake\");\nsolana_program::declare_id!(\"real\");\nconst S: &str = \"fn fake() {}\";\npub fn process_instruction() {}\nmod inner { declare_id!(\"dependency\"); fn helper() {} }").unwrap();
        assert_eq!(result.program_ids, ["real"]);
        assert_eq!(result.handlers.iter().map(|h| (h.location.name.as_str(), h.location.line)).collect::<Vec<_>>(), [("process_instruction", 4), ("helper", 5)]);
        assert!(source("bad.rs", "fn {").is_err());
    }
}
