use syn::{GenericArgument, PathArguments};
use crate::{account_flag, account_option_matching, named_expr, unparen, Scanner};

// Resolve only explicit nongeneric paths. Aliases and instantiated state types
// remain unreviewed; equal final identifiers alone do not establish equal types.
fn loader_type(field: &syn::Field) -> Option<Vec<String>> {
    let syn::Type::Path(ty) = &field.ty else { return None; };
    if ty.qself.is_some() { return None; }
    let last = ty.path.segments.last()?;
    if last.ident != "AccountLoader" { return None; }
    let PathArguments::AngleBracketed(args) = &last.arguments else { return None; };
    let types: Vec<_> = args.args.iter().filter_map(|arg| match arg {
        GenericArgument::Type(ty) => Some(ty), _ => None,
    }).collect();
    let [syn::Type::Path(state)] = types.as_slice() else { return None; };
    if state.qself.is_some() || state.path.segments.iter().any(|part| !matches!(part.arguments, PathArguments::None)) {
        return None;
    }
    let mut path = vec![if state.path.leading_colon.is_some() { "::" } else { "" }.to_owned()];
    path.extend(state.path.segments.iter().map(|part| part.ident.to_string()));
    Some(path)
}

fn unequal_keys(expr: &syn::Expr, left: &str, right: &str) -> bool {
    let syn::Expr::Binary(binary) = unparen(expr) else { return false; };
    if matches!(binary.op, syn::BinOp::And(_)) {
        return unequal_keys(&binary.left, left, right) || unequal_keys(&binary.right, left, right);
    }
    if !matches!(binary.op, syn::BinOp::Ne(_)) { return false; }
    let key = |expr: &syn::Expr, name| matches!(unparen(expr), syn::Expr::MethodCall(call)
        if call.method == "key" && call.args.is_empty() && call.turbofish.is_none()
            && named_expr(&call.receiver, name));
    (key(&binary.left, left) && key(&binary.right, right))
        || (key(&binary.left, right) && key(&binary.right, left))
}

pub(super) fn check(item: &syn::ItemStruct, scanner: &mut Scanner<'_>) {
    let fields: Vec<_> = item.fields.iter().filter_map(|field| {
        if !account_flag(field, "mut") { return None; }
        Some((field, field.ident.as_ref()?.to_string(), loader_type(field)?))
    }).collect();
    let mut flagged = vec![false; fields.len()];
    for (i, (_, left, left_type)) in fields.iter().enumerate() {
        for (j, (_, right, right_type)) in fields.iter().enumerate().skip(i + 1) {
            if left_type != right_type { continue; }
            let constrained = item.fields.iter().any(|field|
                account_option_matching(field, "constraint", |value|
                    value.is_some_and(|expr| unequal_keys(expr, left, right))));
            if !constrained { flagged[i] = true; flagged[j] = true; }
        }
    }
    for (i, (field, _, _)) in fields.iter().enumerate() {
        if flagged[i] {
            scanner.hit("duplicate-mutable/account-loader", "duplicate-mutable", field.ident.as_ref().unwrap().span().start().line, None,
                "Mutable AccountLoader fields share a syntactic state type without a recognized key-inequality constraint. Review aliasing and manual handler checks; this signal does not establish unsafe duplicate use.");
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::analyze;
    fn hits(fields: &str) -> usize {
        analyze("src/lib.rs", &format!("struct Accounts<'info> {{ {fields} }}")).unwrap().hits.len()
    }
    #[test]
    fn same_type_mutable_loaders_are_reported_once_per_field() {
        for ty in ["AccountLoader<'info, Vault>", "anchor_lang::AccountLoader<'info, state::Vault>"] {
            let source = format!("struct Accounts<'info> {{\n #[account(mut)] first: {ty},\n #[account(mut)] second: {ty},\n #[account(mut)] third: {ty}\n}}");
            let result = analyze("src/lib.rs", &source).unwrap();
            assert_eq!(result.hits.len(), 3);
            for (i, hit) in result.hits.iter().enumerate() {
                assert_eq!(hit.class, "duplicate-mutable");
                assert_eq!(hit.location.line, i + 2);
            }
        }
    }
    #[test]
    fn distinct_types_readonly_fields_and_normal_accounts_are_excluded() {
        for fields in [
            "#[account(mut)] a: AccountLoader<'info, Vault>, b: AccountLoader<'info, Vault>",
            "#[account(mut)] a: AccountLoader<'info, one::Vault>, #[account(mut)] b: AccountLoader<'info, two::Vault>",
            "#[account(mut)] a: Account<'info, Vault>, #[account(mut)] b: Account<'info, Vault>",
            "#[account(mut)] a: AccountLoader<'info, Vault<u8>>, #[account(mut)] b: AccountLoader<'info, Vault<u16>>",
        ] { assert_eq!(hits(fields), 0, "{fields}"); }
    }
    #[test]
    fn constraints_require_inequality_of_both_keys() {
        for constraint in ["a.key() != b.key()", "enabled && (b.key() != (a).key())"] {
            assert_eq!(hits(&format!("#[account(mut)] a: AccountLoader<'info, Vault>, #[account(mut, constraint = {constraint} @ Error::Alias)] b: AccountLoader<'info, Vault>")), 0);
        }
        for constraint in ["a.key() == b.key()", "a.key() != other.key()", "a.key() != b.key() || enabled", "a.key() != b.key::<u8>()"] {
            assert_eq!(hits(&format!("#[account(mut)] a: AccountLoader<'info, Vault>, #[account(mut, constraint = {constraint})] b: AccountLoader<'info, Vault>")), 2);
        }
    }
    #[test]
    fn constraints_do_not_cover_other_pairs() {
        assert_eq!(hits("#[account(mut, constraint = a.key() != b.key())] a: AccountLoader<'info, Vault>, #[account(mut)] b: AccountLoader<'info, Vault>, #[account(mut)] c: AccountLoader<'info, Vault>"), 3);
    }
}
