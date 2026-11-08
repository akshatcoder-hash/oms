use syn::{spanned::Spanned, visit::Visit, Expr, ItemFn, Stmt};
use crate::{unparen, Scanner};

fn buffer(expr: &Expr) -> Option<String> {
    match unparen(expr) {
        Expr::Path(path) if path.qself.is_none() => path.path.get_ident().map(ToString::to_string),
        Expr::Reference(reference) if reference.mutability.is_none() => buffer(&reference.expr),
        _ => None,
    }
}

fn deserializer(call: &syn::ExprCall) -> bool {
    matches!(unparen(&call.func), Expr::Path(path) if path.path.segments.last().is_some_and(|part|
            matches!(part.ident.to_string().as_str(), "try_from_slice" | "try_from_slice_unchecked"))
        && call.args.len() == 1)
}

fn type_name(path: &syn::Path) -> Option<String> {
    if path.segments.is_empty() || path.segments.iter().any(|part| !matches!(part.arguments, syn::PathArguments::None)) { return None; }
    Some(format!("{}{}", if path.leading_colon.is_some() { "::" } else { "" },
        path.segments.iter().map(|part| part.ident.to_string()).collect::<Vec<_>>().join("::")))
}

fn parsed_type(call: &syn::ExprCall) -> Option<String> {
    let Expr::Path(path) = unparen(&call.func) else { return None; };
    if path.qself.is_some() { return None; }
    let last = path.path.segments.last()?;
    if last.ident == "try_from_slice_unchecked" {
        let syn::PathArguments::AngleBracketed(args) = &last.arguments else { return None; };
        if args.args.len() != 1 { return None; }
        let syn::GenericArgument::Type(syn::Type::Path(ty)) = args.args.first()? else { return None; };
        if ty.qself.is_some() { return None; }
        type_name(&ty.path)
    } else {
        let mut owner = path.path.clone();
        owner.segments.pop();
        if !matches!(last.arguments, syn::PathArguments::None) { return None; }
        type_name(&owner)
    }
}

// Recognize only a local rejection of a nonempty prefix unequal to a named
// DISCRIMINATOR. This is syntax, not proof of the constant's identity or trust.
fn guard(stmt: &Stmt) -> Option<(String, String)> {
    let Stmt::Expr(Expr::If(branch), _) = stmt else { return None; };
    if !branch.attrs.is_empty() || branch.else_branch.is_some() || branch.then_branch.stmts.len() != 1 { return None; }
    let Stmt::Expr(Expr::Return(ret), _) = &branch.then_branch.stmts[0] else { return None; };
    if !ret.attrs.is_empty() { return None; }
    let Expr::Call(error) = unparen(ret.expr.as_ref()?) else { return None; };
    if !matches!(unparen(&error.func), Expr::Path(path) if path.path.is_ident("Err")) || error.args.len() != 1 { return None; }
    let Expr::Binary(test) = unparen(&branch.cond) else { return None; };
    if !matches!(test.op, syn::BinOp::Ne(_)) { return None; }
    fn prefix(expr: &Expr) -> Option<String> {
        let expr = match unparen(expr) {
            Expr::Reference(reference) if reference.mutability.is_none() => unparen(&reference.expr),
            other => other,
        };
        let Expr::Index(index) = expr else { return None; };
        let Expr::Range(range) = unparen(&index.index) else { return None; };
        if !matches!(range.limits, syn::RangeLimits::HalfOpen(_)) { return None; }
        fn integer(expr: &Expr) -> Option<u64> {
            match unparen(expr) {
                Expr::Lit(literal) => match &literal.lit { syn::Lit::Int(n) => n.base10_parse().ok(), _ => None },
                _ => None,
            }
        }
        if range.start.as_ref().is_some_and(|start| integer(start) != Some(0)) || integer(range.end.as_ref()?)? == 0 { return None; }
        buffer(&index.expr)
    }
    for (value, expected) in [(&test.left, &test.right), (&test.right, &test.left)] {
        let Expr::Path(path) = unparen(expected) else { continue; };
        if path.qself.is_none() && path.path.segments.last().is_some_and(|part| part.ident == "DISCRIMINATOR") {
            let mut owner = path.path.clone();
            owner.segments.pop();
            if let (Some(name), Some(owner)) = (prefix(value), type_name(&owner)) { return Some((name, owner)); }
        }
    }
    None
}

fn direct_call(stmt: &Stmt) -> Option<&syn::ExprCall> {
    let mut expr = match stmt {
        Stmt::Expr(expr, _) => expr,
        Stmt::Local(local) => {
            let init = local.init.as_ref()?;
            if init.diverge.is_some() { return None; }
            &init.expr
        },
        _ => return None,
    };
    if let Expr::Try(try_expr) = unparen(expr) { expr = &try_expr.expr; }
    match unparen(expr) { Expr::Call(call) if deserializer(call) => Some(call), _ => None }
}

pub(crate) fn check(file: &syn::File, scanner: &mut Scanner<'_>) {
    Functions { scanner }.visit_file(file);
}

struct Functions<'a, 'b> { scanner: &'a mut Scanner<'b> }
impl<'ast> Visit<'ast> for Functions<'_, '_> {
    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        check_body(&item.sig.ident.to_string(), &item.block, self.scanner);
    }
    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        check_body(&item.sig.ident.to_string(), &item.block, self.scanner);
    }
    fn visit_trait_item_fn(&mut self, item: &'ast syn::TraitItemFn) {
        if let Some(body) = &item.default {
            check_body(&item.sig.ident.to_string(), body, self.scanner);
        }
    }
}

fn check_body(handler: &str, body: &syn::Block, scanner: &mut Scanner<'_>) {
    struct Reads<'a, 'b> { scanner: &'a mut Scanner<'b>, handler: String, protected: Option<(usize, usize)> }
    impl<'ast> Visit<'ast> for Reads<'_, '_> {
        // Nested items are visited in source order with independent guards.
        fn visit_item(&mut self, item: &'ast syn::Item) {
            Functions { scanner: self.scanner }.visit_item(item);
        }
        fn visit_block(&mut self, block: &'ast syn::Block) {
            let outer = self.protected.take();
            let mut previous: Option<(String, String)> = None;
            for stmt in &block.stmts {
                self.protected = direct_call(stmt).filter(|call|
                    previous.as_ref().is_some_and(|(name, owner)|
                        call.args.first().and_then(buffer).as_ref() == Some(name)
                            && parsed_type(call).as_ref() == Some(owner)))
                    .map(|call| { let start = call.span().start(); (start.line, start.column) });
                self.visit_stmt(stmt);
                previous = guard(stmt);
            }
            self.protected = outer;
        }
        fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
            let start = call.span().start();
            if deserializer(call) && self.protected != Some((start.line, start.column)) {
                self.scanner.hit("type-cosplay/unchecked-deserialization", "type-cosplay", start.line, Some(self.handler.clone()),
                    "Slice deserialization lacks a recognized immediately preceding discriminator rejection. Review account type validation; this syntax signal also includes non-account data, and aliases, imports, constant identity and general control flow are not resolved.");
            }
            syn::visit::visit_expr_call(self, call);
        }
    }
    Reads { scanner, handler: handler.to_string(), protected: None }.visit_block(body);
}
