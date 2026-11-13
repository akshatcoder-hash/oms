import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireMutationLease, acquireTaskLease, createTask, openWorkspace, readTask, recoverStaleLease, resolveBaseOid, WorkspaceError } from "../src/workspace/index.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oms-workspace-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "code.txt"), "original\n");
  git(root, "add", "code.txt");
  git(root, "commit", "-qm", "fixture");
  return { base, root, stateRoot: join(base, "state"), oid: git(root, "rev-parse", "HEAD") };
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof WorkspaceError && error.code === code;
}

test("workspace registration canonicalizes symlink aliases and separates identical-remote clones", t => {
  const f = fixture(t);
  git(f.root, "remote", "add", "origin", "https://example.invalid/same.git");
  const a = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  const alias = join(f.base, "alias");
  symlinkSync(f.root, alias);
  assert.deepEqual(openWorkspace(alias, { stateRoot: f.stateRoot }), a);
  const clone = join(f.base, "clone");
  git(f.base, "clone", "-q", f.root, clone);
  git(clone, "remote", "set-url", "origin", "https://example.invalid/same.git");
  const b = openWorkspace(clone, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.stateDir, b.stateDir);
  assert.deepEqual(Object.keys(a).sort(), ["gitCommonDir", "id", "omsDir", "root", "stateDir"]);
  assert.equal(a.omsDir, join(f.root, ".oms"));
  assert.ok(!a.stateDir.startsWith(`${f.root}/`));
});

test("initialization requires an explicit ignore decision and refuses tracked private state", t => {
  const f = fixture(t);
  assert.throws(() => openWorkspace(f.root, { stateRoot: f.stateRoot }), errorCode("INITIALIZATION_REQUIRED"));
  assert.throws(() => openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "require-existing" } }), errorCode("IGNORE_REQUIRED"));
  assert.equal(existsSync(join(f.root, ".oms")), false);
  mkdirSync(join(f.root, ".oms"), { mode: 0o700 });
  writeFileSync(join(f.root, ".oms", ".env.agent"), "SYNTHETIC=value\n");
  git(f.root, "add", "-f", ".oms/.env.agent");
  assert.throws(() => openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } }), errorCode("TRACKED_PRIVATE_STATE"));
});

test("private roots reject symlinks and broad permissions; external state cannot live inside a repository", t => {
  const f = fixture(t);
  const outside = join(f.base, "outside");
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(f.root, ".oms"));
  assert.throws(() => openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } }), errorCode("UNSAFE_PATH"));
  rmSync(join(f.root, ".oms"));
  mkdirSync(join(f.root, ".oms"), { mode: 0o755 });
  assert.throws(() => openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } }), errorCode("UNSAFE_PATH"));
  chmodSync(join(f.root, ".oms"), 0o700);
  assert.throws(() => openWorkspace(f.root, { stateRoot: join(f.root, "private"), initialize: { ignore: "exclude" } }), errorCode("STATE_INSIDE_REPOSITORY"));
});

test("copied identity cannot attach external state and moving a repository needs explicit relink", t => {
  const f = fixture(t);
  const a = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  const copy = join(f.base, "copy");
  cpSync(f.root, copy, { recursive: true });
  assert.throws(() => openWorkspace(copy, { stateRoot: f.stateRoot }), errorCode("IDENTITY_DECISION_REQUIRED"));
  assert.throws(() => openWorkspace(copy, { stateRoot: f.stateRoot, identityDecision: "relink" }), errorCode("IDENTITY_IN_USE"));
  const b = openWorkspace(copy, { stateRoot: f.stateRoot, identityDecision: "new" });
  assert.notEqual(a.id, b.id);
  const moved = join(f.base, "moved");
  renameSync(f.root, moved);
  assert.throws(() => openWorkspace(moved, { stateRoot: f.stateRoot }), errorCode("IDENTITY_DECISION_REQUIRED"));
  const c = openWorkspace(moved, { stateRoot: f.stateRoot, identityDecision: "relink" });
  assert.equal(c.id, a.id);
  assert.equal(c.stateDir, a.stateDir);
  assert.equal(c.root, moved);
});

test("task worktrees preserve dirty primary checkout, persist ownership and reopen the parent workspace", t => {
  const f = fixture(t);
  const w = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  writeFileSync(join(f.root, "code.txt"), "user dirty change\n");
  writeFileSync(join(f.root, "untracked.txt"), "keep me\n");
  const before = git(f.root, "status", "--porcelain");
  const task = createTask(w, { id: "first", baseOid: f.oid });
  assert.equal(readFileSync(join(f.root, "code.txt"), "utf8"), "user dirty change\n");
  assert.equal(git(f.root, "status", "--porcelain"), before);
  assert.equal(readFileSync(join(task.codeRoot, "code.txt"), "utf8"), "original\n");
  assert.equal(task.taskFile, join(w.omsDir, "tasks", "first", "task.json"));
  assert.equal(task.pinFile, join(w.stateDir, "tasks", "first", "pin.json"));
  assert.equal(task.baseOid, f.oid);
  assert.equal(git(task.codeRoot, "symbolic-ref", "--short", "HEAD"), task.branch);
  assert.deepEqual(readTask(w, task.id), task);
  assert.deepEqual(openWorkspace(task.codeRoot, { stateRoot: f.stateRoot }), w);
  assert.equal(existsSync(join(task.codeRoot, ".oms")), false);
  const lease = acquireTaskLease(w, task.id);
  assert.throws(() => acquireTaskLease(w, task.id), errorCode("LEASE_BUSY"));
  lease.release();
  lease.release();
  acquireTaskLease(w, task.id).release();
  assert.throws(() => openWorkspace(f.root, { stateRoot: join(task.codeRoot, "state") }), errorCode("STATE_INSIDE_REPOSITORY"));
});

test("task creation rejects existing branches, paths, invalid ids and symbolic bases without clobbering", t => {
  const f = fixture(t);
  const w = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "gitignore" } });
  assert.match(readFileSync(join(f.root, ".gitignore"), "utf8"), /\/\.oms\//);
  git(f.root, "branch", `oms/${w.id}/reserved`, f.oid);
  assert.throws(() => createTask(w, { id: "reserved", baseOid: f.oid }), errorCode("TASK_EXISTS"));
  const codeRoot = join(w.omsDir, "worktrees", "occupied");
  mkdirSync(codeRoot);
  writeFileSync(join(codeRoot, "keep.txt"), "untouched");
  assert.throws(() => createTask(w, { id: "occupied", baseOid: f.oid }), errorCode("TASK_EXISTS"));
  assert.equal(readFileSync(join(codeRoot, "keep.txt"), "utf8"), "untouched");
  assert.throws(() => createTask(w, { id: "../escape", baseOid: f.oid }), errorCode("INVALID_TASK_ID"));
  assert.throws(() => createTask(w, { id: "symbolic", baseOid: "HEAD" }), errorCode("INVALID_BASE_OID"));
});

test("host Git never executes configured checkout hooks, filters or fsmonitor", t => {
  const f = fixture(t);
  const marker = join(f.base, "executed");
  const script = join(f.base, "helper");
  writeFileSync(script, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`, { mode: 0o700 });
  writeFileSync(join(f.root, ".gitattributes"), "code.txt filter=evil\n");
  git(f.root, "add", ".gitattributes");
  git(f.root, "commit", "-qm", "attributes");
  const oid = git(f.root, "rev-parse", "HEAD");
  git(f.root, "config", "filter.evil.smudge", script);
  git(f.root, "config", "filter.evil.process", script);
  git(f.root, "config", "core.fsmonitor", script);
  writeFileSync(join(f.root, ".git", "hooks", "post-checkout"), `#!/bin/sh\nprintf hook > '${marker}'\n`, { mode: 0o700 });
  const w = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  createTask(w, { id: "safe", baseOid: oid });
  assert.equal(existsSync(marker), false);
});

test("leases recover only confirmed stale process identities and never steal live or malformed owners", t => {
  const f = fixture(t);
  mkdirSync(f.stateRoot, { mode: 0o700 });
  const file = join(f.stateRoot, "mutation.lease");
  const lease = acquireMutationLease(file);
  const owner = JSON.parse(readFileSync(file, "utf8"));
  assert.throws(() => recoverStaleLease(file, owner.token), errorCode("LEASE_BUSY"));
  lease.release();
  writeFileSync(file, JSON.stringify({ ...owner, start: "not-this-process", token: "stale-token" }), { mode: 0o600 });
  assert.throws(() => acquireMutationLease(file), errorCode("LEASE_STALE"));
  recoverStaleLease(file, "stale-token");
  acquireMutationLease(file).release();
  writeFileSync(file, "{}", { mode: 0o600 });
  assert.throws(() => acquireMutationLease(file), errorCode("LEASE_UNVERIFIABLE"));
  assert.throws(() => recoverStaleLease(file, "anything"), errorCode("LEASE_UNVERIFIABLE"));
});

test("concurrent processes cannot acquire the same mutation lease or create the same task", async t => {
  const f = fixture(t);
  const w = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  const module = fileURLToPath(new URL("../src/workspace/index.ts", import.meta.url));
  const run = async (code: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => output += data);
    child.stderr.on("data", data => output += data);
    const [codeResult] = await once(child, "close");
    return { code: typeof codeResult === "number" ? codeResult : null, output };
  };
  const taskCode = `import {createTask} from ${JSON.stringify(module)}; try { createTask(${JSON.stringify(w)}, {id:'racing',baseOid:${JSON.stringify(f.oid)}}); console.log('created'); } catch(e) {console.log(e.code); process.exitCode=2;}`;
  const results = await Promise.all([run(taskCode), run(taskCode)]);
  assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results));
  assert.match(results.find(result => result.code !== 0)!.output, /LEASE_BUSY|TASK_EXISTS/);
  const task = readTask(w, "racing");
  assert.ok(existsSync(join(task.codeRoot, "code.txt")));
  const lease = acquireMutationLease(task.leaseFile);
  const result = await run(`import {acquireMutationLease} from ${JSON.stringify(module)}; try { acquireMutationLease(${JSON.stringify(task.leaseFile)}); process.exitCode=3; } catch(e) {console.log(e.code);}`);
  assert.match(result.output, /LEASE_BUSY/);
  lease.release();
  assert.equal(dirname(task.pinFile), join(w.stateDir, "tasks", task.id));
});

test("metadata without the trusted registry is not adopted and discovery performs no initialization", t => {
  const f = fixture(t);
  const w = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  renameSync(f.stateRoot, join(f.base, "old-state"));
  assert.throws(() => openWorkspace(f.root, { stateRoot: f.stateRoot }), errorCode("IDENTITY_DECISION_REQUIRED"));
  assert.equal(existsSync(f.stateRoot), false);
  const replacement = openWorkspace(f.root, { stateRoot: f.stateRoot, identityDecision: "new" });
  assert.notEqual(replacement.id, w.id);
});

test("a historical base with tracked OMS state cannot expose it through a task checkout", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".oms"), { mode: 0o700 });
  writeFileSync(join(f.root, ".oms", ".env.agent"), "SYNTHETIC=value\n");
  git(f.root, "add", "-f", ".oms/.env.agent");
  git(f.root, "commit", "-qm", "historical private state");
  const unsafeBase = git(f.root, "rev-parse", "HEAD");
  git(f.root, "rm", ".oms/.env.agent");
  git(f.root, "commit", "-qm", "remove private state");
  const w = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  assert.throws(() => createTask(w, { id: "unsafe-base", baseOid: unsafeBase }), errorCode("TRACKED_PRIVATE_STATE"));
  assert.equal(existsSync(join(w.omsDir, "worktrees", "unsafe-base")), false);
});

test("a private state-root symlink ancestor is refused", t => {
  const f = fixture(t);
  const actual = join(f.base, "actual");
  mkdirSync(actual);
  const alias = join(f.base, "state-alias");
  symlinkSync(actual, alias);
  assert.throws(() => openWorkspace(f.root, { stateRoot: join(alias, "state"), initialize: { ignore: "exclude" } }), errorCode("UNSAFE_PATH"));
});

test("an exited owner is recoverable only with its exact recorded token", t => {
  const f = fixture(t);
  mkdirSync(f.stateRoot, { mode: 0o700 });
  const file = join(f.stateRoot, "crashed.lease");
  const module = fileURLToPath(new URL("../src/workspace/index.ts", import.meta.url));
  const token = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {acquireMutationLease} from ${JSON.stringify(module)}; console.log(acquireMutationLease(${JSON.stringify(file)}).token);`,
  ], { encoding: "utf8" }).trim();
  assert.throws(() => acquireMutationLease(file), errorCode("LEASE_STALE"));
  assert.throws(() => recoverStaleLease(file, "wrong-token"), errorCode("LEASE_OWNERSHIP_LOST"));
  recoverStaleLease(file, token);
  acquireMutationLease(file).release();
});

test("failed Git worktree creation preserves durable intent and another controller's ref lock", t => {
  const f = fixture(t);
  const oid = f.oid;
  const w = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  const refDirectory = join(w.gitCommonDir, "refs", "heads", "oms", w.id);
  mkdirSync(refDirectory, { recursive: true });
  const refLock = join(refDirectory, "failed.lock");
  writeFileSync(refLock, "another controller owns this lock\n", { flag: "wx" });
  assert.throws(() => createTask(w, { id: "failed", baseOid: oid }), /cannot lock ref/);
  const record = JSON.parse(readFileSync(join(w.omsDir, "tasks", "failed", "record.json"), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.workspaceId, w.id);
  assert.equal(record.baseOid, oid);
  assert.equal(readFileSync(refLock, "utf8"), "another controller owns this lock\n");
  assert.equal(readFileSync(join(f.root, "code.txt"), "utf8"), "original\n");
  assert.throws(() => readTask(w, "failed"), errorCode("TASK_IDENTITY_MISMATCH"));
  assert.throws(() => createTask(w, { id: "failed", baseOid: oid }), errorCode("TASK_EXISTS"));
});

test("a task base defaults to HEAD and accepts any revision git resolves, but rejects what it cannot resolve", t => {
  const f = fixture(t);
  const workspace = openWorkspace(f.root, { stateRoot: f.stateRoot, initialize: { ignore: "exclude" } });
  git(f.root, "branch", "release");
  git(f.root, "tag", "v1");
  assert.equal(resolveBaseOid(workspace), f.oid);
  for (const revision of ["HEAD", "release", "v1", f.oid.slice(0, 10), "HEAD~0"]) assert.equal(resolveBaseOid(workspace, revision), f.oid, revision);
  for (const revision of ["missing", "--all", "", "HEAD:code.txt"]) assert.throws(() => resolveBaseOid(workspace, revision), errorCode("INVALID_BASE_OID"), revision);
});
