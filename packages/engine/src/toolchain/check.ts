import { PINNED, RULES, RULES_VERSION, type RuleId } from './rules.ts';
import type { ProjectSnapshot } from './project.ts';
import { posix } from 'node:path';
export interface Finding {
  severity: 'warning' | 'info';
  rule: RuleId;
  path: string;
  message: string;
  remedy: string;
  source: string;
  date: string;
}
export interface ToolchainReport {
  schema: string;
  status: 'proposed, not verified';
  findings: Finding[];
  facts: { anchor: string; solana: string; platformTools: string };
  inventory: { path: string; name: string; version: string }[];
}
const version = (value: unknown): string | undefined =>
  typeof value === 'string' ? /\d+\.\d+(?:\.\d+)?/.exec(value)?.[0] : undefined;
function compare(a: string, b: string): number {
  const aa = a.split('.').map(Number),
    bb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const d = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
/** Cargo's common numeric requirements; unsupported forms never establish a resolved match. */
function satisfies(actual: string, requirement: string): boolean {
  return requirement.split('||').some((alternative) =>
    alternative.split(',').every((part) => {
      const term = part.trim();
      const match = /^(\^|~|>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|\*))?(?:\.(\d+|\*))?$/.exec(term);
      if (!match) return term === '*';
      const [, op, major, minor, patch] = match;
      const lower = [major, minor === '*' ? '0' : (minor ?? '0'), patch === '*' ? '0' : (patch ?? '0')].join('.');
      const c = compare(actual, lower);
      if (op === '>=') return c >= 0;
      if (op === '>') return c > 0;
      if (op === '<=') return c <= 0;
      if (op === '<') return c < 0;
      if (op === '=') return c === 0;
      const numbers = actual.split('.').map(Number);
      if (c < 0 || numbers[0] !== Number(major)) return false;
      if (minor === '*' || minor === undefined) return true;
      if (op === '~' || major === '0' || patch === '*')
        return (
          numbers[1] === Number(minor) &&
          (major !== '0' || minor !== '0' || patch === '*' || patch === undefined || numbers[2] === Number(patch))
        );
      return true;
    }),
  );
}
export function checkToolchain(project: ProjectSnapshot): ToolchainReport {
  const facts = { anchor: PINNED.anchor, solana: PINNED.solana, platformTools: PINNED.platformTools };
  const findings: Finding[] = [],
    inventory: ToolchainReport['inventory'] = [];
  const add = (rule: RuleId, path: string, message: string, remedy: string) =>
    findings.push({
      rule,
      path,
      message,
      remedy,
      source: RULES[rule].source,
      date: RULES[rule].date,
      severity: rule === 'duplicates' ? 'info' : 'warning',
    });
  const locked: { name: string; version: string; path: string }[] = [];
  for (const file of project.files.filter((f) => f.path.endsWith('Cargo.lock')))
    for (const pkg of Array.isArray(file.data?.package) ? file.data!.package : []) {
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') locked.push({ ...pkg, path: file.path });
    }
  const resolvedVersion = (name: string, requirement: string, manifestPath: string) => {
    const nearestLock = [...new Set(locked.map((p) => p.path))]
      .filter((path) => path === 'Cargo.lock' || manifestPath.startsWith(path.slice(0, -'Cargo.lock'.length)))
      .sort((a, b) => b.length - a.length)[0];
    const candidates = [
      ...new Set(
        locked
          .filter((p) => p.path === nearestLock && p.name === name && satisfies(p.version, requirement))
          .map((p) => p.version),
      ),
    ];
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const manifests = project.files.filter((f) => f.path.endsWith('Cargo.toml'));
  const workspaceFor = (manifestPath: string) => {
    const manifest = manifests.find((f) => f.path === manifestPath);
    const selected =
      typeof manifest?.data?.package?.workspace === 'string'
        ? posix.join(posix.dirname(manifestPath), manifest.data.package.workspace, 'Cargo.toml')
        : undefined;
    return manifests
      .filter(
        (candidate) =>
          candidate.data?.workspace &&
          (selected !== undefined
            ? candidate.path === selected
            : candidate.path === 'Cargo.toml' ||
              manifestPath.startsWith(candidate.path.slice(0, -'Cargo.toml'.length))),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]?.data;
  };
  // Cargo features are additive across workspace and member declarations.
  // https://doc.rust-lang.org/cargo/reference/workspaces.html#the-dependencies-table
  // Observed 2026-11-08. Pinned Cargo lets a member re-enable defaults:
  // https://github.com/rust-lang/cargo/blob/rust-1.95.0/src/cargo/util/toml/mod.rs
  const dependency = (alias: string, raw: any, manifestPath: string): any => {
    if (!raw?.workspace) return raw;
    const inherited = workspaceFor(manifestPath)?.workspace?.dependencies?.[alias];
    if (!inherited) return undefined;
    const base = typeof inherited === 'string' ? { version: inherited } : inherited;
    return {
      ...base,
      ...(raw['default-features'] === true ? { 'default-features': true } : {}),
      features: [
        ...new Set([
          ...(Array.isArray(base.features) ? base.features : []),
          ...(Array.isArray(raw.features) ? raw.features : []),
        ]),
      ],
    };
  };
  const dependencyContexts = new Map<
    ToolchainReport['inventory'][number],
    { table: Record<string, any>; section: string; declaration: any }
  >();
  let anchorVersion: string | undefined;
  for (const file of manifests) {
    const tables = [file.data, ...Object.values(file.data?.target ?? {})] as Record<string, any>[];
    for (const table of tables)
      for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
        for (const [alias, raw] of Object.entries(table?.[section] ?? {})) {
          const dep = dependency(alias, raw, file.path);
          const name = typeof dep === 'object' ? (dep?.package ?? alias) : alias;
          const requirement = typeof dep === 'string' ? dep : dep?.version;
          const v =
            typeof requirement === 'string'
              ? (resolvedVersion(name, requirement, file.path) ?? version(requirement))
              : undefined;
          if (!v) continue;
          if (/^(anchor-|solana-|agave-)/.test(name)) {
            const item = { path: file.path, name, version: v };
            inventory.push(item);
            dependencyContexts.set(item, { table, section, declaration: dep });
          }
          if (name === 'anchor-lang') {
            anchorVersion ??= v;
            if (v !== facts.anchor)
              add(
                'anchor',
                file.path,
                `anchor-lang ${v} differs from image CLI ${facts.anchor}.`,
                `Use a matching pinned CLI image; migrating to ${PINNED.anchor} requires source review.`,
              );
          }
        }
      }
  }
  const anchorsFor = (item: ToolchainReport['inventory'][number]) => {
    const samePackage = inventory.filter((i) => i.path === item.path && i.name === 'anchor-lang');
    const context = dependencyContexts.get(item)!;
    const manifest = manifests.find((f) => f.path === item.path);
    const inSection = (section: string) => {
      const candidates = samePackage.filter((i) => dependencyContexts.get(i)?.section === section);
      const local = candidates.filter((i) => dependencyContexts.get(i)?.table === context.table);
      return local.length ? local : candidates.filter((i) => dependencyContexts.get(i)?.table === manifest?.data);
    };
    const selected = inSection(context.section);
    return selected.length || context.section !== 'dev-dependencies' ? selected : inSection('dependencies');
  };
  for (const item of inventory) {
    if (item.name === 'anchor-spl')
      for (const anchor of anchorsFor(item)) {
        if (item.version !== anchor.version)
          add(
            'anchor',
            item.path,
            `anchor-spl ${item.version} differs from anchor-lang ${anchor.version}.`,
            'Align Anchor crates and regenerate Cargo.lock.',
          );
      }
    if (
      item.name === 'anchor-lang' &&
      item.version.startsWith('1.') &&
      compare(item.version, RULES.crates.minimumV4Anchor) >= 0
    ) {
      const dep = dependencyContexts.get(item)?.declaration;
      if (
        Array.isArray(dep?.features) &&
        dep.features.includes('solana-v4') &&
        (dep['default-features'] !== false || dep.features.includes('solana-v3'))
      ) {
        add(
          'crates',
          item.path,
          `Anchor ${item.version} enables conflicting solana-v3 and solana-v4 features.`,
          'Disable default features and remove explicit solana-v3 when selecting solana-v4; review all Anchor dependencies.',
        );
      }
    }
    if (
      item.name === 'anchor-lang' &&
      locked.some((p) => p.name === 'anchor-lang' && p.version === item.version) &&
      RULES.advisory.affected.some((v) => v === item.version)
    )
      add(
        'advisory',
        item.path,
        `CVE-2026-45137: Anchor ${item.version}; ${RULES.advisory.status}.`,
        'Upgrade to a patched Anchor release after migration review.',
      );
  }
  const isAnchor = !!anchorVersion || project.files.some((f) => f.path === 'Anchor.toml');
  for (const file of project.files.filter((f) => f.path.endsWith('Anchor.toml'))) {
    const tool = file.data?.toolchain ?? {};
    if (tool.anchor_version && tool.anchor_version !== facts.anchor)
      add(
        'pins',
        file.path,
        `anchor_version ${tool.anchor_version} cannot run in the pinned ${facts.anchor} image.`,
        'Align the pin with the crate version and choose a matching image.',
      );
    if (tool.solana_version)
      add(
        'pins',
        file.path,
        `solana_version ${tool.solana_version} triggers switching; the OMS image wrapper refuses every Solana pin.`,
        'Remove this field when using the pinned OMS image; its Agave version is recorded in the runtime manifest.',
      );
    if (tool.package_manager && tool.package_manager !== PINNED.packageManager)
      add(
        'pins',
        file.path,
        `package_manager ${tool.package_manager} is outside the npm-only locked OMS dependency-fetch policy.`,
        'Use npm and commit package-lock.json; review script syntax before changing managers.',
      );
  }
  for (const item of inventory.filter((i) => i.name.startsWith('solana-'))) {
    for (const anchor of anchorsFor(item)) {
      const anchorVersion = anchor.version;
      const solanaMajor = anchorVersion.startsWith('0.32.') ? 2 : anchorVersion.startsWith('1.') ? 3 : undefined;
      const dep = dependencyContexts.get(anchor)?.declaration;
      const requestsV4 = Array.isArray(dep?.features) && dep.features.includes('solana-v4');
      const v4 =
        requestsV4 &&
        anchorVersion.startsWith('1.') &&
        compare(anchorVersion, RULES.crates.minimumV4Anchor) >= 0 &&
        !dep.features.includes('solana-v3') &&
        dep['default-features'] === false;
      if (solanaMajor && Number(item.version.split('.')[0]) !== (v4 ? 4 : solanaMajor))
        add(
          'crates',
          item.path,
          `${item.name} ${item.version} differs from the Anchor ${anchorVersion} crate cohort.${requestsV4 && !v4 ? ' Requested solana-v4 does not select the v4 cohort with this Anchor version and feature configuration.' : ''}`,
          'Review Cargo features and align direct crate requirements; regenerate the lockfile.',
        );
    }
  }
  for (const file of project.files.filter((f) => f.path.endsWith('Cargo.lock'))) {
    const names = new Map<string, Set<string>>();
    for (const pkg of locked.filter((p) => p.path === file.path && p.name.startsWith('solana-'))) {
      if (!names.has(pkg.name)) names.set(pkg.name, new Set());
      names.get(pkg.name)!.add(pkg.version);
    }
    for (const [name, versions] of names)
      if (versions.size > 1)
        add(
          'duplicates',
          file.path,
          `${name} resolves to ${[...versions].join(', ')}; possible incompatible Rust types.`,
          'Inspect cargo tree -d and align the owning dependencies; do not delete lockfile entries by hand.',
        );
  }
  const overrideFile = project.files.find(
    (f) => /\.(toml|json)$/.test(f.path) && /--tools-version(?:=|\s+)v?\d+\.\d+\b/.test(f.text),
  );
  const requestedTools = /--tools-version(?:=|\s+)v?(\d+\.\d+)\b/.exec(overrideFile?.text ?? '')?.[1];
  if (requestedTools && requestedTools !== facts.platformTools)
    add(
      'pins',
      overrideFile!.path,
      `Build script requests platform-tools ${requestedTools}; the image pins ${facts.platformTools}.`,
      'Remove the platform-tools override and use the pinned image tools.',
    );
  for (const file of project.files.filter((f) => f.path.endsWith('package.json'))) {
    const deps = {
      ...file.data?.dependencies,
      ...file.data?.devDependencies,
      ...file.data?.optionalDependencies,
      ...file.data?.peerDependencies,
    };
    if (isAnchor && anchorVersion?.startsWith('1.') && deps[RULES.client.legacyPackage])
      add(
        'client',
        file.path,
        'Anchor 1.x uses @anchor-lang/core; legacy client package found.',
        'Rename the dependency and imports, including dist/cjs/idl imports; regenerate the npm lockfile.',
      );
    const sources = project.files.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f.path));
    const sendsV1 = sources.some((f) =>
      /compileToV1Message\s*\(|createTransactionMessage\s*\(\s*\{[^}]*version\s*:\s*1\b/s.test(f.text),
    );
    if (sendsV1 && version(deps['@solana/web3.js'])?.startsWith('1.'))
      add(
        'transaction',
        file.path,
        'Client requests transaction v1 with web3.js 1.x, which cannot send v1.',
        'Migrate the sender to Kit >=8 or web3.js >=3; this requires source changes, not just a package version edit.',
      );
    const kit = version(deps['@solana/kit']);
    if (sendsV1 && kit && compare(kit, RULES.transaction.minimumKit) < 0)
      add(
        'transaction',
        file.path,
        `Kit ${kit} cannot type transaction v1 messages.`,
        'Upgrade Kit to >=8 and review client API changes.',
      );
  }
  const scripts = project.files
    .filter((f) => /\.(toml|json)$/.test(f.path))
    .map((f) => f.text)
    .join('\n');
  const selectedArch = /--arch(?:=|\s+)(v[0-4])\b/.exec(scripts)?.[1] ?? PINNED.arch;
  const archManifest = manifests.find((f) => f.data?.package?.metadata?.oms?.['required-sbpf-arch'] === 'v3');
  const requiredArch = archManifest?.data?.package?.metadata?.oms?.['required-sbpf-arch'];
  if (requiredArch === 'v3' && selectedArch !== 'v3')
    add(
      'arch',
      archManifest?.path ?? '<build>',
      `Program requires SBPFv3; selected architecture is ${selectedArch ?? 'unspecified'}.`,
      'Build with --arch v3 on compatible platform-tools; verify deployment feature support separately.',
    );
  return { schema: RULES_VERSION, status: 'proposed, not verified', facts, findings, inventory };
}
