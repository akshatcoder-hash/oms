use syn::{spanned::Spanned, visit::Visit, BinOp, Expr, Member};
use crate::{unparen, Scanner};

// Inventory explicit amount-only branch conditions near token close calls.
// Neither account identity nor extension policy can be inferred from this syntax.
pub(crate) fn check(expr: &syn::ExprIf, scanner: &mut Scanner<'_>) {
    let Expr::Binary(condition) = unparen(&expr.cond) else { return; };
    if !matches!(condition.op, BinOp::Eq(_)) { return; }
    fn amount(expr: &Expr) -> bool {
        matches!(unparen(expr), Expr::Field(field)
            if matches!(&field.member, Member::Named(name) if name == "amount"))
    }
    fn zero(expr: &Expr) -> bool {
        matches!(unparen(expr), Expr::Lit(lit)
            if matches!(&lit.lit, syn::Lit::Int(value) if matches!(value.base10_parse::<u64>(), Ok(0))))
    }
    if !((amount(&condition.left) && zero(&condition.right))
        || (zero(&condition.left) && amount(&condition.right))) { return; }
    struct CloseCalls { sites: Vec<(usize, usize)> }
    impl<'ast> Visit<'ast> for CloseCalls {
        // A nested function/closure is not executed merely by entering this branch.
        fn visit_item(&mut self, _: &'ast syn::Item) {}
        fn visit_expr_closure(&mut self, _: &'ast syn::ExprClosure) {}
        fn visit_expr_async(&mut self, _: &'ast syn::ExprAsync) {}
        fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
            if let Expr::Path(path) = unparen(&call.func) {
                let parts: Vec<_> = path.path.segments.iter().collect();
                if path.qself.is_none() && parts.len() >= 2 && !call.args.is_empty()
                    && parts.last().unwrap().ident == "close_account"
                    && matches!(parts[parts.len() - 2].ident.to_string().as_str(),
                        "token" | "token_2022" | "token_interface") {
                    let start = call.span().start();
                    self.sites.push((start.line, start.column));
                }
            }
            syn::visit::visit_expr_call(self, call);
        }
    }
    let mut calls = CloseCalls { sites: Vec::new() };
    calls.visit_block(&expr.then_branch);
    for (line, column) in calls.sites {
        // Nested amount branches can visit the same call; emit once per source site.
        if !scanner.token_close_sites.insert((line, column)) { continue; }
        scanner.hit("token2022/amount-only-close", "token2022", line, scanner.handler.clone(),
            "Token close occurs under an amount == 0 branch. Review extension-specific close requirements; account identity, other guards and extension policy are not resolved, so a safe close can be flagged.");
    }
}

#[cfg(test)]
mod tests {
    use crate::analyze;
    fn hits(source: &str) -> Vec<crate::Hit> {
        analyze("src/lib.rs", source).unwrap().hits.into_iter()
            .filter(|hit| hit.rule_id == "token2022/amount-only-close").collect()
    }
    #[test]
    fn zero_amount_branches_with_explicit_token_closes_are_reported() {
        for (condition, close) in [
            ("vault.amount == 0", "token_interface::close_account(ctx)"),
            ("(0x0u64) == (vault.amount)", "anchor_spl::token_2022::close_account(ctx)"),
            ("vault.amount == 0", "token::close_account(ctx)?"),
        ] {
            let source = format!("fn close() {{ if {condition} {{\n {close};\n }} }}");
            let found = hits(&source);
            assert_eq!(found.len(), 1, "{source}");
            assert_eq!(found[0].location.line, 2);
            assert_eq!(found[0].location.handler.as_deref(), Some("close"));
            assert_eq!(found[0].class, "token2022");
        }
    }
    #[test]
    fn other_guards_and_unrelated_or_deferred_calls_are_excluded() {
        for source in [
            "fn f() { if can_close_with_extensions(&vault) { token_interface::close_account(ctx); } }",
            "fn f() { if vault.amount == 0 && extensions_ok { token_interface::close_account(ctx); } }",
            "fn f() { if vault.amount != 0 { token_interface::close_account(ctx); } }",
            "fn f() { if vault.amount == 0 { other::close_account(ctx); } }",
            "fn f() { if vault.amount == 0 { log(); } else { token_interface::close_account(ctx); } }",
            "fn f() { if vault.amount == 0 { fn nested() { token_interface::close_account(ctx); } } }",
            "fn f() { if vault.amount == 0 { let deferred = || token_interface::close_account(ctx); } }",
            "fn f() { if vault.amount == 0 { let deferred = async { token_interface::close_account(ctx); }; } }",
            "fn f() { if vault.amount == 0 { quote!(token_interface::close_account(ctx)); } }",
            "fn f() { if vault.amount == 0 { let text = \"token_interface::close_account(ctx)\"; } }",
        ] { assert!(hits(source).is_empty(), "{source}"); }
    }
    #[test]
    fn separate_calls_on_one_line_are_not_collapsed() {
        let source = "mod a { fn close() { if v.amount == 0 { token_interface::close_account(ctx); token_interface::close_account(other); } } } mod b { fn close() { if v.amount == 0 { token_interface::close_account(ctx); } } }";
        assert_eq!(hits(source).len(), 3);
    }
    #[test]
    fn nested_branches_are_deduplicated_and_handlers_remain_scoped() {
        let source = "fn outer() { if vault.amount == 0 { if other.amount == 0 { token_interface::close_account(ctx); } fn inner() { if vault.amount == 0 { token_interface::close_account(ctx); } } } }";
        let found = hits(source);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].location.handler.as_deref(), Some("outer"));
        assert_eq!(found[1].location.handler.as_deref(), Some("inner"));
    }
}
