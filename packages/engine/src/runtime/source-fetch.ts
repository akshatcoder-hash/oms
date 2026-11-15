import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { wrapUntrusted } from "./knowledge-service.ts";
import { createGunzip } from "node:zlib";

const run = promisify(execFile);

/**
 * source_fetch: OMS (the host process, never the agent's sandbox) downloads a GitHub repository or an npm package as an
 * archive from a fixed host allowlist and extracts it where the agent's commands can read it, so a program's instruction
 * and state definitions can be grepped locally instead of paged through the web. Every archive is checked before and after
 * extraction: size caps, entry types, path escapes.
 */
export interface SourceLimits {
  /** Bytes downloaded, compressed. */
  compressed: number;
  /** Bytes after gunzip, which bounds what tar can write. */
  extracted: number;
  /** Archive entries (files and directories). */
  entries: number;
  /** Distinct repositories or packages per user request. */
  repositories: number;
}
export const SOURCE_LIMITS: SourceLimits = { compressed: 50 * 2 ** 20, extracted: 200 * 2 ** 20, entries: 50_000, repositories: 5 };
const SOURCE_HOSTS = ["api.github.com", "codeload.github.com", "registry.npmjs.org"] as const;
const JSON_LIMIT = 5 * 2 ** 20;
const TREE_LINES = 60;

export type SourceRequest = { repo?: string; ref?: string; paths?: string[]; npm?: string; version?: string };

export interface SourceFetchOptions {
  /** Root the sources are extracted under. */
  dir: string;
  fetch: typeof fetch;
  /** Throws when a host resolves to a private address (web.ts's check). */
  checkHost(host: string): Promise<void>;
  githubToken?: string;
  limits?: Partial<SourceLimits>;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF = /^(?!-)[A-Za-z0-9_./@+-]{1,200}$/;
const NPM = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/;
/** Type character and permission bits that start every `tar -tv` line: regular files and directories only. */
const ENTRY = /^([-d])[-rwxsStT]{9}/;
const LINK = /^[lh][-rwxsStT]{9}/;

const fail = (reason: string) => new Error(`source_fetch refused: ${reason}`);
const limited = (limit: number, what: string) => {
  let seen = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, done) {
    seen += chunk.length;
    done(seen > limit ? fail(`the ${what} is larger than ${limit} bytes`) : null, chunk);
  } });
};
const safeSegment = (value: string) => value.replace(/^@/, "").replaceAll("/", "__");

function cleanPaths(paths: string[]): string[] {
  const cleaned = paths.map(raw => {
    const path = posix.normalize(raw.replace(/^\.\//, "")).replace(/\/$/, "");
    if (!path || path === "." || path.startsWith("/") || path.split("/").includes("..")) throw fail(`path "${raw}" is not a relative subdirectory`);
    return path;
  }).sort();
  return cleaned.filter((path, i) => !cleaned.slice(0, i).some(parent => path === parent || path.startsWith(`${parent}/`)));
}

interface Tree { files: number; bytes: number; lines: string[] }
/** Walks an extracted tree, refusing anything but regular files and directories. */
async function survey(root: string): Promise<Tree> {
  let bytes = 0;
  const count = async (dir: string): Promise<number> => {
    let own = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) own += await count(path);
      else if (entry.isFile()) { own++; bytes += (await lstat(path)).size; }
      else throw fail(`the archive holds ${entry.isSymbolicLink() ? "a symlink" : "a special file"} (${entry.name})`);
    }
    return own;
  };
  let files = 0;
  const lines: string[] = [];
  for (const top of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, top.name);
    if (!top.isDirectory()) {
      if (!top.isFile()) throw fail(`the archive holds ${top.isSymbolicLink() ? "a symlink" : "a special file"} (${top.name})`);
      files++;
      bytes += (await lstat(path)).size;
      lines.push(top.name);
      continue;
    }
    const children = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const own = await count(path);
    files += own;
    lines.push(`${top.name}/ (${own} files)`);
    for (const child of children.slice(0, 6)) lines.push(`  ${child.name}${child.isDirectory() ? "/" : ""}`);
    if (children.length > 6) lines.push(`  ... ${children.length - 6} more`);
  }
  return { files, bytes, lines: lines.length > TREE_LINES ? [...lines.slice(0, TREE_LINES), `... ${lines.length - TREE_LINES} more lines`] : lines };
}

export function createSourceFetch(options: SourceFetchOptions) {
  const limits = { ...SOURCE_LIMITS, ...options.limits };
  const taken = new Set<string>();

  async function get(start: string, accept: string, signal?: AbortSignal): Promise<Response> {
    let url = new URL(start);
    for (let hop = 0; hop <= 3; hop++) {
      if (url.protocol !== "https:" || url.username || url.password || !(SOURCE_HOSTS as readonly string[]).includes(url.hostname)) {
        throw fail(`${url.hostname || "that URL"} is not an allowed source host (${SOURCE_HOSTS.join(", ")})`);
      }
      await options.checkHost(url.hostname);
      const headers: Record<string, string> = { accept, "user-agent": "oms-source-fetch/1" };
      if (url.hostname === "api.github.com" && options.githubToken) headers.authorization = `Bearer ${options.githubToken}`;
      const response = await options.fetch(url.href, { headers, redirect: "manual", signal });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        void response.body?.cancel().catch(() => {});
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`source_fetch got HTTP ${response.status} from ${url.hostname}`); }
      return response;
    }
    throw fail("too many redirects");
  }

  async function getJson(url: string, signal?: AbortSignal): Promise<any> {
    const response = await get(url, "application/json", signal);
    const chunks: Buffer[] = [];
    await pipeline(Readable.fromWeb(response.body as never), limited(JSON_LIMIT, "metadata response"), async function (source: AsyncIterable<Buffer>) { for await (const chunk of source) chunks.push(chunk); });
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("source_fetch got an unreadable metadata response"); }
  }

  /** Download, gunzip under both caps, validate with tar, extract with the top directory stripped and links left out; returns how many links were left out. */
  async function unpack(archiveUrl: string, into: string, signal?: AbortSignal): Promise<number> {
    const response = await get(archiveUrl, "application/gzip, application/octet-stream", signal);
    const tarFile = `${into}.tar`;
    try {
      await pipeline(Readable.fromWeb(response.body as never), limited(limits.compressed, "download"), createGunzip(), limited(limits.extracted, "extracted archive"), createWriteStream(tarFile));
      const verbose = (await run("tar", ["-tvf", tarFile], { maxBuffer: 256 * 2 ** 20 })).stdout.split("\n").filter(Boolean);
      const names = (await run("tar", ["-tf", tarFile], { maxBuffer: 256 * 2 ** 20 })).stdout.split("\n").filter(Boolean);
      if (verbose.length > limits.entries) throw fail(`the archive has more than ${limits.entries} entries`);
      if (names.length !== verbose.length) throw fail("the archive listing is ambiguous");
      const links: string[] = [];
      verbose.forEach((line, i) => {
        if (LINK.test(line) || line.includes(" link to ")) links.push(names[i]!);
        else if (!ENTRY.test(line)) throw fail("the archive holds a special entry (device, fifo or socket)");
      });
      for (const name of names) if (name.startsWith("/") || name.split("/").includes("..")) throw fail("the archive has an entry that escapes the target directory");
      await mkdir(into, { recursive: true });
      const exclude = `${into}.links`;
      if (links.length) await writeFile(exclude, links.map(name => name.replace(/[\\*?[\]]/g, ch => `\\${ch}`)).join("\n") + "\n");
      try {
        await run("tar", ["-xf", tarFile, "-C", into, "--strip-components=1", "--no-same-owner", "--no-same-permissions", ...(links.length ? ["-X", exclude] : [])]);
      } finally { await rm(exclude, { force: true }); }
      await run("chmod", ["-R", "u+rwX", into]);
      return links.length;
    } finally { await rm(tarFile, { force: true }); }
  }

  async function fetchSource(request: SourceRequest, signal?: AbortSignal): Promise<string> {
    if (Boolean(request.repo) === Boolean(request.npm)) throw fail("give exactly one of repo (owner/name) or npm (package)");
    const key = request.repo ? `github:${request.repo.toLowerCase()}` : `npm:${request.npm}`;
    if (!taken.has(key) && taken.size >= limits.repositories) {
      throw new Error(`source_fetch budget for this request is used (${limits.repositories} repositories); read the ones already fetched with bash. The limit resets at the next user message.`);
    }
    let name: string;
    let label: string;
    let archiveUrl: string;
    if (request.repo) {
      if (!REPO.test(request.repo)) throw fail("repo must look like owner/name");
      if (request.ref !== undefined && (!REF.test(request.ref) || request.ref.includes(".."))) throw fail("ref is not a branch, tag or commit name");
      const ref = (request.ref ?? "HEAD").split("/").map(encodeURIComponent).join("/");
      const sha = (await getJson(`https://api.github.com/repos/${request.repo}/commits/${ref}`, signal))?.sha;
      if (typeof sha !== "string" || !SHA.test(sha)) throw fail("GitHub did not resolve the ref to a commit");
      name = `${safeSegment(request.repo)}@${sha}`;
      label = `${request.repo} at ${sha}${request.ref ? ` (${request.ref})` : ""}`;
      archiveUrl = `https://codeload.github.com/${request.repo}/tar.gz/${sha}`;
    } else {
      if (!NPM.test(request.npm!) || request.npm!.length > 214) throw fail("npm must be a valid package name");
      if (request.version !== undefined && !VERSION.test(request.version)) throw fail("version is not a version or dist-tag");
      const meta = await getJson(`https://registry.npmjs.org/${request.npm!.replace("/", "%2F")}/${request.version ?? "latest"}`, signal);
      if (typeof meta?.version !== "string" || !VERSION.test(meta.version) || typeof meta?.dist?.tarball !== "string") throw fail("the registry gave no tarball for that version");
      name = `npm__${safeSegment(request.npm!)}@${meta.version}`;
      label = `npm ${request.npm}@${meta.version}`;
      archiveUrl = meta.dist.tarball;
    }
    const paths = request.paths?.length ? cleanPaths(request.paths) : [];
    if (paths.length) name += `+${createHash("sha256").update(paths.join("\n")).digest("hex").slice(0, 8)}`;
    const target = join(options.dir, name);
    const exists = await lstat(target).then(() => true, () => false);
    let skipped = 0;
    if (!exists) {
      await mkdir(options.dir, { recursive: true });
      const stage = join(options.dir, `.stage-${randomBytes(6).toString("hex")}`);
      try {
        skipped = await unpack(archiveUrl, stage, signal);
        await survey(stage);
        if (paths.length) {
          const kept = `${stage}-kept`;
          try {
            for (const path of paths) {
              if (!await lstat(join(stage, path)).then(entry => entry.isDirectory() || entry.isFile(), () => false)) {
                const top = (await readdir(stage, { withFileTypes: true })).map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name).sort().slice(0, 60);
                throw fail(`${path} is not in the archive; its top level is: ${top.join(", ")}`);
              }
              await mkdir(join(kept, posix.dirname(path)), { recursive: true });
              await rename(join(stage, path), join(kept, path));
            }
            await rename(kept, target);
          } finally { await rm(kept, { recursive: true, force: true }); }
        } else await rename(stage, target);
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    taken.add(key);
    const { files, bytes, lines } = await survey(target);
    const definitions = (await readdir(target, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^(instructions?|processor|generated)$/i.test(entry.name))
      .map(entry => posix.join(relative(target, entry.parentPath).split(sep).join("/"), entry.name)).sort().slice(0, 12);
    return `${label}\nLocal path: ${target}\n${files} files, ${bytes} bytes${paths.length ? `, only ${paths.join(", ")}` : ""}${skipped ? `, ${skipped} symlinks or hard links left out` : ""}. A reference copy outside the task, not part of its code.\n`
      + `Search it with bash, for example grep -rn "enum .*Instruction" ${target}, and read files with cat or sed -n.${definitions.length ? `\nInstruction and builder folders: ${definitions.join(", ")}` : ""}\nTop level:\n${wrapUntrusted("source_fetch", lines.join("\n"), 4_000, "a downloaded source archive")}`;
  }

  return { fetchSource, resetBudget: () => taken.clear() };
}
