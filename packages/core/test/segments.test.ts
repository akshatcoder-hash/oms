import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PREFIX_SEGMENTS,
  SEGMENT_ORDER,
  buildSegmentHashes,
  canonicalizeSegmentText,
  detectBust,
  hashSegment,
  isPrefixStable,
  prefixHash,
  scanForbiddenText,
  scanPrefixBlocks,
  segmentHashMap,
  sha256Hex,
  type ForbiddenRule,
  type SegmentBlocks,
} from '../src/cache/segments.ts';

const SYSTEM = 'You are oms, a Solana coding harness. Byte-stable prefix.';
const TOOLS = '{"getBalance":{"description":"returns lamports"}}';
const INDEX = 'anchor-counter | Anchor counter template | 9f2c';
const NOTES = 'Prefer simulated transactions before signing.';

function baseBlocks(): SegmentBlocks {
  return {
    system: SYSTEM,
    tool_schemas: TOOLS,
    skill_index: INDEX,
    pinned_notes: NOTES,
    epoch_head: 'epoch 1 summary',
    dynamic_tail: 'user: hello',
  };
}

test('sha256 is stable and known-answer', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(sha256Hex('abc'), sha256Hex('abc'));
  assert.notEqual(sha256Hex('abc'), sha256Hex('abd'));
});

test('hashSegment is deterministic and names the segment', () => {
  const a = hashSegment('system', SYSTEM);
  const b = hashSegment('system', SYSTEM);
  assert.deepEqual(a, b);
  assert.equal(a.name, 'system');
  assert.equal(a.bytes, Buffer.byteLength(SYSTEM, 'utf8'));
  // content_hash is sha256 of the normalized bytes only (doc section 2), so the
  // segment name is not part of it; identity comes from the (name, hash) pair.
  assert.equal(hashSegment('system', SYSTEM).hash, hashSegment('tool_schemas', SYSTEM).hash);
});

test('canonicalization erases line-ending and trailing-whitespace noise', () => {
  const cases: Array<[string, string]> = [
    ['a\r\nb\r\n', 'a\nb'],
    ['a  \nb\t\n\n', 'a\nb'],
    ['plain', 'plain'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonicalizeSegmentText(input), expected, input);
  }
  assert.equal(hashSegment('system', 'a\r\nb\r\n').hash, hashSegment('system', 'a\nb').hash);
});

test('buildSegmentHashes follows SEGMENT_ORDER and skips absent blocks', () => {
  const blocks = baseBlocks();
  delete blocks.dynamic_tail;
  const segments = buildSegmentHashes(blocks);
  assert.deepEqual(
    segments.map((segment) => segment.name),
    ['system', 'tool_schemas', 'skill_index', 'pinned_notes', 'epoch_head'],
  );
  assert.deepEqual(SEGMENT_ORDER, [
    'system',
    'tool_schemas',
    'skill_index',
    'pinned_notes',
    'epoch_head',
    'dynamic_tail',
  ]);
  assert.deepEqual(PREFIX_SEGMENTS, ['system', 'tool_schemas', 'skill_index', 'pinned_notes']);
});

test('prefixHash covers only prefix blocks', () => {
  const segments = buildSegmentHashes(baseBlocks());
  const base = prefixHash(segments);

  const tailChanged = prefixHash(
    buildSegmentHashes({ ...baseBlocks(), dynamic_tail: 'user: something else' }),
  );
  assert.equal(tailChanged, base, 'transcript tail must not move the prefix hash');

  const headChanged = prefixHash(buildSegmentHashes({ ...baseBlocks(), epoch_head: 'epoch 2 summary' }));
  assert.equal(headChanged, base, 'epoch head is transcript content, not prefix content');

  for (const segment of PREFIX_SEGMENTS) {
    const blocks = baseBlocks();
    blocks[segment] = `${blocks[segment] ?? ''}\nedited`;
    assert.notEqual(prefixHash(buildSegmentHashes(blocks)), base, `${segment} must move the prefix hash`);
  }
});

test('prefixHash is order-insensitive to input array order', () => {
  const segments = buildSegmentHashes(baseBlocks());
  const reversed = [...segments].reverse();
  assert.equal(prefixHash(reversed), prefixHash(segments));
});

test('detectBust names the first changed segment in canonical order', () => {
  const full = segmentHashMap(buildSegmentHashes(baseBlocks()));
  const cases: Array<{
    name: string;
    mutate: (map: typeof full) => void;
    expected: ReturnType<typeof detectBust>;
  }> = [
    {
      name: 'no change',
      mutate: () => {},
      expected: { busted: false, segment: null, index: -1, previousHash: null, nextHash: null },
    },
    {
      name: 'system changed',
      mutate: (map) => {
        map.system = sha256Hex('new system');
      },
      expected: {
        busted: true,
        segment: 'system',
        index: 0,
        previousHash: full.system ?? null,
        nextHash: sha256Hex('new system'),
      },
    },
    {
      name: 'index changed',
      mutate: (map) => {
        map.skill_index = sha256Hex('new index');
      },
      expected: {
        busted: true,
        segment: 'skill_index',
        index: 2,
        previousHash: full.skill_index ?? null,
        nextHash: sha256Hex('new index'),
      },
    },
    {
      name: 'tools and index changed -> tools wins',
      mutate: (map) => {
        map.tool_schemas = sha256Hex('new tools');
        map.skill_index = sha256Hex('new index');
      },
      expected: {
        busted: true,
        segment: 'tool_schemas',
        index: 1,
        previousHash: full.tool_schemas ?? null,
        nextHash: sha256Hex('new tools'),
      },
    },
    {
      name: 'segment removed',
      mutate: (map) => {
        delete map.pinned_notes;
      },
      expected: {
        busted: true,
        segment: 'pinned_notes',
        index: 3,
        previousHash: full.pinned_notes ?? null,
        nextHash: null,
      },
    },
  ];

  for (const { name, mutate, expected } of cases) {
    const next = { ...full };
    mutate(next);
    assert.deepEqual(detectBust(full, next), expected, name);
  }
});

test('detectBust is deterministic', () => {
  const a = segmentHashMap(buildSegmentHashes(baseBlocks()));
  const b = segmentHashMap(buildSegmentHashes({ ...baseBlocks(), pinned_notes: 'other' }));
  assert.deepEqual(detectBust(a, b), detectBust(a, b));
});

test('forbidden prefix content is classified', () => {
  const cases: Array<{ name: string; text: string; rule: ForbiddenRule }> = [
    { name: 'iso timestamp', text: 'generated at 2025-10-29T01:02:03Z', rule: 'timestamp' },
    { name: 'bare date', text: 'release 2025-10-29', rule: 'timestamp' },
    { name: 'epoch millis', text: 'now=1761700000000', rule: 'timestamp' },
    { name: 'uuid', text: 'session 7f9c2ba4-3d1e-4c2a-9b8f-0a1b2c3d4e5f', rule: 'uuid' },
    { name: 'request id', text: 'request_id = abcd1234ef', rule: 'request_id' },
    { name: 'session id', text: 'sessionId: 9f8e7d6c5b', rule: 'session_id' },
    { name: 'pid', text: 'pid: 4321', rule: 'process_id' },
    { name: 'ls total', text: 'total 24', rule: 'directory_listing' },
    { name: 'ls row', text: 'drwxr-xr-x  4 alice  staff  128 Oct 29 01:05 src', rule: 'directory_listing' },
    { name: 'absolute path', text: 'see /Users/alice/Developer/oms/README.md', rule: 'absolute_path' },
    { name: 'windows path', text: 'C:\\Users\\alice\\oms', rule: 'absolute_path' },
  ];
  for (const { name, text, rule } of cases) {
    const hits = scanForbiddenText(text);
    assert.ok(hits.length > 0, `expected a hit for ${name}`);
    assert.ok(
      hits.some((hit) => hit.rule === rule),
      `${name}: expected ${rule}, got ${hits.map((hit) => hit.rule).join(',')}`,
    );
    for (const hit of hits) {
      assert.ok(hit.excerpt.length > 0 && hit.excerpt.length <= 72, `${name}: excerpt length`);
      assert.ok(!hit.excerpt.includes('\n'), `${name}: excerpt must be one line`);
      assert.ok(hit.index >= 0, `${name}: index`);
    }
  }
});

test('forbidden scanner leaves stable prefix text alone', () => {
  const stable = [
    SYSTEM,
    TOOLS,
    INDEX,
    NOTES,
    'Skills: anchor-vault | Vault patterns | 0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    'sha256: 9f2c1b4a7d6e5f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708',
    '{"name":"getBalance","input":{"account":"string"}}',
    'Rule: never sign on mainnet without typed confirmation.',
  ];
  for (const text of stable) {
    assert.deepEqual(scanForbiddenText(text), [], text);
  }
});

test('scanPrefixBlocks names the offending segment and ignores the tail', () => {
  const blocks: SegmentBlocks = {
    ...baseBlocks(),
    tool_schemas: `${TOOLS}\n// cached at 2025-10-29T01:02:03Z`,
    dynamic_tail: 'user asked at 2025-10-29T01:02:03Z',
  };
  const hits = scanPrefixBlocks(blocks);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.segment, 'tool_schemas');
  assert.equal(hits[0]?.rule, 'timestamp');
  assert.equal(isPrefixStable(blocks), false);
  assert.equal(isPrefixStable(baseBlocks()), true);
});

test('forbidden scan reports every offending segment in canonical order', () => {
  const blocks: SegmentBlocks = {
    system: 'built 2025-10-29',
    pinned_notes: 'opus 7f9c2ba4-3d1e-4c2a-9b8f-0a1b2c3d4e5f',
  };
  const hits = scanPrefixBlocks(blocks);
  assert.deepEqual(
    hits.map((hit) => [hit.segment, hit.rule]),
    [
      ['system', 'timestamp'],
      ['pinned_notes', 'uuid'],
    ],
  );
});

test('segment hashing is deterministic for the same blocks', () => {
  assert.deepEqual(buildSegmentHashes(baseBlocks()), buildSegmentHashes(baseBlocks()));
  assert.deepEqual(scanPrefixBlocks(baseBlocks()), scanPrefixBlocks(baseBlocks()));
});
