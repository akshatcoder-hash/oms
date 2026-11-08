use pinocchio::AccountView;
pinocchio::declare_id!("11111111111111111111111111111111");
pinocchio::entrypoint!(process_instruction);
pub fn process_instruction(program_id: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult { Ok(()) }
