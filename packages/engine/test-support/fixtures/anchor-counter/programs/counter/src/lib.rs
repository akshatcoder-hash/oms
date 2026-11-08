use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZSnL8W9pXz5HoWbapZkR");

#[program]
pub mod oms_anchor_counter {
    use super::*;
    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        ctx.accounts.counter.value = ctx.accounts.counter.value.checked_add(1).unwrap();
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut)]
    pub counter: Account<'info, Counter>,
}

#[account]
pub struct Counter {
    pub value: u64,
}
