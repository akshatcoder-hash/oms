pub mod inventory;
pub mod cve;
pub mod manifest;
mod duplicate;
mod mint;
mod token_close;
mod deserialization;
use serde::Serialize;
use syn::{ext::IdentExt, parse::Parser, spanned::Spanned, visit::Visit, ItemFn, ItemStruct, Token};

#[derive(Debug, Serialize)]
pub struct Location {
    pub file: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Hit {
    pub tool: &'static str,
    #[serde(rename = "ruleId")]
    pub rule_id: &'static str,
    pub class: &'static str,
    pub severity: &'static str,
    pub location: Location,
    pub message: &'static str,
}
#[derive(Debug, Serialize)]
pub struct Handler {
    pub name: String,
    pub file: String,
    pub line: usize,
}
#[derive(Debug, Serialize)]
pub struct Analysis {
    pub hits: Vec<Hit>,
    pub handlers: Vec<Handler>,
    // Consumers must never interpret unimplemented classes as clear.
    #[serde(rename = "implementedRules")]
    pub implemented_rules: Vec<&'static str>,
}

struct Scanner<'a> {
    path: &'a str,
    hits: Vec<Hit>,
    handlers: Vec<Handler>,
    handler: Option<String>,
    token_close_sites: std::collections::BTreeSet<(usize, usize)>,
}

fn account_flag(field: &syn::Field, flag: &str) -> bool {
    account_option(field, flag, false)
}

fn account_option(field: &syn::Field, option: &str, require_value: bool) -> bool {
    account_option_matching(field, option, |value| value.is_some() == require_value)
}

fn account_option_matching(field: &syn::Field, option: &str, matches: impl Fn(Option<&syn::Expr>) -> bool) -> bool {
    field.attrs.iter().filter(|attr| attr.path().is_ident("account")).any(|attr| {
        let syn::Meta::List(list) = &attr.meta else { return false; };
        let parser = |input: syn::parse::ParseStream| -> syn::Result<bool> {
            let mut found = false;
            while !input.is_empty() {
                let key = syn::Ident::parse_any(input)?;
                let mut qualified = false;
                while input.peek(Token![::]) {
                    input.parse::<Token![::]>()?;
                    syn::Ident::parse_any(input)?;
                    qualified = true;
                }
                let value = if input.peek(Token![=]) {
                    input.parse::<Token![=]>()?;
                    Some(input.parse::<syn::Expr>()?)
                } else { None };
                if input.peek(Token![@]) {
                    input.parse::<Token![@]>()?;
                    input.parse::<syn::Expr>()?;
                }
                if key == option && !qualified && matches(value.as_ref()) { found = true; }
                if !input.is_empty() { input.parse::<Token![,]>()?; }
            }
            Ok(found)
        };
        parser.parse2(list.tokens.clone()).unwrap_or(false)
    })
}
fn account_type(field: &syn::Field) -> Option<String> {
    let syn::Type::Path(path) = &field.ty else { return None; };
    path.path.segments.last().map(|segment| segment.ident.to_string())
}
impl Scanner<'_> {
    fn hit(&mut self, rule_id: &'static str, class: &'static str, line: usize, handler: Option<String>, message: &'static str) {
        self.hits.push(Hit { tool: "oms-sast", rule_id, class, severity: "high",
            location: Location { file: self.path.to_string(), line, handler }, message });
    }
}
impl<'ast> Visit<'ast> for Scanner<'_> {
    fn visit_expr_if(&mut self, expr: &'ast syn::ExprIf) {
        token_close::check(expr, self);
        syn::visit::visit_expr_if(self, expr);
    }
    fn visit_item_struct(&mut self, item: &'ast ItemStruct) {
        duplicate::check(item, self);
        mint::check(item, self);
        for field in &item.fields {
            let Some(name) = &field.ident else { continue; };
            for (flag, rule_id, class, message) in [
                ("init_if_needed", "revival-reinit/init-if-needed", "revival-reinit", "Conditional initialization requires a review of reinitialization guards."),
                ("dup", "duplicate-mutable/anchor-dup", "duplicate-mutable", "Explicit duplicate-account opt-in requires a review of account aliasing."),
            ] {
                if account_flag(field, flag) {
                    self.hit(rule_id, class, name.span().start().line, None, message);
                }
            }
            if account_option(field, "bump", true) {
                self.hit("pda-bump/explicit-constraint", "pda-bump", name.span().start().line, None,
                    "Explicit bump expression requires a review of its provenance and canonicality; stored validated bumps may be safe.");
            }
            if account_option_matching(field, "space", |value| value.is_some_and(legacy_token_size)) {
                self.hit("token2022/legacy-account-space", "token2022", name.span().start().line, None,
                    "Literal 165-byte account allocation assumes the legacy token-account size; review extension-aware sizing if this is a token account.");
            }
            let name_string = name.to_string();
            let authority_like = name_string.trim_start_matches("r#").split('_').any(|part| matches!(part, "authority" | "admin" | "owner" | "payer"));
            let unchecked = matches!(account_type(field).as_deref(), Some("AccountInfo" | "UncheckedAccount"));
            if authority_like && unchecked && !account_flag(field, "signer") {
                self.hit("missing-signer/anchor-field", "missing-signer", name.span().start().line, None,
                    "Authority-like unchecked account has no signer constraint; inspect any manual signer validation in its handler.");
            }
        }
        syn::visit::visit_item_struct(self, item);
    }
    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        if matches!(item.vis, syn::Visibility::Public(_)) {
            self.handlers.push(Handler { name: item.sig.ident.to_string(), file: self.path.to_string(), line: item.sig.ident.span().start().line });
        }
        unchecked_signer_parameters(&item.sig, &item.block, self);
        unchecked_owner_reads(&item.sig, &item.block, self);
        unchecked_cpi_programs(&item.sig, &item.block, self);
        let previous = self.handler.replace(item.sig.ident.to_string());
        syn::visit::visit_item_fn(self, item);
        self.handler = previous;
    }
    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        unchecked_signer_parameters(&item.sig, &item.block, self);
        unchecked_owner_reads(&item.sig, &item.block, self);
        unchecked_cpi_programs(&item.sig, &item.block, self);
        let previous = self.handler.replace(item.sig.ident.to_string());
        syn::visit::visit_impl_item_fn(self, item);
        self.handler = previous;
    }
    fn visit_trait_item_fn(&mut self, item: &'ast syn::TraitItemFn) {
        if let Some(body) = &item.default {
            unchecked_signer_parameters(&item.sig, body, self);
            unchecked_owner_reads(&item.sig, body, self);
            unchecked_cpi_programs(&item.sig, body, self);
        }
        let previous = self.handler.replace(item.sig.ident.to_string());
        syn::visit::visit_trait_item_fn(self, item);
        self.handler = previous;
    }
    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let syn::Expr::Path(function) = call.func.as_ref() {
            let parts: Vec<_> = function.path.segments.iter().map(|p| p.ident.to_string()).collect();
            if parts.last().is_some_and(|name| matches!(name.as_str(), "invoke_signed" | "invoke_signed_unchecked"))
                && call.args.len() == 3 && call.args.last().is_some_and(contains_seed_field) {
                self.hit("signer-seeds/field-derived-cpi", "signer-seeds", call.span().start().line, self.handler.clone(),
                    "Signed CPI seeds contain a field access. Review seed provenance and validation; syntax does not establish caller control, and validated fields may be safe.");
            }
            if function.qself.is_none() && parts.len() >= 2
                && parts[parts.len() - 2] == "CpiContext"
                && parts.last().is_some_and(|name| name == "new_with_signer")
                && call.args.len() == 3 && call.args.last().is_some_and(contains_seed_field) {
                self.hit("signer-seeds/anchor-cpi-context", "signer-seeds", call.span().start().line, self.handler.clone(),
                    "Anchor CPI context signer seeds contain a field access. Review seed provenance and validation; syntax does not establish caller control, and validated fields may be safe.");
            }
            if unchecked_token_transfer(&parts) {
                self.hit("token2022/unchecked-transfer", "token2022", call.span().start().line, self.handler.clone(),
                    "Unchecked token transfer requires a review of mint validation and Token-2022 extension handling; consider transfer_checked. A checked transfer alone does not prove extension safety.");
            }
            if parts.last().is_some_and(|name| name == "minimum_balance")
                && parts.len() >= 2 && parts[parts.len() - 2] == "Rent"
                && call.args.len() == 2 && call.args.last().is_some_and(legacy_token_size) {
                self.hit("token2022/legacy-rent-size", "token2022", call.span().start().line, self.handler.clone(), LEGACY_RENT_MESSAGE);
            }
            if parts.len() >= 2 && parts[parts.len() - 2] == "Pubkey"
                && parts.last().is_some_and(|p| p == "create_program_address") {
                self.hit("pda-bump/explicit-derivation", "pda-bump", call.span().start().line, self.handler.clone(),
                    "Explicit PDA derivation requires a review of canonical bump validation; syntax alone does not establish a bug.");
            }
            if parts.len() >= 2 && parts[parts.len() - 2] == "Sysvar"
                && parts.last().is_some_and(|p| p == "from_account_info")
                && call.args.len() == 1 {
                self.hit("unchecked-sysvar-id/account-reader", "unchecked-sysvar-id", call.span().start().line, self.handler.clone(),
                    "Sysvar account deserialization requires a review of account identity validation in the implementation or caller. This syntax signal does not establish missing validation.");
            }
            if parts.last().is_some_and(|p| p == "load_instruction_at") {
                self.hit("unchecked-sysvar-id/instruction-reader", "unchecked-sysvar-id", call.span().start().line, self.handler.clone(),
                    "Unchecked instruction-sysvar reader requires a review of the supplied account key; prefer the checked reader.");
            }
        }
        syn::visit::visit_expr_call(self, call);
    }
    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        if call.method == "with_signer" && call.args.len() == 1
            && call.args.first().is_some_and(contains_seed_field)
            && is_new_cpi_context(&call.receiver) {
            self.hit("signer-seeds/anchor-cpi-context", "signer-seeds", call.span().start().line, self.handler.clone(),
                "Anchor CPI context signer seeds contain a field access. Review seed provenance and validation; syntax does not establish caller control, and validated fields may be safe.");
        }
        if call.method == "minimum_balance" && call.args.len() == 1
            && call.args.first().is_some_and(legacy_token_size) {
            self.hit("token2022/legacy-rent-size", "token2022", call.span().start().line, self.handler.clone(), LEGACY_RENT_MESSAGE);
        }
        syn::visit::visit_expr_method_call(self, call);
    }
    fn visit_expr_field(&mut self, expr: &'ast syn::ExprField) {
        if matches!(&expr.member, syn::Member::Named(name) if name == "remaining_accounts") {
            self.hit("unchecked-sysvar-id/remaining-accounts", "unchecked-sysvar-id", expr.span().start().line, self.handler.clone(),
                "Remaining accounts bypass declared account constraints. Review owner, type, key and signer validation before use; this syntax signal does not establish missing validation.");
        }
        syn::visit::visit_expr_field(self, expr);
    }
    fn visit_expr_binary(&mut self, expr: &'ast syn::ExprBinary) {
        if matches!(expr.op, syn::BinOp::Add(_) | syn::BinOp::Sub(_) | syn::BinOp::Mul(_)
            | syn::BinOp::AddAssign(_) | syn::BinOp::SubAssign(_) | syn::BinOp::MulAssign(_))
            && (is_field(&expr.left) || is_field(&expr.right)) {
            self.hit("arithmetic/field-operation", "arithmetic", expr.span().start().line, self.handler.clone(),
                "Arithmetic on a field requires a review of overflow bounds and checked operations; operand types are not resolved.");
        }
        syn::visit::visit_expr_binary(self, expr);
    }
    fn visit_expr_assign(&mut self, expr: &'ast syn::ExprAssign) {
        let zero = matches!(unparen(&expr.right), syn::Expr::Lit(lit)
            if matches!(&lit.lit, syn::Lit::Int(value) if matches!(value.base10_parse::<u64>(), Ok(0))));
        if zero && borrowed_lamports(&expr.left) {
            self.hit("revival-reinit/manual-lamport-zero", "revival-reinit", expr.span().start().line, self.handler.clone(),
                "Manual lamport zeroing requires a review of account reassignment and revival protection. Syntax does not prove that closure is unsafe; prefer a framework close helper where applicable.");
        }
        syn::visit::visit_expr_assign(self, expr);
    }
    fn visit_expr_cast(&mut self, expr: &'ast syn::ExprCast) {
        if integer_type(&expr.ty) {
            self.hit("arithmetic/integer-cast", "arithmetic", expr.span().start().line, self.handler.clone(),
                "Integer cast may truncate or change signedness; review source type and bounds or use a checked conversion. Syntax alone does not prove narrowing.");
        }
        syn::visit::visit_expr_cast(self, expr);
    }
}

fn borrowed_lamports(expr: &syn::Expr) -> bool {
    let mut inner = unparen(expr);
    // AccountInfo's mutable lamport borrow is a RefMut<&mut u64>.
    for _ in 0..2 {
        let syn::Expr::Unary(unary) = inner else { return false; };
        if !matches!(unary.op, syn::UnOp::Deref(_)) { return false; }
        inner = unparen(&unary.expr);
    }
    if let syn::Expr::Try(attempt) = inner { inner = unparen(&attempt.expr); }
    matches!(inner, syn::Expr::MethodCall(call)
        if matches!(call.method.to_string().as_str(), "borrow_mut_lamports" | "try_borrow_mut_lamports")
            && call.args.is_empty() && call.turbofish.is_none())
}

fn unchecked_type(ty: &syn::Type) -> bool {
    match ty {
        syn::Type::Paren(paren) => unchecked_type(&paren.elem),
        syn::Type::Group(group) => unchecked_type(&group.elem),
        syn::Type::Reference(reference) => unchecked_type(&reference.elem),
        syn::Type::Path(path) if path.qself.is_none() => path.path.segments.last()
            .is_some_and(|part| matches!(part.ident.to_string().as_str(), "AccountInfo" | "UncheckedAccount")),
        _ => false,
    }
}

// Only initial rejecting guards are recognized. A mere is_signer reference,
// a nested check, or a late guard must not make an authority look validated.
fn unchecked_signer_parameters(sig: &syn::Signature, body: &syn::Block, scanner: &mut Scanner<'_>) {
    fn guard(stmt: &syn::Stmt) -> Option<String> {
        let syn::Stmt::Expr(syn::Expr::If(branch), _) = stmt else { return None; };
        if !branch.attrs.is_empty() || branch.else_branch.is_some() || branch.then_branch.stmts.len() != 1 { return None; }
        let syn::Stmt::Expr(syn::Expr::Return(ret), _) = &branch.then_branch.stmts[0] else { return None; };
        if !ret.attrs.is_empty() { return None; }
        let syn::Expr::Call(error) = unparen(ret.expr.as_ref()?) else { return None; };
        if !named_expr(&error.func, "Err") || error.args.len() != 1 { return None; }
        let syn::Expr::Unary(negative) = unparen(&branch.cond) else { return None; };
        if !matches!(negative.op, syn::UnOp::Not(_)) { return None; }
        let receiver = match unparen(&negative.expr) {
            syn::Expr::Field(field) if matches!(&field.member, syn::Member::Named(name) if name == "is_signer") => &field.base,
            syn::Expr::MethodCall(call) if call.method == "is_signer" && call.args.is_empty()
                && call.turbofish.is_none() => &call.receiver,
            _ => return None,
        };
        let syn::Expr::Path(path) = unparen(receiver) else { return None; };
        if path.qself.is_some() { return None; }
        path.path.get_ident().map(ToString::to_string)
    }
    let guarded: Vec<_> = body.stmts.iter()
        .filter(|stmt| !matches!(stmt, syn::Stmt::Item(_)))
        .map_while(guard).collect();
    for arg in &sig.inputs {
        let syn::FnArg::Typed(arg) = arg else { continue; };
        let syn::Pat::Ident(name) = arg.pat.as_ref() else { continue; };
        let name_string = name.ident.to_string();
        if name.subpat.is_none() && unchecked_type(&arg.ty)
            && name_string.trim_start_matches("r#").split('_').any(|part| matches!(part, "authority" | "admin" | "owner" | "payer"))
            && !guarded.contains(&name_string) {
            scanner.hit("missing-signer/unchecked-parameter", "missing-signer", name.ident.span().start().line, Some(sig.ident.to_string()),
                "Authority-like unchecked-account parameter lacks a recognized entry signer rejection. Review signer requirements; names, types and general control flow do not establish authorization, and permissionless handlers may be safe.");
        }
    }
}

// Deliberately local: direct parameter reads and an immediately preceding,
// unconditional rejection of a mismatched owner. This is not type/dataflow proof.
fn unchecked_owner_reads(sig: &syn::Signature, body: &syn::Block, scanner: &mut Scanner<'_>) {
    fn rejecting_guard(stmt: &syn::Stmt, names: &[String]) -> Option<String> {
        let syn::Stmt::Expr(syn::Expr::If(branch), _) = stmt else { return None; };
        if !branch.attrs.is_empty() || branch.else_branch.is_some() || branch.then_branch.stmts.len() != 1 { return None; }
        let syn::Stmt::Expr(syn::Expr::Return(ret), _) = &branch.then_branch.stmts[0] else { return None; };
        if !ret.attrs.is_empty() { return None; }
        let Some(value) = &ret.expr else { return None; };
        let syn::Expr::Call(call) = unparen(value) else { return None; };
        if !named_expr(&call.func, "Err") || call.args.len() != 1 { return None; }
        // Only a named expected owner is recognized. Arbitrary expressions can
        // contain side effects or derive the expected value from this account.
        fn expected_owner(expr: &syn::Expr) -> bool {
            match unparen(expr) {
                syn::Expr::Path(path) => path.qself.is_none() && path.path.get_ident().is_some(),
                syn::Expr::Reference(reference) if reference.mutability.is_none() => expected_owner(&reference.expr),
                _ => false,
            }
        }
        fn owner_of(expr: &syn::Expr, name: &str) -> bool {
            match unparen(expr) {
                syn::Expr::Field(field) => named_expr(&field.base, name)
                    && matches!(&field.member, syn::Member::Named(member) if member == "owner"),
                syn::Expr::MethodCall(call) => named_expr(&call.receiver, name)
                    && call.method == "owner" && call.args.is_empty() && call.turbofish.is_none(),
                _ => false,
            }
        }
        names.iter().find(|name| match unparen(&branch.cond) {
            syn::Expr::Binary(binary) if matches!(binary.op, syn::BinOp::Ne(_)) =>
                [(&binary.left, &binary.right), (&binary.right, &binary.left)].iter()
                    .any(|(expr, expected)| owner_of(expr, name) && expected_owner(expected)),
            syn::Expr::Unary(unary) if matches!(unary.op, syn::UnOp::Not(_)) =>
                matches!(unparen(&unary.expr), syn::Expr::MethodCall(call)
                    if named_expr(&call.receiver, name) && call.method == "is_owned_by"
                        && call.turbofish.is_none() && call.args.len() == 1
                        && call.args.first().is_some_and(expected_owner)),
            _ => false,
        }).cloned()
    }
    fn direct_read_statement(stmt: &syn::Stmt) -> bool {
        fn direct(expr: &syn::Expr) -> bool {
            match unparen(expr) {
                syn::Expr::Try(expr) => direct(&expr.expr),
                syn::Expr::MethodCall(call) => call.args.is_empty() && call.turbofish.is_none()
                    && matches!(call.method.to_string().as_str(), "borrow_data" | "try_borrow_data" | "borrow_mut_data" | "try_borrow_mut_data")
                    && matches!(unparen(&call.receiver), syn::Expr::Path(path) if path.qself.is_none() && path.path.get_ident().is_some()),
                _ => false,
            }
        }
        match stmt {
            syn::Stmt::Expr(expr, _) => direct(expr),
            syn::Stmt::Local(local) => local.init.as_ref().is_some_and(|init|
                init.diverge.is_none() && direct(&init.expr)),
            _ => false,
        }
    }
    struct Reads<'a, 'b> {
        scanner: &'a mut Scanner<'b>,
        names: Vec<String>,
        guarded: Option<String>,
        handler: String,
    }
    impl<'ast> Visit<'ast> for Reads<'_, '_> {
        fn visit_item(&mut self, _: &'ast syn::Item) {}
        fn visit_block(&mut self, block: &'ast syn::Block) {
            let outer = self.guarded.take();
            for stmt in &block.stmts {
                if !matches!(stmt, syn::Stmt::Item(_)) && !direct_read_statement(stmt) { self.guarded = None; }
                self.visit_stmt(stmt);
                if !matches!(stmt, syn::Stmt::Item(_)) {
                    self.guarded = rejecting_guard(stmt, &self.names);
                }
            }
            self.guarded = outer;
        }
        fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
            if matches!(call.method.to_string().as_str(), "borrow_data" | "try_borrow_data" | "borrow_mut_data" | "try_borrow_mut_data")
                && call.args.is_empty() && self.names.iter().any(|name|
                    named_expr(&call.receiver, name) && self.guarded.as_ref() != Some(name)) {
                self.scanner.hit("missing-owner/unchecked-parameter-read", "missing-owner", call.span().start().line, Some(self.handler.clone()),
                    "Direct unchecked-account parameter data read lacks a recognized immediately preceding rejecting owner guard. Review owner validation; aliases, types and general control flow are not resolved.");
            }
            syn::visit::visit_expr_method_call(self, call);
        }
    }
    let names = sig.inputs.iter().filter_map(|arg| {
        let syn::FnArg::Typed(arg) = arg else { return None; };
        let syn::Pat::Ident(name) = arg.pat.as_ref() else { return None; };
        (name.subpat.is_none() && unchecked_type(&arg.ty)).then(|| name.ident.to_string())
    }).collect::<Vec<_>>();
    if names.is_empty() { return; }
    Reads { scanner, names, guarded: None, handler: sig.ident.to_string() }.visit_block(body);
}

// A syntactic signal, not a type or authorization proof. Do not infer that a
// parameter is safe merely because some other expression compares its key.
fn unchecked_cpi_programs(sig: &syn::Signature, body: &syn::Block, scanner: &mut Scanner<'_>) {
    fn parameter(expr: &syn::Expr) -> Option<&syn::Ident> {
        match unparen(expr) {
            syn::Expr::Path(path) if path.qself.is_none() => path.path.get_ident(),
            syn::Expr::Reference(reference) => parameter(&reference.expr),
            syn::Expr::MethodCall(call) if call.args.is_empty() && call.turbofish.is_none()
                && matches!(call.method.to_string().as_str(), "clone" | "to_account_info") => parameter(&call.receiver),
            _ => None,
        }
    }
    struct Calls<'a, 'b> { scanner: &'a mut Scanner<'b>, names: Vec<String>, handler: String }
    impl<'ast> Visit<'ast> for Calls<'_, '_> {
        fn visit_item(&mut self, _: &'ast syn::Item) {}
        fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
            if let syn::Expr::Path(function) = unparen(&call.func) {
                let segments = &function.path.segments;
                let context = segments.len() >= 2 && segments[segments.len() - 2].ident == "CpiContext";
                let constructor = segments.last().is_some_and(|part|
                    (part.ident == "new" && call.args.len() == 2)
                    || (part.ident == "new_with_signer" && call.args.len() == 3));
                if function.qself.is_none() && context && constructor
                    && call.args.first().and_then(parameter).is_some_and(|name| self.names.iter().any(|p| name == p)) {
                    self.scanner.hit("arbitrary-cpi/unchecked-parameter-context", "arbitrary-cpi", call.span().start().line, Some(self.handler.clone()),
                        "CPI context uses an unchecked-account parameter as its program. Review program-id validation; syntax does not resolve types, shadowing or manual guards.");
                }
            }
            syn::visit::visit_expr_call(self, call);
        }
    }
    let names = sig.inputs.iter().filter_map(|arg| {
        let syn::FnArg::Typed(arg) = arg else { return None; };
        let syn::Pat::Ident(name) = arg.pat.as_ref() else { return None; };
        (name.subpat.is_none() && unchecked_type(&arg.ty)).then(|| name.ident.to_string())
    }).collect::<Vec<_>>();
    if !names.is_empty() {
        Calls { scanner, names, handler: sig.ident.to_string() }.visit_block(body);
    }
}

fn is_new_cpi_context(expr: &syn::Expr) -> bool {
    let syn::Expr::Call(call) = unparen(expr) else { return false; };
    let syn::Expr::Path(function) = call.func.as_ref() else { return false; };
    let mut parts = function.path.segments.iter().rev();
    function.qself.is_none() && call.args.len() == 2
        && parts.next().is_some_and(|part| part.ident == "new")
        && parts.next().is_some_and(|part| part.ident == "CpiContext")
}

// Inspect only the seed expression, never nested item declarations or macro tokens.
fn contains_seed_field(expr: &syn::Expr) -> bool {
    struct Fields(bool);
    impl<'ast> Visit<'ast> for Fields {
        fn visit_expr_field(&mut self, _: &'ast syn::ExprField) { self.0 = true; }
        fn visit_item(&mut self, _: &'ast syn::Item) {}
    }
    let mut fields = Fields(false);
    fields.visit_expr(expr);
    fields.0
}

const LEGACY_RENT_MESSAGE: &str = "Rent calculation uses the literal legacy token-account size of 165 bytes; review extension-aware sizing if this is a token account. Receiver types are not resolved.";

fn unchecked_token_transfer(parts: &[String]) -> bool {
    if parts.last().is_none_or(|name| name != "transfer") { return false; }
    match parts {
        [.., module, _] if matches!(module.as_str(), "token" | "token_2022" | "token_interface") => true,
        [.., crate_name, module, _] => module == "instruction"
            && matches!(crate_name.as_str(), "spl_token" | "spl_token_2022"),
        _ => false,
    }
}

fn legacy_token_size(expr: &syn::Expr) -> bool {
    match expr {
        syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Int(value), .. }) => matches!(value.base10_parse::<u64>(), Ok(165)),
        syn::Expr::Paren(inner) => legacy_token_size(&inner.expr),
        syn::Expr::Group(inner) => legacy_token_size(&inner.expr),
        _ => false,
    }
}

fn integer_type(ty: &syn::Type) -> bool {
    match ty {
        syn::Type::Paren(inner) => integer_type(&inner.elem),
        syn::Type::Group(inner) => integer_type(&inner.elem),
        syn::Type::Path(path) if path.qself.is_none() => {
            let names: Vec<_> = path.path.segments.iter().map(|segment| segment.ident.to_string()).collect();
            let primitive_path = names.len() == 1 || (names.len() == 3
                && matches!(names[0].as_str(), "core" | "std") && names[1] == "primitive");
            primitive_path && path.path.segments.iter().all(|segment| matches!(segment.arguments, syn::PathArguments::None))
                && names.last().is_some_and(|name| matches!(name.as_str(),
                    "u8" | "u16" | "u32" | "u64" | "u128" | "usize" |
                    "i8" | "i16" | "i32" | "i64" | "i128" | "isize"))
        }
        _ => false,
    }
}

fn is_field(expr: &syn::Expr) -> bool {
    match expr {
        syn::Expr::Field(_) => true,
        syn::Expr::Paren(inner) => is_field(&inner.expr),
        syn::Expr::Group(inner) => is_field(&inner.expr),
        _ => false,
    }
}

// This rule resolves only state structs declared in the same lexical module.
// It does not infer imported types or prove authorization in handler code.
fn authority_name(name: &str) -> bool {
    name.trim_start_matches("r#").split('_').any(|part| matches!(part, "authority" | "admin" | "owner"))
}
fn unparen(expr: &syn::Expr) -> &syn::Expr {
    match expr {
        syn::Expr::Paren(inner) => unparen(&inner.expr),
        syn::Expr::Group(inner) => unparen(&inner.expr),
        _ => expr,
    }
}
fn named_expr(expr: &syn::Expr, name: &str) -> bool {
    matches!(unparen(expr), syn::Expr::Path(path) if path.qself.is_none() && path.path.is_ident(name))
}
fn authority_equality(expr: &syn::Expr, account: &str, authority: &str, signers: &[String]) -> bool {
    let syn::Expr::Binary(binary) = unparen(expr) else { return false; };
    if matches!(binary.op, syn::BinOp::And(_)) {
        return authority_equality(&binary.left, account, authority, signers)
            || authority_equality(&binary.right, account, authority, signers);
    }
    if !matches!(binary.op, syn::BinOp::Eq(_)) { return false; }
    let state_field = |expr: &syn::Expr| matches!(unparen(expr), syn::Expr::Field(field)
        if named_expr(&field.base, account) && matches!(&field.member, syn::Member::Named(name) if name == authority));
    let signer_key = |expr: &syn::Expr| matches!(unparen(expr), syn::Expr::MethodCall(call)
        if call.method == "key" && call.args.is_empty() && call.turbofish.is_none()
            && signers.iter().any(|name| named_expr(&call.receiver, name)));
    (state_field(&binary.left) && signer_key(&binary.right))
        || (state_field(&binary.right) && signer_key(&binary.left))
}
fn authority_constraints(items: &[syn::Item], scanner: &mut Scanner<'_>) {
    for item in items {
        if let syn::Item::Mod(module) = item {
            if let Some((_, children)) = &module.content { authority_constraints(children, scanner); }
        }
        let syn::Item::Struct(accounts) = item else { continue; };
        let signers: Vec<String> = accounts.fields.iter().filter(|field| account_type(field).as_deref() == Some("Signer")
            || account_flag(field, "signer")).filter_map(|field| field.ident.as_ref().map(ToString::to_string)).collect();
        if signers.is_empty() { continue; }
        for field in &accounts.fields {
            let Some(account) = &field.ident else { continue; };
            let syn::Type::Path(path) = &field.ty else { continue; };
            let Some(segment) = path.path.segments.last() else { continue; };
            if segment.ident != "Account" { continue; }
            let syn::PathArguments::AngleBracketed(args) = &segment.arguments else { continue; };
            let state_name = args.args.iter().find_map(|arg| match arg {
                syn::GenericArgument::Type(syn::Type::Path(ty)) if ty.qself.is_none() => ty.path.get_ident(),
                _ => None,
            });
            let Some(state_name) = state_name else { continue; };
            let states: Vec<_> = items.iter().filter_map(|item| match item {
                syn::Item::Struct(state) if state.ident == *state_name => Some(state),
                _ => None,
            }).collect();
            // Multiple cfg-dependent declarations cannot be resolved syntactically.
            if states.len() != 1 { continue; }
            let unlinked = states[0].fields.iter().any(|member| {
                let Some(name) = &member.ident else { return false; };
                let name = name.to_string();
                if !authority_name(&name) || account_type(member).as_deref() != Some("Pubkey") { return false; }
                let has_one = account_option_matching(field, "has_one", |value| value.is_some_and(|expr|
                    named_expr(expr, &name) && signers.contains(&name)));
                let constraint = accounts.fields.iter().any(|candidate|
                    account_option_matching(candidate, "constraint", |value| value.is_some_and(|expr|
                        authority_equality(expr, &account.to_string(), &name, &signers))));
                !has_one && !constraint
            });
            if unlinked {
                scanner.hit("missing-constraint/account-authority", "missing-constraint", account.span().start().line, None,
                    "An authority-like Pubkey in this account state lacks a recognized has_one or equality link to a signer in the account struct. Review manual authorization in the handler.");
            }
        }
    }
}

// Literal values only: no evaluation of user constants, macros or expressions.
fn literal_discriminator(item: &ItemStruct) -> Option<Vec<u8>> {
    let mut values = Vec::new();
    for attr in item.attrs.iter().filter(|attr| attr.path().is_ident("account")) {
        let args = attr.parse_args_with(syn::punctuated::Punctuated::<syn::Meta, Token![,]>::parse_terminated).ok()?;
        for arg in args {
            let syn::Meta::NameValue(value) = arg else { continue; };
            if !value.path.is_ident("discriminator") { continue; }
            let syn::Expr::Array(array) = value.value else { return None; };
            let bytes: Option<Vec<u8>> = array.elems.iter().map(|expr| {
                let syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Int(value), .. }) = expr else { return None; };
                if !matches!(value.suffix(), "" | "u8") { return None; }
                value.base10_parse::<u8>().ok()
            }).collect();
            values.push(bytes?);
        }
    }
    if values.len() == 1 { values.pop() } else { None }
}

fn discriminator_collisions(items: &[syn::Item], scanner: &mut Scanner<'_>) {
    let accounts: Vec<_> = items.iter().filter_map(|item| match item {
        syn::Item::Struct(account) => literal_discriminator(account).map(|bytes| (account, bytes)),
        _ => None,
    }).collect();
    for (index, (account, bytes)) in accounts.iter().enumerate() {
        if accounts.iter().enumerate().any(|(other, (_, candidate))| other != index
            && (bytes.starts_with(candidate) || candidate.starts_with(bytes))) {
            scanner.hit("type-cosplay/literal-discriminator-prefix", "type-cosplay", account.ident.span().start().line, None,
                "Custom literal account discriminators overlap by prefix in this module. Review type separation and deserialization checks; syntax alone does not establish exploitability.");
        }
    }
    for item in items {
        if let syn::Item::Mod(module) = item {
            if let Some((_, children)) = &module.content { discriminator_collisions(children, scanner); }
        }
    }
}

/// Parse syntax only. Never invoke Cargo, rustc, a build script or a proc macro.
pub fn analyze(path: &str, source: &str) -> Result<Analysis, syn::Error> {
    let tree = syn::parse_file(source)?;
    let mut scanner = Scanner { path, hits: vec![], handlers: vec![], handler: None, token_close_sites: Default::default() };
    scanner.visit_file(&tree);
    deserialization::check(&tree, &mut scanner);
    authority_constraints(&tree.items, &mut scanner);
    discriminator_collisions(&tree.items, &mut scanner);
    Ok(Analysis { hits: scanner.hits, handlers: scanner.handlers, implemented_rules: vec!["missing-signer/anchor-field", "revival-reinit/init-if-needed", "duplicate-mutable/anchor-dup", "pda-bump/explicit-derivation", "unchecked-sysvar-id/instruction-reader", "arithmetic/field-operation", "pda-bump/explicit-constraint", "arithmetic/integer-cast", "token2022/unchecked-transfer", "token2022/legacy-rent-size", "token2022/legacy-account-space", "missing-constraint/account-authority", "type-cosplay/literal-discriminator-prefix", "signer-seeds/field-derived-cpi", "missing-owner/unchecked-parameter-read", "signer-seeds/anchor-cpi-context", "arbitrary-cpi/unchecked-parameter-context", "missing-signer/unchecked-parameter", "unchecked-sysvar-id/account-reader", "unchecked-sysvar-id/remaining-accounts", "revival-reinit/manual-lamport-zero", "duplicate-mutable/account-loader", "token2022/interface-mint", "token2022/amount-only-close", "type-cosplay/unchecked-deserialization"] })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchecked_authority_requires_signer_constraint() {
        for source in [
            "struct Withdraw<'info> { authority: AccountInfo<'info> }",
            "struct Withdraw<'info> { vault_admin: anchor_lang::prelude::UncheckedAccount<'info> }",
        ] {
            let result = analyze("src/lib.rs", source).unwrap();
            assert_eq!(result.hits.len(), 1);
            assert_eq!(result.hits[0].class, "missing-signer");
            assert_eq!(result.hits[0].location.line, 1);
        }
    }
    #[test]
    fn typed_and_explicit_signers_are_not_flagged() {
        for source in [
            "struct Withdraw<'info> { authority: Signer<'info> }",
            "struct Withdraw<'info> { #[account(signer @ ErrorCode::Unauthorized)] authority: AccountInfo<'info> }",
            "struct Withdraw<'info> { #[account(mut, signer, seeds = [b\"x\", user.key().as_ref()], bump)] authority: AccountInfo<'info> }",
        ] { assert!(analyze("src/lib.rs", source).unwrap().hits.is_empty()); }
    }
    #[test]
    fn comments_and_names_do_not_invent_constraints() {
        let source = "// #[account(signer)]\nstruct Withdraw<'info> {\n #[account(has_one = signer)]\n authority: UncheckedAccount<'info>\n}";
        let result = analyze("src/lib.rs", source).unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].location.line, 4);
    }
    #[test]
    fn commas_inside_expressions_do_not_create_signer_constraints() {
        for constraint in ["allowed::<u8, signer, u64>()", "apply(|a, signer, b| a == b)"] {
            let source = format!("struct Withdraw<'info> {{ #[account(constraint = {constraint})] authority: AccountInfo<'info> }}");
            assert_eq!(analyze("src/lib.rs", &source).unwrap().hits.len(), 1);
        }
    }
    #[test]
    fn syntax_errors_fail_instead_of_returning_clean() {
        assert!(analyze("src/lib.rs", "struct {").is_err());
    }
    #[test]
    fn explicit_risky_account_flags_are_reported() {
        for (flag, class) in [("init_if_needed", "revival-reinit"), ("dup", "duplicate-mutable")] {
            for attrs in [flag.to_string(), format!("mut, {flag}, payer = user, space = 8")] {
                let source = format!("struct Accounts<'info> {{\n #[account({attrs})]\n vault: Account<'info, Vault>\n }}");
                let result = analyze("src/lib.rs", &source).unwrap();
                assert_eq!(result.hits.len(), 1);
                assert_eq!(result.hits[0].class, class);
                assert_eq!(result.hits[0].location.line, 3);
            }
        }
    }
    #[test]
    fn account_flag_names_in_values_comments_or_namespaces_are_not_flags() {
        for flag in ["init_if_needed", "dup"] {
            for attrs in ["init".to_string(), "mut".to_string(), format!("constraint = {flag}"),
                format!("other::{flag}"), format!("constraint = check::<u8, {flag}>()"),
                format!("constraint = apply(|a, {flag}| a)"), format!("seeds = [b\"{flag}\"]")]
            {
                let source = format!("// #[account({flag})]\nstruct Accounts<'info> {{ #[account({attrs})] vault: Account<'info, Vault> }}");
                assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{source}");
            }
        }
    }
    #[test]
    fn explicit_pda_derivation_is_a_signal_not_a_canonicality_proof() {
        for expression in ["Pubkey::create_program_address(seeds, id)",
            "solana_program::pubkey::Pubkey::create_program_address(&[seed, bump], id)"] {
            assert_expression_hit(expression, "pda-bump");
        }
        for expression in ["Pubkey::find_program_address(seeds, id)",
            "Pubkey::try_find_program_address(seeds, id)", "Other::create_program_address(seeds, id)"] {
            assert_expression_clear(expression);
        }
    }
    #[test]
    fn explicit_bump_values_are_distinguished_from_canonical_constraints() {
        for attrs in ["seeds = [b\"vault\"], bump = instruction_bump",
            "bump = args.bump @ Error::InvalidBump", "bump = validated::<u8, u16>()"] {
            let source = format!("struct Accounts<'info> {{\n #[account({attrs})]\n vault: Account<'info, Vault>\n}}");
            let result = analyze("src/lib.rs", &source).unwrap();
            assert_eq!(result.hits.len(), 1, "{source}");
            assert_eq!(result.hits[0].class, "pda-bump");
            assert_eq!(result.hits[0].location.line, 3);
        }
        for attrs in ["seeds = [b\"vault\"], bump", "bump @ Error::InvalidBump",
            "other::bump = args.bump", "constraint = check::<u8, bump>()",
            "constraint = apply(|a, bump| a)", "seeds = [b\"bump = arg\"]"] {
            let source = format!("// #[account(bump = arg)]\nstruct Accounts<'info> {{ #[account({attrs})] vault: Account<'info, Vault> }}");
            assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{source}");
        }
    }
    #[test]
    fn integer_casts_are_potential_loss_signals_not_type_inference() {
        for expression in ["amount as u8", "vault.amount as u32", "signed as u64",
            "amount as core::primitive::u16", "amount as ::std::primitive::i64", "amount as (usize)"] {
            assert_expression_hit(expression, "arithmetic");
        }
        for expression in ["u8::try_from(amount)", "amount.try_into()", "u64::from(small)",
            "amount as f64", "pointer as *const u8", "value as custom::u8", "value as Amount"] {
            assert_expression_clear(expression);
        }
        assert_expression_clear("\"amount as u8\"");
        assert_expression_clear("quote!(amount as u8)");
    }
    #[test]
    fn anchor_cpi_context_field_seeds_require_provenance_review() {
        for expression in [
            "CpiContext::new_with_signer(program, accounts, args.seeds)",
            "anchor_lang::context::CpiContext::new_with_signer(program, accounts, &[&[state.seed.as_ref()]])",
            "CpiContext::<Transfer>::new_with_signer(program, accounts, &[&[&instruction.data[..]]])",
        ] {
            assert_expression_hit(expression, "signer-seeds");
        }
    }
    #[test]
    fn anchor_cpi_context_excludes_opaque_seeds_and_unrelated_syntax() {
        for expression in [
            "CpiContext::new_with_signer(program, accounts, &[&[b\"vault\", &[255]]])",
            "CpiContext::new_with_signer(state.program, args.accounts, validated_seeds)",
            "CpiContext::new(program, args.accounts)",
            "OtherContext::new_with_signer(program, accounts, args.seeds)",
            "custom.new_with_signer(program, accounts, args.seeds)",
            "CpiContext::new_with_signer(program, args.seeds)",
            "quote!(CpiContext::new_with_signer(program, accounts, args.seeds))",
            "\"CpiContext::new_with_signer(program, accounts, args.seeds)\"",
            "CpiContext::new_with_signer(program, accounts, { fn helper() { state.seed; } STATIC_SEEDS })",
        ] {
            assert_expression_clear(expression);
        }
    }
    #[test]
    fn unchecked_instruction_reader_is_distinguished_from_checked_reader() {
        for expression in ["load_instruction_at(0, data)",
            "solana_program::sysvar::instructions::load_instruction_at(index, data)"] {
            assert_expression_hit(expression, "unchecked-sysvar-id");
        }
        for expression in ["load_instruction_at_checked(0, account)",
            "solana_program::sysvar::instructions::load_instruction_at_checked(index, account)",
            "custom.load_instruction_at(index, data)"] {
            assert_expression_clear(expression);
        }
    }
    #[test]
    fn sysvar_account_reads_require_identity_review() {
        for expression in ["Sysvar::from_account_info(account)",
            "solana_program::sysvar::Sysvar::from_account_info(&account)",
            "<Clock as Sysvar>::from_account_info(account)",
            "<Clock as solana_program::sysvar::Sysvar>::from_account_info(account)"] {
            assert_expression_hit(expression, "unchecked-sysvar-id");
        }
    }
    #[test]
    fn sysvar_account_rule_excludes_other_traits_and_non_calls() {
        for expression in ["Clock::get()", "Rent::get()",
            "Other::from_account_info(account)", "<Clock as Other>::from_account_info(account)",
            "account.from_account_info(other)", "Sysvar::from_account_info()",
            "Sysvar::from_account_info(account, extra)",
            "quote!(Sysvar::from_account_info(account))",
            "\"Sysvar::from_account_info(account)\""] {
            assert_expression_clear(expression);
        }
        let source = "// Sysvar::from_account_info(account)\nfn process() {}";
        assert!(analyze("src/lib.rs", source).unwrap().hits.is_empty());
    }
    #[test]
    fn field_arithmetic_includes_compound_assignments() {
        for expression in ["vault.amount + deposit", "vault.amount - withdrawal", "rate * vault.amount",
            "vault.amount += deposit", "vault.amount -= withdrawal", "vault.amount *= rate", "(vault.amount) + deposit"] {
            assert_expression_hit(expression, "arithmetic");
        }
        for expression in ["vault.amount.checked_add(deposit)", "vault.amount.checked_sub(withdrawal)",
            "vault.amount.checked_mul(rate)", "vault.amount == deposit", "vault.amount & mask", "1 + 2"] {
            assert_expression_clear(expression);
        }
    }
    fn assert_expression_hit(expression: &str, class: &str) {
        let source = format!("pub fn process() {{\n let _ = {expression};\n}}");
        let result = analyze("src/lib.rs", &source).unwrap();
        assert_eq!(result.hits.len(), 1, "{source}");
        assert_eq!(result.hits[0].class, class);
        assert_eq!(result.hits[0].location.line, 2);
        assert_eq!(result.hits[0].location.handler.as_deref(), Some("process"));
    }
    fn assert_expression_clear(expression: &str) {
        let source = format!("pub fn process() {{ let _ = {expression}; }}");
        assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{source}");
    }
    #[test]
    fn expression_patterns_in_comments_strings_and_macros_are_not_executed_syntax() {
        let result = analyze("src/lib.rs", r#"
            // Pubkey::create_program_address(seeds, id); load_instruction_at(0, data); vault.amount += 1;
            fn process() {
                let _ = "Pubkey::create_program_address(seeds, id); load_instruction_at(0, data); vault.amount += 1;";
                quote!(Pubkey::create_program_address(seeds, id); load_instruction_at(0, data); vault.amount += 1;);
            }
        "#).unwrap();
        assert!(result.hits.is_empty());
    }
    #[test]
    fn nested_function_locations_restore_the_enclosing_handler() {
        let result = analyze("src/lib.rs", "fn outer() { fn inner() { let _ = a.b + 1; } let _ = a.b - 1; }").unwrap();
        assert_eq!(result.hits.len(), 2);
        assert_eq!(result.hits[0].location.handler.as_deref(), Some("inner"));
        assert_eq!(result.hits[1].location.handler.as_deref(), Some("outer"));
    }
    #[test]
    fn unchecked_token_transfer_paths_require_extension_review() {
        for expression in [
            "anchor_spl::token::transfer(ctx, amount)",
            "anchor_spl::token_2022::transfer(ctx, amount)",
            "token_interface::transfer(ctx, amount)",
            "spl_token::instruction::transfer(program, source, destination, authority, signers, amount)",
            "spl_token_2022::instruction::transfer(program, source, destination, authority, signers, amount)",
        ] { assert_expression_hit(expression, "token2022"); }
        for expression in [
            "anchor_spl::token::transfer_checked(ctx, amount, decimals)",
            "spl_token_2022::instruction::transfer_checked(program, source, mint, destination, authority, signers, amount, decimals)",
            "system_program::transfer(ctx, amount)", "wallet.transfer(destination, amount)",
            "custom::instruction::transfer(ctx, amount)", "transfer(ctx, amount)",
            "quote!(token::transfer(ctx, amount))", "\"token::transfer(ctx, amount)\"",
        ] { assert_expression_clear(expression); }
    }
    #[test]
    fn legacy_token_account_rent_size_requires_extension_review() {
        for expression in ["rent.minimum_balance(165)", "rent.minimum_balance(0xa5usize)",
            "Rent::minimum_balance(&rent, (165))"] {
            assert_expression_hit(expression, "token2022");
        }
        for expression in ["rent.minimum_balance(account_len)", "rent.minimum_balance(200)",
            "rent.minimum_balance(TokenAccount::LEN)", "rent.minimum_balance(165.0)",
            "custom(165)", "quote!(rent.minimum_balance(165))"] {
            assert_expression_clear(expression);
        }
    }
    #[test]
    fn legacy_token_account_space_is_an_explicit_size_signal() {
        for space in ["165", "(0xa5usize)"] {
            let source = format!("struct Accounts<'info> {{\n #[account(init, space = {space})]\n vault: AccountInfo<'info>\n}}");
            let result = analyze("src/lib.rs", &source).unwrap();
            assert_eq!(result.hits.len(), 1, "{source}");
            assert_eq!(result.hits[0].class, "token2022");
            assert_eq!(result.hits[0].location.line, 3);
        }
        for attrs in ["space = account_len", "space = 200", "space = TokenAccount::LEN",
            "constraint = space == 165", "other::space = 165", "seeds = [b\"space = 165\"]"] {
            let source = format!("// #[account(space = 165)]\nstruct Accounts<'info> {{ #[account({attrs})] vault: AccountInfo<'info> }}");
            assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{source}");
        }
    }
    #[test]
    fn account_authority_must_be_linked_to_a_signer() {
        for authority in ["authority", "admin"] {
            let source = format!("struct Vault {{ {authority}: Pubkey }}\nstruct Withdraw<'info> {{\n vault: Account<'info, Vault>,\n {authority}: Signer<'info>\n}}");
            let result = analyze("src/lib.rs", &source).unwrap();
            assert_eq!(result.hits.len(), 1, "{source}");
            assert_eq!(result.hits[0].class, "missing-constraint");
            assert_eq!(result.hits[0].location.line, 3);
        }
    }
    #[test]
    fn authority_links_are_specific_and_conjunctive() {
        for attrs in ["has_one = authority", "has_one = authority @ Error::Unauthorized",
            "constraint = vault.authority == authority.key()",
            "constraint = enabled && (authority.key() == vault.authority)"] {
            let source = format!("struct Vault {{ authority: Pubkey }} struct Withdraw<'info> {{ #[account({attrs})] vault: Account<'info, Vault>, authority: Signer<'info> }}");
            assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{source}");
        }
        for attrs in ["has_one = other", "constraint = enabled", "constraint = vault.authority != authority.key()",
            "constraint = vault.authority == authority.key() || enabled", "other::has_one = authority",
            "constraint = unrelated.authority == authority.key()"] {
            let source = format!("struct Vault {{ authority: Pubkey }} struct Withdraw<'info> {{ #[account({attrs})] vault: Account<'info, Vault>, authority: Signer<'info> }}");
            let result = analyze("src/lib.rs", &source).unwrap();
            assert_eq!(result.hits.len(), 1, "{source}");
            assert_eq!(result.hits[0].class, "missing-constraint");
        }
    }
    #[test]
    fn authority_equality_can_guard_from_another_account_field() {
        for fields in [
            "vault: Account<'info, Vault>, #[account(constraint = vault.authority == authority.key())] authority: Signer<'info>",
            "vault: Account<'info, Vault>, authority: Signer<'info>, #[account(constraint = vault.authority == authority.key())] other: AccountInfo<'info>",
        ] {
            let source = format!("struct Vault {{ authority: Pubkey }} struct Withdraw<'info> {{ {fields} }}");
            assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{source}");
        }
    }
    #[test]
    fn authority_state_types_do_not_leak_between_modules() {
        for source in [
            "struct Vault { amount: u64 } struct Read<'info> { vault: Account<'info, Vault>, user: Signer<'info> }",
            "struct Vault { authority: Pubkey } struct Read<'info> { vault: Account<'info, Vault> }",
            "mod a { struct Vault { authority: Pubkey } } mod b { struct Vault { amount: u64 } struct Read<'info> { vault: Account<'info, Vault>, user: Signer<'info> } }",
            "struct Vault { authority: Pubkey } mod b { struct Vault { amount: u64 } struct Read<'info> { vault: Account<'info, Vault>, user: Signer<'info> } }",
        ] { assert!(analyze("src/lib.rs", source).unwrap().hits.is_empty(), "{source}"); }
        let result = analyze("src/lib.rs", "mod a { struct Vault { authority: Pubkey } struct Withdraw<'info> { vault: Account<'info, Vault>, authority: Signer<'info> } }").unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].class, "missing-constraint");
    }
    #[test]
    fn inventory_walks_inline_modules() {
        let result = analyze("src/lib.rs", "mod program { pub fn withdraw() {} fn helper() {} }").unwrap();
        assert_eq!(result.handlers.len(), 1);
        assert_eq!(result.handlers[0].name, "withdraw");
    }
}

#[cfg(test)]
mod discriminator_tests {
    use super::*;

    #[test]
    fn literal_account_discriminator_prefixes_are_reported() {
        for (left, right) in [("[1]", "[1, 2]"), ("[0xaa, 3]", "[0xaa, 3]"), ("[]", "[4]")] {
            let source = format!("#[account(discriminator = {left})]\nstruct Short {{}}\n#[account(discriminator = {right})]\nstruct Long {{}}");
            let result = analyze("src/lib.rs", &source).unwrap();
            assert_eq!(result.hits.len(), 2, "{source}");
            for (hit, line) in result.hits.iter().zip([2, 4]) {
                assert_eq!(hit.class, "type-cosplay");
                assert_eq!(hit.location.line, line);
                assert!(hit.location.handler.is_none());
            }
        }
    }

    #[test]
    fn distinct_discriminators_and_unresolved_expressions_are_not_collisions() {
        for (left, right) in [("[1, 2]", "[1, 3]"), ("[1]", "[2, 1]"),
            ("TAG", "[1]"), ("[1 + 0]", "[1]"), ("[256]", "[0]"),
            ("[1u16]", "[1]"), ("[1; 2]", "[1]")] {
            let source = format!("#[account(discriminator = {left})] struct A {{}}\n#[account(discriminator = {right})] struct B {{}}");
            assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{source}");
        }
        for source in [
            "#[account(discriminator = [1])] struct A {} struct B {}",
            "#[other::account(discriminator = [1])] struct A {} #[account(discriminator = [1])] struct B {}",
            "#[account(discriminator = [1])] struct A {} // #[account(discriminator = [1])] struct B {}",
            "quote!(#[account(discriminator = [1])] struct A {} #[account(discriminator = [1])] struct B {});",
        ] { assert!(analyze("src/lib.rs", source).unwrap().hits.is_empty(), "{source}"); }
    }

    #[test]
    fn collisions_are_module_scoped_and_each_struct_is_reported_once() {
        let result = analyze("src/lib.rs", "mod a { #[account(discriminator = [1])] struct A {} } mod b { #[account(discriminator = [1])] struct B {} }").unwrap();
        assert!(result.hits.is_empty());
        let result = analyze("src/lib.rs", "mod a { #[account(discriminator = [1])] struct A {} #[account(discriminator = [1, 2])] struct B {} #[account(discriminator = [1, 2, 3])] struct C {} }").unwrap();
        assert_eq!(result.hits.len(), 3);
    }
}

#[cfg(test)]
mod signer_seed_tests {
    use super::*;

    #[test]
    fn signed_cpi_with_field_derived_seeds_requires_provenance_review() {
        for expression in [
            "invoke_signed(&ix, accounts, args.seeds)",
            "solana_program::program::invoke_signed(&ix, accounts, &[&[state.seed.as_ref()]])",
            "invoke_signed_unchecked(&ix, accounts, &[&[&instruction.data[..]]])",
        ] {
            let source = format!("fn process() {{\n {expression};\n}}");
            let result = analyze("src/lib.rs", &source).unwrap();
            assert_eq!(result.hits.len(), 1, "{source}");
            assert_eq!(result.hits[0].class, "signer-seeds");
            assert_eq!(result.hits[0].location.line, 2);
            assert_eq!(result.hits[0].location.handler.as_deref(), Some("process"));
        }
    }

    #[test]
    fn seeds_signal_is_confined_to_the_signed_call_seed_argument() {
        for expression in [
            "invoke_signed(&ix, accounts, &[&[b\"vault\", &[255]]])",
            "invoke_signed(&state.ix, args.accounts, validated_seeds)",
            "invoke(&ix, state.accounts)",
            "custom.invoke_signed(&ix, accounts, args.seeds)",
            "invoke_signed(&ix, args.seeds)",
            "quote!(invoke_signed(&ix, accounts, args.seeds))",
            "\"invoke_signed(&ix, accounts, args.seeds)\"",
            "invoke_signed(&ix, accounts, { fn helper() { state.seed; } STATIC_SEEDS })",
        ] {
            let source = format!("// invoke_signed(&ix, accounts, args.seeds)\nfn process() {{ {expression}; }}");
            assert!(analyze("src/lib.rs", &source).unwrap().hits.is_empty(), "{source}");
        }
    }
}

#[cfg(test)]
mod owner_tests {
    use super::*;
    fn owner_hits(source: &str) -> Vec<Hit> {
        analyze("src/lib.rs", source).unwrap().hits.into_iter().filter(|hit| hit.class == "missing-owner").collect()
    }
    #[test]
    fn direct_unchecked_parameter_data_reads_need_owner_review() {
        for (ty, read) in [("&AccountInfo<'_>", "account.try_borrow_data()"),
            ("anchor_lang::prelude::UncheckedAccount<'info>", "account.borrow_data()") ] {
            let source = format!("fn process(account: {ty}) {{\n let bytes = {read};\n}}");
            let hits = owner_hits(&source);
            assert_eq!(hits.len(), 1, "{source}");
            assert_eq!(hits[0].location.line, 2);
            assert_eq!(hits[0].location.handler.as_deref(), Some("process"));
        }
    }
    #[test]
    fn preceding_rejecting_owner_guards_suppress_the_signal() {
        for guard in ["if account.owner != expected { return Err(Error::Owner); }",
            "if expected != account.owner { return Err(Error::Owner); }"] {
            let source = format!("fn process(account: &AccountInfo) {{ {guard} let bytes = account.try_borrow_data(); }}");
            assert!(owner_hits(&source).is_empty(), "{source}");
        }
        for source in ["fn process(account: Account<Vault>) { account.try_borrow_data(); }",
            "fn process(account: &AccountInfo) { account.key(); }",
            "fn process(account: &AccountInfo) { quote!(account.try_borrow_data()); }"] {
            assert!(owner_hits(source).is_empty(), "{source}");
        }
    }
    #[test]
    fn irrelevant_late_or_non_rejecting_guards_do_not_hide_reads() {
        for body in [
            "if other.owner != expected { return Err(Error::Owner); } account.try_borrow_data();",
            "if account.owner != expected { log(); } account.try_borrow_data();",
            "if account.owner != expected { return Ok(()); } account.try_borrow_data();",
            "let ignored = account.owner == expected; account.try_borrow_data();",
            "if account.owner != account.owner { return Err(Error::Owner); } account.try_borrow_data();",
            "account.try_borrow_data(); if account.owner != expected { return Err(Error::Owner); }",
            "if flag { if account.owner != expected { return Err(Error::Owner); } } account.try_borrow_data();",
            "if account.owner != expected || flag { log(); } account.try_borrow_data();",
        ] {
            assert_eq!(owner_hits(&format!("fn process(account: &AccountInfo) {{ {body} }}")).len(), 1, "{body}");
        }
    }
    #[test]
    fn owner_scope_does_not_leak_into_nested_functions() {
        let source = "fn outer(account: &AccountInfo) { if account.owner != expected { return Err(Error::Owner); } fn inner(account: &AccountInfo) { account.try_borrow_data(); } account.try_borrow_data(); }";
        let hits = owner_hits(source);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].location.handler.as_deref(), Some("inner"));
    }
}

#[cfg(test)]
mod owner_scope_tests {
    use super::*;
    fn owner_hits(source: &str) -> Vec<Hit> {
        analyze("src/lib.rs", source).unwrap().hits.into_iter()
            .filter(|hit| hit.class == "missing-owner").collect()
    }
    #[test]
    fn owner_methods_require_an_immediate_rejecting_guard() {
        for guard in [
            "if !account.is_owned_by(expected) { return Err(Error::Owner); }",
            "if !(account.is_owned_by(&expected)) { return Err(Error::Owner); }",
            "if account.owner() != expected { return Err(Error::Owner); }",
            "if &expected != account.owner() { return Err(Error::Owner); }",
        ] {
            for read in ["account.borrow_data()", "account.try_borrow_data()?"] {
                let source = format!("fn process(account: &AccountInfo) {{ {guard} let bytes = {read}; }}");
                assert!(owner_hits(&source).is_empty(), "{source}");
            }
        }
    }
    #[test]
    fn ineffective_owner_methods_do_not_suppress_reads() {
        for guard in [
            "if account.is_owned_by(expected) { return Err(Error::Owner); }",
            "if !other.is_owned_by(expected) { return Err(Error::Owner); }",
            "if !account.is_owned_by(account.owner()) { return Err(Error::Owner); }",
            "if !account.is_owned_by(&mut expected) { return Err(Error::Owner); }",
            "if !account.is_owned_by(expected, extra) { return Err(Error::Owner); }",
            "if !account.is_owned_by::<Other>(expected) { return Err(Error::Owner); }",
            "if !account.is_owned_by(expected) { return Ok(()); }",
            "if !account.is_owned_by(expected) { log(); }",
            "if !account.is_owned_by(expected) && flag { return Err(Error::Owner); }",
            "if account.owner() == expected { return Err(Error::Owner); }",
            "if account.owner(extra) != expected { return Err(Error::Owner); }",
            "if account.owner::<Other>() != expected { return Err(Error::Owner); }",
            "if account.owner() != expected() { return Err(Error::Owner); }",
            "if account.owner() != account.owner() { return Err(Error::Owner); }",
            "if !account.is_owned_by(expected) { return Err(Error::Owner); } replace(&mut account);",
            "if !account.is_owned_by(expected) { return Err(Error::Owner); } else { replace(&mut account); }",
        ] {
            let source = format!("fn process(mut account: &AccountInfo) {{ {guard} account.try_borrow_data(); }}");
            assert_eq!(owner_hits(&source).len(), 1, "{source}");
        }
    }
    #[test]
    fn owner_method_guards_remain_local_to_the_next_direct_read() {
        let source = "fn outer(account: &AccountInfo) {
            if !account.is_owned_by(expected) { return Err(Error::Owner); }
            fn inner(account: &AccountInfo) { account.borrow_data(); }
            account.borrow_data();
            account.borrow_data();
        }";
        let hits = owner_hits(source);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].location.handler.as_deref(), Some("outer"));
        assert_eq!(hits[0].location.line, 5);
        assert_eq!(hits[1].location.handler.as_deref(), Some("inner"));
        assert_eq!(hits[1].location.line, 3);
        for next in [
            "let read = |account: &AccountInfo| account.borrow_data();",
            "let _ = (account = other, account.borrow_data());",
            "consume(account.borrow_data());",
        ] {
            let source = format!("fn process(mut account: &AccountInfo) {{ if !account.is_owned_by(expected) {{ return Err(Error::Owner); }} {next} }}");
            assert_eq!(owner_hits(&source).len(), 1, "{source}");
        }
    }
    #[test]
    fn guards_do_not_authorize_shadowing_closures_or_reassigned_accounts() {
        for next in [
            "let read = |account: &AccountInfo| account.try_borrow_data();",
            "let _ = (account = other, account.try_borrow_data());",
            "let _ = (replace_account(&mut account), account.try_borrow_data());",
            "let _ = (account = other).then(|| account.try_borrow_data());",
        ] {
            let source = format!("fn process(mut account: &AccountInfo) {{ if account.owner != expected {{ return Err(Error::Owner); }} {next} }}");
            assert_eq!(analyze("src/lib.rs", &source).unwrap().hits.iter().filter(|hit| hit.class == "missing-owner").count(), 1, "{source}");
        }
    }
    #[test]
    fn unchecked_cpi_program_parameters_are_reported() {
        for (ty, expression) in [
            ("AccountInfo<'_>", "CpiContext::new(program, accounts)"),
            ("&UncheckedAccount<'_>", "anchor_lang::context::CpiContext::new(program.to_account_info(), accounts)"),
            ("&solana_program::account_info::AccountInfo<'_>", "CpiContext::new_with_signer(program.clone(), accounts, seeds)"),
            ("UncheckedAccount<'_>", "CpiContext::<Transfer>::new((&program).to_account_info(), accounts)"),
        ] {
            let source = format!("fn transfer(program: {ty}) {{\n {expression};\n }}");
            let hits = analyze("src/lib.rs", &source).unwrap().hits.into_iter().filter(|hit| hit.class == "arbitrary-cpi").collect::<Vec<_>>();
            assert_eq!(hits.len(), 1, "{source}");
            assert_eq!(hits[0].location.line, 2);
            assert_eq!(hits[0].location.handler.as_deref(), Some("transfer"));
        }
    }
    #[test]
    fn cpi_parameter_signal_excludes_typed_programs_and_unrelated_uses() {
        for source in [
            "fn transfer(program: Program<'_, Token>) { CpiContext::new(program.to_account_info(), accounts); }",
            "fn transfer(program: Interface<'_, TokenInterface>) { CpiContext::new_with_signer(program.to_account_info(), accounts, seeds); }",
            "fn transfer(program: AccountInfo<'_>) { CpiContext::new(approved_program, program); }",
            "fn transfer(program: AccountInfo<'_>) { OtherContext::new(program, accounts); }",
            "fn transfer(program: AccountInfo<'_>) { quote!(CpiContext::new(program, accounts)); }",
            "fn transfer(program: AccountInfo<'_>) { CpiContext::new(program); }",
            "fn transfer(program: AccountInfo<'_>) { CpiContext::new(program.select(other), accounts); }",
            "fn transfer(program: AccountInfo<'_>) { fn nested(program: Program<'_, Token>) { CpiContext::new(program, accounts); } }",
        ] {
            assert!(!analyze("src/lib.rs", source).unwrap().hits.iter().any(|hit| hit.class == "arbitrary-cpi"), "{source}");
        }
    }

}

#[cfg(test)]
mod signer_parameter_tests {
    use super::*;
    fn hits(source: &str) -> Vec<Hit> {
        analyze("src/lib.rs", source).unwrap().hits.into_iter().filter(|h| h.class == "missing-signer").collect()
    }
    #[test]
    fn unchecked_authority_parameters_need_entry_signer_guards() {
        for ty in ["&solana_program::account_info::AccountInfo<'_>", "&pinocchio::account_info::AccountInfo"] {
            let source = format!("fn withdraw(\n vault_authority: {ty}\n) {{ transfer(); }}");
            let found = hits(&source);
            assert_eq!(found.len(), 1, "{source}");
            assert_eq!(found[0].location.line, 2);
            assert_eq!(found[0].location.handler.as_deref(), Some("withdraw"));
        }
    }
    #[test]
    fn entry_signer_rejection_and_typed_signers_are_excluded() {
        for source in [
            "fn withdraw(authority: &AccountInfo) { if !authority.is_signer { return Err(Error::Signer); } transfer(); }",
            "fn withdraw(admin: &AccountInfo) { if !(admin.is_signer()) { return Err(Error::Signer); } transfer(); }",
            "fn withdraw(authority: Signer<'_>) { transfer(); }",
            "fn deposit(destination: &AccountInfo) { transfer(); }",
            "fn f(owner_count: usize) {}",
        ] { assert!(hits(source).is_empty(), "{source}"); }
    }
    #[test]
    fn incidental_or_late_signer_tests_do_not_suppress_parameters() {
        for body in [
            "let _ = authority.is_signer; transfer();",
            "if !other.is_signer { return Err(Error::Signer); } transfer();",
            "if !authority.is_signer { log(); } transfer();",
            "if !authority.is_signer { return Ok(()); } transfer();",
            "if !authority.is_signer && flag { return Err(Error::Signer); } transfer();",
            "if flag { if !authority.is_signer { return Err(Error::Signer); } } transfer();",
            "transfer(); if !authority.is_signer { return Err(Error::Signer); }",
            "quote!(if !authority.is_signer { return Err(Error::Signer); }); transfer();",
            "let check = |authority: &AccountInfo| { if !authority.is_signer { return Err(Error::Signer); } };",
        ] {
            assert_eq!(hits(&format!("fn f(authority: &AccountInfo) {{ {body} }}")).len(), 1, "{body}");
        }
    }
    #[test]
    fn signer_guards_are_scoped_to_their_own_function_and_parameter() {
        let found = hits("fn outer(authority: &AccountInfo) { if !authority.is_signer { return Err(Error::Signer); } fn inner(authority: &AccountInfo) { transfer(); } }");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].location.handler.as_deref(), Some("inner"));
        let found = hits("fn f(authority: &AccountInfo, admin: &AccountInfo) { if !authority.is_signer { return Err(Error::Signer); } transfer(); }");
        assert_eq!(found.len(), 1);
    }
}

#[cfg(test)]
mod remaining_accounts_tests {
    use super::*;
    #[test]
    fn remaining_account_field_accesses_require_validation_review() {
        for expression in ["ctx.remaining_accounts[0]", "context.remaining_accounts.iter()", "&ctx.remaining_accounts", "(ctx).remaining_accounts.len()"] {
            let source = format!("fn process() {{\n let _ = {expression};\n }}");
            let result = analyze("src/lib.rs", &source).unwrap();
            let hits: Vec<_> = result.hits.iter().filter(|h| h.class == "unchecked-sysvar-id").collect();
            assert_eq!(hits.len(), 1, "{source}");
            assert_eq!(hits[0].location.line, 2);
            assert_eq!(hits[0].location.handler.as_deref(), Some("process"));
        }
    }
    #[test]
    fn remaining_accounts_names_without_field_access_are_not_reported() {
        for source in [
            "fn process() { let _ = ctx.accounts.vault; }",
            "fn process() { let _ = remaining_accounts; }",
            "fn process() { let _ = ctx.remaining_accounts(); }",
            "fn process() { let _ = ctx.remaining_accounts_count; }",
            "fn process() { quote!(ctx.remaining_accounts[0]); }",
            "fn process() { let _ = \"ctx.remaining_accounts\"; /* ctx.remaining_accounts */ }",
            "struct Context { remaining_accounts: Vec<AccountInfo> }",
        ] { assert!(analyze("src/lib.rs", source).unwrap().hits.is_empty(), "{source}"); }
    }
    #[test]
    fn validation_mentions_do_not_silence_remaining_accounts_signal() {
        let result = analyze("src/lib.rs", "fn outer() { validate(ctx.remaining_accounts); fn inner() { consume(ctx.remaining_accounts); } }").unwrap();
        let hits: Vec<_> = result.hits.iter().filter(|h| h.class == "unchecked-sysvar-id").collect();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].location.handler.as_deref(), Some("outer"));
        assert_eq!(hits[1].location.handler.as_deref(), Some("inner"));
    }
}

#[cfg(test)]
mod manual_close_tests {
    use super::*;
    fn hits(source: &str) -> Vec<Hit> {
        analyze("src/lib.rs", source).unwrap().hits.into_iter()
            .filter(|hit| hit.class == "revival-reinit").collect()
    }
    #[test]
    fn zeroing_borrowed_lamports_requires_close_review() {
        for expression in [
            "**account.try_borrow_mut_lamports()? = 0",
            "**ctx.accounts.vault.to_account_info().borrow_mut_lamports() = 0u64",
            "**(account.try_borrow_mut_lamports()?) = (0x0)",
        ] {
            let found = hits(&format!("fn close() {{\n {expression};\n }}"));
            assert_eq!(found.len(), 1, "{expression}");
            assert_eq!(found[0].location.line, 2);
            assert_eq!(found[0].location.handler.as_deref(), Some("close"));
        }
    }
    #[test]
    fn close_helpers_nonzero_assignments_and_unrelated_names_are_excluded() {
        for source in [
            "fn close() { account.close(destination)?; }",
            "fn close() { **account.try_borrow_mut_lamports()? = 1; }",
            "fn close() { **account.borrow_mut_data() = 0; }",
            "fn close() { let _ = account.borrow_mut_lamports(); }",
            "fn close() { account.borrow_mut_lamports = 0; }",
            "fn close() { quote!(**account.borrow_mut_lamports() = 0); }",
            "fn close() { let _ = \"**account.borrow_mut_lamports() = 0\"; }",
        ] { assert!(hits(source).is_empty(), "{source}"); }
    }
    #[test]
    fn reassignment_mentions_are_not_a_proof_of_safe_closure() {
        let found = hits("fn outer() { **account.borrow_mut_lamports() = 0; if false { account.assign(&system_id); } fn inner() { **other.borrow_mut_lamports() = 0; } }");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].location.handler.as_deref(), Some("outer"));
        assert_eq!(found[1].location.handler.as_deref(), Some("inner"));
    }
}
