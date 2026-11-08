use syn::{spanned::Spanned, GenericArgument, PathArguments, Type};
use crate::Scanner;

// This is a type-syntax inventory signal. An arbitrary account constraint is
// not evidence that all enabled extensions were checked against an allowlist.
pub(crate) fn check(item: &syn::ItemStruct, scanner: &mut Scanner<'_>) {
    for field in &item.fields {
        let Type::Path(path) = &field.ty else { continue; };
        if path.qself.is_some() { continue; }
        let Some(wrapper) = path.path.segments.last() else { continue; };
        if wrapper.ident != "InterfaceAccount" { continue; }
        let PathArguments::AngleBracketed(args) = &wrapper.arguments else { continue; };
        let types: Vec<_> = args.args.iter().filter_map(|arg| match arg {
            GenericArgument::Type(ty) => Some(ty),
            _ => None,
        }).collect();
        let [Type::Path(mint)] = types.as_slice() else { continue; };
        if mint.qself.is_some() || !mint.path.segments.last().is_some_and(|part|
            part.ident == "Mint" && matches!(part.arguments, PathArguments::None)) { continue; }
        scanner.hit("token2022/interface-mint", "token2022", field.ident.as_ref().map_or_else(|| field.span().start().line, |name| name.span().start().line), None,
            "Interface mint requires review of its extension allowlist, including PermanentDelegate, TransferFee, TransferHook and MintCloseAuthority. Type syntax does not establish missing validation; handler checks and account constraints may already enforce a policy.");
    }
}

#[cfg(test)]
mod tests {
    use crate::analyze;

    #[test]
    fn interface_mints_require_extension_policy_review() {
        for ty in ["InterfaceAccount<'info, Mint>", "anchor_lang::prelude::InterfaceAccount<'info, token_interface::Mint>"] {
            let source = format!("struct Deposit<'info> {{\n mint: {ty},\n}}");
            let report = analyze("src/lib.rs", &source).unwrap();
            assert_eq!(report.hits.len(), 1);
            assert_eq!(report.hits[0].class, "token2022");
            assert_eq!(report.hits[0].location.line, 2);
            assert!(report.hits[0].message.contains("extension allowlist"));
        }
    }

    #[test]
    fn unrelated_types_and_non_type_tokens_are_excluded() {
        for ty in ["Account<'info, Mint>", "InterfaceAccount<'info, TokenAccount>", "Interface<'info, TokenInterface>", "InterfaceAccount<'info, Mint<T>>", "InterfaceAccount<'info, T::Mint, Other>"] {
            let source = format!("struct Deposit<'info> {{ mint: {ty} }}");
            assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{ty}");
        }
        let source = r#"// InterfaceAccount<'info, Mint>
            const NOTE: &str = "InterfaceAccount<Mint>";
            tokens!(struct Deposit { mint: InterfaceAccount<Mint> });"#;
        assert!(analyze("src/lib.rs", source).unwrap().hits.is_empty());
    }

    #[test]
    fn constraint_names_do_not_claim_an_extension_allowlist() {
        for constraint in ["mint.decimals == 6", "check_extensions(&mint)?", "true"] {
            let source = format!("struct Deposit<'info> {{ #[account(constraint = {constraint})] mint: InterfaceAccount<'info, Mint> }}");
            assert_eq!(analyze("src/lib.rs", &source).unwrap().hits.len(), 1);
        }
    }
}
