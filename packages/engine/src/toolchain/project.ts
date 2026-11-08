import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface ProjectFile { path: string; text: string; data?: Record<string, any> }
export interface ProjectSnapshot { root: string; files: ProjectFile[] }
const ignored = new Set(['.git', '.oms', 'node_modules', 'target', 'vendor', '.oms-cargo']);
/** Read only manifests and client sources. Never follow symlinks or execute project code. */
export function readProject(path: string): ProjectSnapshot {
  const root = realpathSync(resolve(path));
  if (!lstatSync(root).isDirectory()) throw new Error('project must be a directory');
  const files: ProjectFile[] = [];
  let bytes = 0;
  function visit(directory: string, depth: number) {
    if (depth > 12) throw new Error('project scan exceeds depth limit');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { visit(full, depth + 1); continue; }
      if (!entry.isFile() || !(/^(Anchor\.toml|Cargo\.(toml|lock)|package\.json|config(?:\.toml)?)$/.test(entry.name) || /\.(ts|tsx|js|mjs|rs)$/.test(entry.name))) continue;
      const size = lstatSync(full).size;
      if (size > 2_000_000 || (bytes += size) > 16_000_000 || files.length >= 2000) throw new Error('project scan exceeds size limit');
      files.push({ path: relative(root, full).split('\\').join('/'), text: readFileSync(full, 'utf8') });
    }
  }
  visit(root, 0);
  const tomls = files.filter(f => /\.(toml|lock)$/.test(f.path));
  if (tomls.length) {
    // Python 3.11's standard TOML parser handles workspace tables, aliases, comments and multiline values.
    // Isolated mode prevents project PYTHONPATH/sitecustomize execution. No shell or project imports.
    let parsed: Record<string, Record<string, any>>;
    try {
      parsed = JSON.parse(execFileSync('python3', ['-I', '-c', 'import json,sys,tomllib; print(json.dumps({k:tomllib.loads(v) for k,v in json.load(sys.stdin).items()}))'],
        { input: JSON.stringify(Object.fromEntries(tomls.map(f=>[f.path,f.text]))), encoding: 'utf8', timeout: 5000, maxBuffer: 32_000_000, stdio: ['pipe','pipe','pipe'] }));
    } catch { throw new Error('TOML parsing failed; valid TOML and Python >=3.11 are required (no edits made)'); }
    for (const file of tomls) file.data = parsed[file.path];
  }
  for (const file of files.filter(f=>f.path.endsWith('package.json'))) {
    try { const parsed = JSON.parse(file.text); if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error(); file.data = parsed; } catch { throw new Error(`Invalid package.json: ${file.path}`); }
  }
  return { root, files };
}
