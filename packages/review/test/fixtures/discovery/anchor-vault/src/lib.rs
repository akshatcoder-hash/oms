use anchor_lang::prelude::*;
declare_id!("11111111111111111111111111111111");
#[program]
pub mod anchor_vault {
    use super::*;
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Withdraw<'info> { pub authority: Signer<'info> }
fn helper() {}
