/** Internal key primitives and trusted issued-alias loading. No arbitrary key-file import API. */

import { createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';
import { join } from 'node:path';
import { privateDirectory, readPrivateFile, validateAlias } from './storage.ts';
import { profileIdentity, validateProfile, type DevelopmentProfile } from './profile.ts';
import { toBase58 } from './encoding.ts';
import { SignerError } from './errors.ts';
import { createSecretMaterial, type SecretMaterial } from './secret.ts';

/** DER prefix that wraps a raw 32-byte ed25519 seed into PKCS#8. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface LoadedKeypair {
  secret: SecretMaterial;
  /** Solana address (base58 of the 32-byte public key). */
  address: string;
  alias: string;
  profile: DevelopmentProfile;
  profileId: string;
}

const issuedKeys = new WeakSet<LoadedKeypair>();
export function assertIssuedKeypair(keypair: LoadedKeypair): void {
  if (!issuedKeys.has(keypair)) throw new SignerError('E_KEYPAIR', 'signer requires a trusted issued alias');
}

export function ed25519PrivateKeyFromSeed(seed: Uint8Array): import('node:crypto').KeyObject {
  if (seed.length !== 32) {
    throw new SignerError('E_KEYPAIR', 'seed must be 32 bytes');
  }
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  der.set(PKCS8_ED25519_PREFIX, 0);
  der.set(seed, PKCS8_ED25519_PREFIX.length);
  return createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });
}

export function ed25519PublicKeyBytes(privateKey: import('node:crypto').KeyObject): Uint8Array {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Uint8Array.from(spki.subarray(spki.length - 32));
}

/**
 * Build SecretMaterial from a 32-byte seed. Signing happens through a closure
 * so the seed never escapes this module in raw form.
 */
function secretMaterialFromSeed(seed: Uint8Array): Pick<LoadedKeypair, 'secret' | 'address'> {
  const privateKey = ed25519PrivateKeyFromSeed(seed);
  const publicKeyBytes = ed25519PublicKeyBytes(privateKey);
  const address = toBase58(publicKeyBytes);
  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(seed, 0);
  keypairBytes.set(publicKeyBytes, 32);

  const secret = createSecretMaterial({
    keypairBytes,
    seedBytes: Uint8Array.from(seed),
    address,
    publicKeyBytes,
    sign(message: Uint8Array): Uint8Array {
      return Uint8Array.from(nodeSign(null, Buffer.from(message), privateKey));
    },
  });

  return { secret, address };
}

export function loadIssuedKeypair(options: { signerDir: string; alias: string }): LoadedKeypair {
  validateAlias(options.alias);
  const root = privateDirectory(options.signerDir);
  let issuance: Record<string, unknown>;
  try {
    issuance = JSON.parse(readPrivateFile(join(root, `${options.alias}.issuance.json`))) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SignerError) throw error;
    throw new SignerError('E_KEYPAIR', 'invalid signer issuance record');
  }
  if (
    !issuance ||
    issuance.v !== 1 ||
    issuance.kind !== 'generated-development-key' ||
    issuance.alias !== options.alias ||
    issuance.root !== root
  )
    throw new SignerError('E_KEYPAIR', 'signer issuance does not belong to this alias and trusted root');
  const profile = validateProfile(issuance.profile);
  const profileId = profileIdentity(profile);
  if (issuance.profileId !== profileId) throw new SignerError('E_KEYPAIR', 'signer issuance profile identity mismatch');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateFile(join(root, `${options.alias}.key.json`)));
  } catch (error) {
    if (error instanceof SignerError) throw error;
    throw new SignerError('E_KEYPAIR', 'invalid issued key encoding');
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
    throw new SignerError('E_KEYPAIR', 'issued key must contain 64 bytes');
  const bytes = Uint8Array.from(parsed);
  try {
    const loaded = secretMaterialFromSeed(bytes.subarray(0, 32));
    if (loaded.address !== issuance.address || toBase58(bytes.subarray(32)) !== loaded.address)
      throw new SignerError('E_KEYPAIR', 'key does not match trusted issuance address');
    const keypair = Object.freeze({ ...loaded, alias: options.alias, profile, profileId });
    issuedKeys.add(keypair);
    return keypair;
  } finally {
    bytes.fill(0);
    parsed.fill(0);
  }
}
