import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProject } from '../src/toolchain/project.ts';
import { checkToolchain } from '../src/toolchain/check.ts';
import { planToolchainFix, applyToolchainFix } from '../src/toolchain/fix.ts';
import { verifyToolchainProject } from '../src/toolchain/verify.ts';
import { RULES, PINNED } from '../src/toolchain/rules.ts';
const healthy: Record<string,string> = {
 'Cargo.toml':'[package]\nname="healthy"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nanchor-lang="1.2.2"\nanchor-spl="1.2.2"\n',
 'Anchor.toml':'[toolchain]\nanchor_version="1.2.2"\npackage_manager="npm"\n',
 'package.json':JSON.stringify({dependencies:{'@anchor-lang/core':'1.2.2'}}),
};
const cases: {name:string;rule:keyof typeof RULES; files:Record<string,string|null>}[] = [
 {name:'Anchor CLI/crate mismatch',rule:'anchor',files:{'Cargo.toml':healthy['Cargo.toml']!.replaceAll('1.2.2','1.1.2')}},
 {name:'0.32 project on 1.x CLI',rule:'anchor',files:{'Cargo.toml':healthy['Cargo.toml']!.replaceAll('1.2.2','0.32.1')}},
 {name:'anchor-spl mismatch',rule:'anchor',files:{'Cargo.toml':healthy['Cargo.toml']!.replace('anchor-spl="1.2.2"','anchor-spl="1.1.2"')}},
 {name:'duplicate solana-program',rule:'duplicates',files:{'Cargo.lock':'version=4\n[[package]]\nname="solana-program"\nversion="2.3.0"\n[[package]]\nname="solana-program"\nversion="3.0.0"\n'}},
 {name:'legacy TS client in Anchor 1.x',rule:'client',files:{'package.json':'{"dependencies":{"@coral-xyz/anchor":"0.32.1"}}'}},
 {name:'web3.js v1 sends transaction v1',rule:'transaction',files:{'package.json':'{"dependencies":{"@solana/web3.js":"^1.99.0"}}','client.ts':'const tx = message.compileToV1Message();'}},
 {name:'old Kit creates transaction v1',rule:'transaction',files:{'package.json':'{"dependencies":{"@solana/kit":"7.1.1"}}','client.ts':'createTransactionMessage({ version: 1 });'}},
 {name:'Solana switching pin',rule:'pins',files:{'Anchor.toml':healthy['Anchor.toml']!+'solana_version="4.4.1" # wrapper refuses even this version\n'}},
 {name:'SBPFv3 requirement with wrong arch',rule:'arch',files:{'Cargo.toml':healthy['Cargo.toml']!+'[package.metadata.oms]\nrequired-sbpf-arch="v3"\n','package.json':'{"scripts":{"build":"cargo build-sbf --arch v0"}}'}},
 {name:'package manager unavailable',rule:'pins',files:{'Anchor.toml':healthy['Anchor.toml']!.replace('npm','yarn')}},
 {name:'confirmed affected Anchor release',rule:'advisory',files:{'Cargo.toml':healthy['Cargo.toml']!.replaceAll('1.2.2','1.0.1'),'Cargo.lock':'[[package]]\nname="anchor-lang"\nversion="1.0.1"\n'}},
 {name:'wrong Solana crate cohort',rule:'crates',files:{'Cargo.toml':healthy['Cargo.toml']!+'solana-pubkey="2.0.0"\n'}},
];
function fixture(files:Record<string,string|null>) {
 const root=mkdtempSync(join(tmpdir(),'oms-toolchain-check-'));
 for(const [path,text] of Object.entries({...healthy,...files})) if(text!==null) { mkdirSync(join(root,path,'..'),{recursive:true}); writeFileSync(join(root,path),text); }
 return root;
}
for(const c of cases) test(`toolchain fixture: ${c.name}`, t=>{
 const root=fixture(c.files); t.after(()=>rmSync(root,{recursive:true,force:true}));
 const report=checkToolchain(readProject(root));
 assert.ok(report.findings.some(f=>f.rule===c.rule),JSON.stringify(report));
 for(const f of report.findings) { assert.match(f.source,/^https:\/\//); assert.equal(f.date,'2026-11-08'); }
 assert.equal(report.status,'proposed, not verified');
 const plan=planToolchainFix(readProject(root));
 assert.equal(plan.status,'proposed, not verified');
 assert.ok(plan.edits.length||plan.manual.length);
});
test('healthy Anchor and unrelated JS repos report no known mismatches', t=>{
 const root=fixture({}); t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.deepEqual(checkToolchain(readProject(root)).findings,[]);
 const other=mkdtempSync(join(tmpdir(),'oms-unrelated-')); t.after(()=>rmSync(other,{recursive:true,force:true}));
 writeFileSync(join(other,'package.json'),'{"name":"unrelated"}');
 assert.deepEqual(checkToolchain(readProject(other)).findings,[]);
});
test('TOML workspace inheritance, dependency aliases and lock inventory are parsed', t=>{
 const root=fixture({'Cargo.toml':'[workspace]\nmembers=["programs/p"]\n[workspace.dependencies]\na={package="anchor-lang",version="1.1.2"}\n', 'programs/p/Cargo.toml':'[package]\nname="p"\nversion="0.1.0"\n[dependencies]\na.workspace=true\n'}); t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.ok(checkToolchain(readProject(root)).findings.some(f=>f.rule==='anchor'&&f.path==='programs/p/Cargo.toml'));
});
test('apply refuses primary checkout; linked worktree applies exact edits and detects stale preimages', t=>{
 const root=fixture({'Anchor.toml':healthy['Anchor.toml']!+'solana_version="4.4.1"\n'}); t.after(()=>rmSync(root,{recursive:true,force:true}));
 execFileSync('git',['init','-q',root]); execFileSync('git',['-C',root,'add','.']); execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']);
 assert.throws(()=>applyToolchainFix(readProject(root),planToolchainFix(readProject(root))),/linked task worktree/);
 const work=join(root,'task'); execFileSync('git',['-C',root,'worktree','add','-qb','fix-test',work]);
 const project=readProject(work),plan=planToolchainFix(project);
 applyToolchainFix(project,plan);
 assert.equal(checkToolchain(readProject(work)).findings.length,0);
 assert.throws(()=>applyToolchainFix(project,plan),/stale fix plan/);
});
test('collector refuses malformed TOML and ignores symlinked source', t=>{
 const root=fixture({}); t.after(()=>rmSync(root,{recursive:true,force:true}));
 symlinkSync('/etc/passwd',join(root,'escape.ts'));
 assert.ok(!readProject(root).files.some(f=>f.path==='escape.ts'));
 writeFileSync(join(root,'Anchor.toml'),'[bad'); assert.throws(()=>readProject(root),/TOML parsing failed/);
});

test('resolved lockfile version prevents false CVE exposure from a compatible caret requirement', t=>{
 const root=fixture({'Cargo.toml':healthy['Cargo.toml']!.replaceAll('1.2.2','^1.0.0'),'Cargo.lock':'[[package]]\nname="anchor-lang"\nversion="1.2.2"\n[[package]]\nname="anchor-spl"\nversion="1.2.2"\n'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.deepEqual(checkToolchain(readProject(root)).findings,[]);
});
test('target dependency mismatches are detected',t=>{
 const root=fixture({'Cargo.toml':'[target.\'cfg(unix)\'.dependencies]\nanchor-lang="=0.32.1"\n'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const report=checkToolchain(readProject(root));
 assert.ok(report.findings.some(f=>f.rule==='anchor'));
});
test('default CLI observations find old tools in build scripts and explicit SBPF requirements',t=>{
 const root=fixture({'Cargo.toml':healthy['Cargo.toml']!+'\n[package.metadata.oms]\nrequired-sbpf-arch="v3"\n','Anchor.toml':healthy['Anchor.toml']!+'\n[scripts]\nbuild="cargo build-sbf --tools-version v1.48 --arch v0"\n','Cargo.lock':'[[package]]\nname="blake3"\nversion="1.8.3"\n'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const report=checkToolchain(readProject(root));
 assert.ok(report.findings.some(f=>f.rule==='arch'));
});
test('unrelated solana-v4 text does not select the Anchor v4 dependency cohort',t=>{
 const root=fixture({'Cargo.toml':healthy['Cargo.toml']!+'solana-pubkey="2.0.0"\n[package.metadata]\nnotes="solana-v4"\n'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.ok(checkToolchain(readProject(root)).findings.some(f=>f.rule==='crates'));
});
test('workspace-inherited explicit Anchor v4 features select the v4 cohort',t=>{
 const root=fixture({'Cargo.toml':'[workspace]\nmembers=["programs/p"]\n[workspace.dependencies]\nanchor-lang={version="=1.2.2",features=["solana-v4"],default-features=false}\n','programs/p/Cargo.toml':'[dependencies]\nanchor-lang.workspace=true\nsolana-pubkey="4.0.0"\n'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.ok(!checkToolchain(readProject(root)).findings.some(f=>f.rule==='crates'));
});
test('dependency-free npm build scripts receive exact platform override edits',t=>{
 const root=fixture({'package.json':'{"scripts":{"build":"cargo build-sbf --tools-version v1.48"}}'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=readProject(root),report=checkToolchain(project),plan=planToolchainFix(project);
 assert.ok(report.findings.some(f=>f.path==='package.json'&&f.rule==='pins'));
 const edit=plan.edits.find(e=>e.path==='package.json'); assert.ok(edit);
 assert.equal(JSON.parse(edit.after).scripts.build,'cargo build-sbf');
});
test('exact migration proposals keep code unchanged until apply and preserve unrelated content',t=>{
 const root=fixture({'Cargo.toml':healthy['Cargo.toml']!.replaceAll('1.2.2','0.32.1'),'package.json':'{"dependencies":{"@coral-xyz/anchor":"0.32.1"},"name":"keep"}','client.ts':'import type {Idl} from "@coral-xyz/anchor/dist/cjs/idl";\n'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=readProject(root),plan=planToolchainFix(project);
 assert.equal(readFileSync(join(root,'client.ts'),'utf8'),'import type {Idl} from "@coral-xyz/anchor/dist/cjs/idl";\n');
 assert.ok(plan.edits.find(e=>e.path==='Cargo.toml')?.after.includes('anchor-lang="=1.2.2"'));
 assert.ok(plan.edits.find(e=>e.path==='client.ts')?.after.includes('"@anchor-lang/core"'));
 const packageEdit=plan.edits.find(e=>e.path==='package.json'); assert.ok(packageEdit);
 assert.equal(JSON.parse(packageEdit.after).name,'keep');
 assert.equal(JSON.parse(packageEdit.after).dependencies['@anchor-lang/core'],'1.2.2');
 assert.ok(plan.manual.length>0,'API/lockfile migration remains explicitly unverified');
});
test('optional client dependencies participate in detection and exact migration proposals',t=>{
 const root=fixture({'package.json':'{"optionalDependencies":{"@coral-xyz/anchor":"0.32.1"}}'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=readProject(root);
 assert.ok(checkToolchain(project).findings.some(f=>f.rule==='client'));
 const edit=planToolchainFix(project).edits.find(e=>e.path==='package.json'); assert.ok(edit);
 assert.equal(JSON.parse(edit.after).optionalDependencies['@anchor-lang/core'],'1.2.2');
});

 test('target-specific Anchor aliases receive exact version proposals',t=>{
 const manifest = `[target.'cfg(target_os = "linux")'.dependencies]
aliased = { package = "anchor-lang", version = "0.32.1", features = ["init-if-needed"] }
keep = "1.0.0"
[target.x86_64-unknown-linux-gnu.dev-dependencies]
spl = { package = "anchor-spl", version = "0.32.1" }
`;
 const root=fixture({'Cargo.toml':manifest});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=readProject(root);
 assert.ok(checkToolchain(project).findings.some(f=>f.rule==='anchor'));
 const edit=planToolchainFix(project).edits.find(e=>e.path==='Cargo.toml'); assert.ok(edit);
 assert.equal(edit.after,manifest.replaceAll('version = "0.32.1"',`version = "=${PINNED.anchor}"`));
 writeFileSync(join(root,'Cargo.toml'),edit.after);
 assert.ok(!checkToolchain(readProject(root)).findings.some(f=>f.rule==='anchor'));
 });

test('table-form Anchor dependencies receive version-only repair proposals',t=>{
 const manifest = `[dependencies.anchor-lang]
version = "=0.32.1"
features = ["init-if-needed"]
[target.'cfg(unix)'.dev-dependencies.alias]
package = "anchor-spl"
version = "=0.32.1"
default-features = false
`;
 const root=fixture({'Cargo.toml':manifest});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=readProject(root);
 assert.ok(checkToolchain(project).findings.some(f=>f.rule==='anchor'));
 const edit=planToolchainFix(project).edits.find(e=>e.path==='Cargo.toml'); assert.ok(edit);
 assert.equal(edit.after,manifest.replaceAll('version = "=0.32.1"',`version = "=${PINNED.anchor}"`));
 writeFileSync(join(root,'Cargo.toml'),edit.after);
 assert.ok(!checkToolchain(readProject(root)).findings.some(f=>f.rule==='anchor'));
});


test('quoted Cargo dependency keys receive exact version-only repairs',t=>{
 const manifest = `[dependencies]
"anchor-lang" = "=0.32.1"
'anchor_alias' = { package = "anchor-spl", version = "=0.32.1", default-features = false }
keep = "1.0.0"
`;
 const root=fixture({'Cargo.toml':manifest});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=readProject(root);
 assert.ok(checkToolchain(project).findings.some(f=>f.rule==='anchor'));
 const edit=planToolchainFix(project).edits.find(e=>e.path==='Cargo.toml'); assert.ok(edit);
 assert.equal(edit.after,manifest.replaceAll('"=0.32.1"',`"=${PINNED.anchor}"`));
 writeFileSync(join(root,'Cargo.toml'),edit.after);
 assert.ok(!checkToolchain(readProject(root)).findings.some(f=>f.rule==='anchor'));
});


test('target-specific aliased Anchor v4 features select the v4 cohort',t=>{
 const root=fixture({'Cargo.toml':`[target.'cfg(unix)'.dependencies]
anchor_alias = { package = "anchor-lang", version = "=1.2.2", features = ["solana-v4"], default-features = false }
solana-pubkey = "4.0.0"
`});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.deepEqual(checkToolchain(readProject(root)).findings,[]);
 writeFileSync(join(root,'Cargo.toml'),readFileSync(join(root,'Cargo.toml'),'utf8').replace('solana-pubkey = "4.0.0"','solana-pubkey = "3.0.0"'));
 assert.ok(checkToolchain(readProject(root)).findings.some(f=>f.rule==='crates'));
});

test('target-only Anchor v4 features do not change the root crate cohort',t=>{
 const root=fixture({'Cargo.toml':healthy['Cargo.toml']!+`solana-pubkey="4.0.0"
[target.'cfg(windows)'.dependencies]
v4_anchor = { package = "anchor-lang", version = "=1.2.2", features = ["solana-v4"], default-features = false }
`});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.ok(checkToolchain(readProject(root)).findings.some(f=>f.rule==='crates'));
 writeFileSync(join(root,'Cargo.toml'),readFileSync(join(root,'Cargo.toml'),'utf8').replace('solana-pubkey="4.0.0"','solana-pubkey="3.0.0"'));
 assert.deepEqual(checkToolchain(readProject(root)).findings,[]);
});

 test('quoted Anchor toolchain table receives exact pin repairs',t=>{
 const before=`# preserve this comment
["toolchain"]
anchor_version = "1.1.2"
solana_version = "4.4.1"
package_manager = "yarn"
[other]
anchor_version = "unrelated"
`;
 const root=fixture({'Anchor.toml':before}); t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=readProject(root);
 assert.ok(checkToolchain(project).findings.some(f=>f.rule==='pins'));
 const edit=planToolchainFix(project).edits.find(e=>e.path==='Anchor.toml'); assert.ok(edit);
 assert.equal(edit.after,before.replace('anchor_version = "1.1.2"',`anchor_version = "${PINNED.anchor}"`).replace('solana_version = "4.4.1"\n','').replace('package_manager = "yarn"',`package_manager = "${PINNED.packageManager}"`));
 writeFileSync(join(root,edit.path),edit.after);
 assert.ok(!checkToolchain(readProject(root)).findings.some(f=>f.rule==='pins'));
});


test('quoted Anchor toolchain keys receive exact repairs without changing other tables', t => {
 for (const quote of ['"', "'"]) {
  const before = `[toolchain]\r\n${quote}anchor_version${quote} = "1.1.2" # keep comment\r\n${quote}solana_version${quote} = "4.4.1" # unsupported pin\r\n${quote}package_manager${quote} = "yarn"\r\n[other]\r\n${quote}anchor_version${quote} = "unrelated"\r\n`;
  const root = fixture({'Anchor.toml': before});
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const project = readProject(root);
  assert.ok(checkToolchain(project).findings.some(f => f.rule === 'pins'));
  const edit = planToolchainFix(project).edits.find(e => e.path === 'Anchor.toml');
  assert.ok(edit);
  assert.equal(edit.after, before.replace('"1.1.2"', `"${PINNED.anchor}"`).replace(`${quote}solana_version${quote} = "4.4.1" # unsupported pin\r\n`, '').replace('"yarn"', `"${PINNED.packageManager}"`));
  writeFileSync(join(root, edit.path), edit.after);
  assert.deepEqual(checkToolchain(readProject(root)).findings, []);
  assert.deepEqual(planToolchainFix(readProject(root)).edits, []);
 }
});

test('workspace member Anchor features extend inherited features for cohort checks',t=>{
 const root=fixture({'Cargo.toml':`[workspace]
members=["programs/p"]
[workspace.dependencies]
anchor_alias={package="anchor-lang",version="=1.2.2",default-features=false,features=["init-if-needed"]}
`,'programs/p/Cargo.toml':`[dependencies]
anchor_alias={workspace=true,features=["solana-v4"]}
solana-pubkey="4.0.0"
`});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.deepEqual(checkToolchain(readProject(root)).findings,[]);
 const member=join(root,'programs/p/Cargo.toml');
 writeFileSync(member,readFileSync(member,'utf8').replace('solana-pubkey="4.0.0"','solana-pubkey="3.0.0"'));
 assert.ok(checkToolchain(readProject(root)).findings.some(f=>f.rule==='crates'&&f.path==='programs/p/Cargo.toml'));
});


test('workspace members can re-enable inherited Anchor default features',t=>{
 const root=fixture({'Cargo.toml':`[workspace]
members=["programs/p"]
[workspace.dependencies]
anchor_alias={package="anchor-lang",version="=1.2.2",default-features=false}
`,'programs/p/Cargo.toml':`[dependencies]
anchor_alias={workspace=true,features=["solana-v4"],default-features=true}
solana-pubkey="3.0.0"
`});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.ok(checkToolchain(readProject(root)).findings.some(f=>f.rule==='crates'&&f.path==='programs/p/Cargo.toml'&&/conflicting solana-v3 and solana-v4/.test(f.message)));
 const member=join(root,'programs/p/Cargo.toml');
 writeFileSync(member,readFileSync(member,'utf8').replace('solana-pubkey="3.0.0"','solana-pubkey="4.0.0"'));
 assert.ok(checkToolchain(readProject(root)).findings.some(f=>f.rule==='crates'&&f.path==='programs/p/Cargo.toml'&&/crate cohort/.test(f.message)));
});


test('explicit SBPFv3 metadata selects matching Cargo and Anchor repair commands',t=>{
 const root=fixture({'programs/p/Cargo.toml':'[package]\nname="p"\nversion="0.1.0"\n[package.metadata.oms]\nrequired-sbpf-arch="v3"\n'});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const plan=planToolchainFix(readProject(root));
 assert.ok(plan.commands.some(c=>JSON.stringify(c)===JSON.stringify(['cargo','build-sbf','--arch','v3'])));
 assert.ok(plan.commands.some(c=>JSON.stringify(c)===JSON.stringify(['anchor','build','--ignore-keys','--arch','v3'])));
 // Unrelated strings must not opt a build into a different architecture.
 writeFileSync(join(root,'programs/p/Cargo.toml'),'[package]\nname="p"\nversion="0.1.0"\n# required-sbpf-arch="v3"\n');
 const ordinary=planToolchainFix(readProject(root));
 assert.ok(ordinary.commands.some(c=>JSON.stringify(c)===JSON.stringify(['cargo','build-sbf'])));
 assert.ok(ordinary.commands.some(c=>JSON.stringify(c)===JSON.stringify(['anchor','build','--ignore-keys'])));
});

test('workspace dependency inheritance follows the member selected workspace',t=>{
 const root=fixture({
  'Cargo.toml':'[workspace]\nmembers=[]\n[workspace.dependencies]\nanchor-lang="=0.32.3"\n',
  'nested/Cargo.toml':'[workspace]\nmembers=["p"]\n[workspace.dependencies]\nanchor-lang="=1.2.2"\n',
  'nested/p/Cargo.toml':'[package]\nname="p"\nversion="0.1.0"\n[dependencies]\nanchor-lang.workspace=true\n',
 });
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const inherited=()=>checkToolchain(readProject(root)).inventory.find(i=>i.path==='nested/p/Cargo.toml'&&i.name==='anchor-lang')?.version;
 assert.equal(inherited(),'1.2.2');
 writeFileSync(join(root,'nested/p/Cargo.toml'),'[package]\nname="p"\nversion="0.1.0"\nworkspace="../.."\n[dependencies]\nanchor-lang.workspace=true\n');
 assert.equal(inherited(),'0.32.3');
});

test('Anchor crate cohorts stay local to each package and dependency target',t=>{
 const root=fixture({
  'Cargo.toml':'[workspace]\nmembers=["legacy","modern","native"]\n',
  'legacy/Cargo.toml':'[dependencies]\nanchor-lang="=0.32.3"\nanchor-spl="=0.32.3"\nsolana-program="2.3.0"\n',
  'modern/Cargo.toml':'[dependencies]\nanchor-lang="=1.2.2"\nanchor-spl="=1.2.2"\nsolana-program="3.0.0"\n',
  'native/Cargo.toml':'[dependencies]\nsolana-program="4.0.0"\n',
 });
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const cohortFindings=()=>checkToolchain(readProject(root)).findings.filter(f=>f.rule==='crates'||f.rule==='anchor'&&f.message.startsWith('anchor-spl'));
 assert.deepEqual(cohortFindings(),[]);
 writeFileSync(join(root,'modern/Cargo.toml'),'[dependencies]\nanchor-lang="=1.2.2"\nanchor-spl="=0.32.3"\nsolana-program="2.3.0"\n');
 assert.deepEqual(cohortFindings().map(f=>f.path),['modern/Cargo.toml','modern/Cargo.toml']);
 writeFileSync(join(root,'modern/Cargo.toml'),`[dependencies]
anchor-lang="=1.2.2"
solana-program="3.0.0"
[target.'cfg(unix)'.dependencies]
anchor-lang="=0.32.3"
anchor-spl="=0.32.3"
solana-program="2.3.0"
`);
 assert.deepEqual(cohortFindings(),[]);
});

test('build dependency Anchor cohorts do not contaminate normal dependencies',t=>{
 const root=fixture({'Cargo.toml':`[dependencies]
anchor-lang="=1.2.2"
anchor-spl="=1.2.2"
solana-program="3.0.0"
[build-dependencies]
legacy={package="anchor-lang",version="=0.32.3"}
anchor-spl="=0.32.3"
solana-sdk="2.3.0"
`});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const findings=()=>checkToolchain(readProject(root)).findings.filter(f=>f.rule==='crates'||f.rule==='anchor'&&f.message.startsWith('anchor-spl'));
 assert.deepEqual(findings(),[]);
 writeFileSync(join(root,'Cargo.toml'),`[build-dependencies]
modern={package="anchor-lang",version="=1.2.2",default-features=false,features=["solana-v4"]}
solana-pubkey="4.0.0"
`);
 assert.deepEqual(findings(),[]);
});

test('dev dependencies retain the package normal Anchor cohort fallback',t=>{
 const root=fixture({'Cargo.toml':`[dependencies]
anchor-lang="=1.2.2"
[dev-dependencies]
solana-program="2.3.0"
[build-dependencies]
solana-sdk="2.3.0"
`});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const findings=checkToolchain(readProject(root)).findings.filter(f=>f.rule==='crates');
 assert.equal(findings.length,1);
 assert.match(findings[0]!.message,/solana-program 2.3.0/);
});

test('solana-v4 selection requires Anchor 1.2.1 and mutually exclusive cohort features',t=>{
 for(const [anchor,features,defaults,warning] of [
  ['0.32.3',['solana-v4'],false,true],
  ['1.2.0',['solana-v4'],false,true],
  ['1.2.1',['solana-v4'],false,false],
  ['1.2.2',['solana-v4'],false,false],
  ['1.2.2',['solana-v4'],true,true],
  ['1.2.2',['solana-v3','solana-v4'],false,true],
 ] as const) {
  const root=fixture({'Cargo.toml':`[dependencies]\nanchor-lang={version="=${anchor}",default-features=${defaults},features=${JSON.stringify(features)}}\nsolana-program="4.0.0"\n`});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const report=checkToolchain(readProject(root));
  assert.equal(report.findings.some(f=>f.rule==='crates'&&f.message.includes('solana-v4')),warning,`${anchor} ${features} defaults=${defaults}`);
  if(!warning) assert.ok(!report.findings.some(f=>f.rule==='crates'));
 }
});


test('SBPFv3 checks honor the pinned default and locate explicit incompatible selections', t=>{
 const path='programs/p/Cargo.toml';
 const root=fixture({[path]:'[package]\nname="p"\nversion="0.1.0"\n[package.metadata.oms]\nrequired-sbpf-arch="v3"\n','Anchor.toml':null});
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const project=readProject(root);
 assert.equal(checkToolchain(project).findings.filter(f=>f.rule==='arch').length,0);
 writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{build:'cargo build-sbf --arch v0'}}));
 const mismatch=checkToolchain(readProject(root)).findings.filter(f=>f.rule==='arch');
 assert.equal(mismatch.length,1);
 assert.equal(mismatch[0]?.path,path);
});

test('SBPFv3 repair replaces incompatible script architecture flags and preserves other arguments', t=>{
 for(const [path,before,after] of [
  ['Anchor.toml', healthy['Anchor.toml']!+'\n[scripts]\nbuild="cargo build-sbf --arch v0 --locked"\n',healthy['Anchor.toml']!+'\n[scripts]\nbuild="cargo build-sbf --arch v3 --locked"\n'],
  ['package.json', JSON.stringify({scripts:{build:'cargo build-sbf --arch=v0 --locked'},name:'keep'}),JSON.stringify({scripts:{build:'cargo build-sbf --arch=v3 --locked'},name:'keep'},null,2)+'\n'],
 ] as const) {
  const root=fixture({[path]:before,'programs/p/Cargo.toml':'[package]\nname="p"\nversion="0.1.0"\n[package.metadata.oms]\nrequired-sbpf-arch="v3"\n'});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const snapshot=readProject(root);
  assert.ok(checkToolchain(snapshot).findings.some(f=>f.rule==='arch'));
  const edit=planToolchainFix(snapshot).edits.find(e=>e.path===path);
  assert.ok(edit,`missing architecture edit for ${path}`);
  assert.equal(edit.after,after);
  writeFileSync(join(root,path),edit.after);
  assert.ok(!checkToolchain(readProject(root)).findings.some(f=>f.rule==='arch'));
  assert.equal(planToolchainFix(readProject(root)).edits.length,0);
 }
 const unrelated=fixture({'package.json':JSON.stringify({scripts:{build:'cargo build-sbf --arch v0'}})});
 t.after(()=>rmSync(unrelated,{recursive:true,force:true}));
 assert.ok(!planToolchainFix(readProject(unrelated)).edits.some(e=>e.path==='package.json'));
});
test('verification failure reports the underlying error, not a generic sentence',async t=>{
 const root=fixture({'Anchor.toml':null,'Cargo.toml':'[package]\nname="a"\nversion="0.1.0"\n'}); t.after(()=>rmSync(root,{recursive:true,force:true}));
 const previous=process.env.OMS_TOOLCHAIN_IMAGE; process.env.OMS_TOOLCHAIN_IMAGE=`sha256:${'a'.repeat(64)}`;
 t.after(()=>{ if(previous===undefined) delete process.env.OMS_TOOLCHAIN_IMAGE; else process.env.OMS_TOOLCHAIN_IMAGE=previous; });
 const result=await verifyToolchainProject(root,'/nonexistent/surfpool');
 assert.equal(result.status,'proposed, not verified');
 assert.match(result.error??'',/ENOENT.*\/nonexistent\/surfpool/);
});
