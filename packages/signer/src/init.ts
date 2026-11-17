import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyBytes } from './keypair.ts';
import { toBase58 } from './encoding.ts';
import { profileIdentity, validateProfile, type DevelopmentProfile } from './profile.ts';
import { createPrivateFile, privateDirectory, syncDirectory, validateAlias } from './storage.ts';
import { SignerError } from './errors.ts';

export interface GenerateSignerKeypairOptions {
  signerDir: string;
  alias: string;
  profile: DevelopmentProfile;
}
export interface GeneratedSignerKeypair {
  alias: string;
  address: string;
  profileId: string;
}

/** Trusted host operation only. Never imports key material or accepts a key path. */
export function generateSignerKeypair(options: GenerateSignerKeypairOptions): GeneratedSignerKeypair {
  if (Object.keys(options).some((k) => !['signerDir', 'alias', 'profile'].includes(k)))
    throw new SignerError('E_BAD_REQUEST', 'unsupported key generation option');
  validateAlias(options.alias);
  const root = privateDirectory(options.signerDir);
  const profile = validateProfile(options.profile);
  const profileId = profileIdentity(profile);
  const seed = randomBytes(32);
  const bytes = new Uint8Array(64);
  try {
    const publicKey = ed25519PublicKeyBytes(ed25519PrivateKeyFromSeed(seed));
    const address = toBase58(publicKey);
    bytes.set(seed);
    bytes.set(publicKey, 32);
    createPrivateFile(join(root, `${options.alias}.key.json`), JSON.stringify(Array.from(bytes)));
    // A crash before issuance leaves an unusable orphan key, never an imported alias.
    syncDirectory(root);
    createPrivateFile(
      join(root, `${options.alias}.issuance.json`),
      JSON.stringify({
        v: 1,
        kind: 'generated-development-key',
        alias: options.alias,
        address,
        root,
        profile,
        profileId,
        issuedAt: Date.now(),
      }),
    );
    syncDirectory(root);
    return { alias: options.alias, address, profileId };
  } finally {
    seed.fill(0);
    bytes.fill(0);
  }
}
