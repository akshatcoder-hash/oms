use solana_program::account_info::AccountInfo;
solana_program::declare_id!("11111111111111111111111111111111");
solana_program::entrypoint!(process_instruction);
pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult { Ok(()) }
