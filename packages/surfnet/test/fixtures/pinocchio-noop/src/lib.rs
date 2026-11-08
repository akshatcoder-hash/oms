#![no_std]
use pinocchio::{AccountView, Address, ProgramResult};
pinocchio::program_entrypoint!(process_instruction);
pinocchio::no_allocator!();
pinocchio::nostd_panic_handler!();

// Exercise program transport above 400 KiB with real, referenced ELF rodata.
static PAYLOAD: [u8; 410_000] = [42; 410_000];
fn process_instruction(_: &Address, _: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let index = data.first().copied().unwrap_or(0) as usize;
    let byte = unsafe { core::ptr::read_volatile(PAYLOAD.as_ptr().add(index)) };
    if byte == 42 { Ok(()) } else { Err(pinocchio::error::ProgramError::InvalidInstructionData) }
}
