/** Resources of a program-build container; the agent tools, the verifier and `oms toolchain fix --verify` share them. */
export const BUILD_LIMITS = { memoryMb: 6144, cpus: 4, pidsLimit: 1024 } as const;
export const BUILD_TIMEOUT_MS = 900_000;
