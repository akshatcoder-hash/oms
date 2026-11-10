# solbench-harness: the one image every harness runs in (codex and Claude Code as the agent container, OMS as its sandbox image).
# The workspace SDKs are not baked in: bench/solbench-harness/deps is installed once and mounted read-only at /work/node_modules.
FROM oms-bench-agents:1
RUN npm install -g --no-audit --no-fund bun@1.4.4 && bun --version
