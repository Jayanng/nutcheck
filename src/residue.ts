// Residue screen. Checks whether any two different V1 keyset ids in the
// supplied lists reduce to the same residue under the legacy NUT-13
// derivation, which would let a mint collide with a target keyset. The
// residue is the keyset id, read as a big-endian integer, taken mod
// (2^31 - 1). V2 and V3 keysets are excluded: their secrets do not come
// from the legacy derivation, so the residue does not apply to them. The
// screen only covers the lists supplied; it cannot prove that no collision
// exists elsewhere. A collision is reported whenever two different ids
// share a residue, whatever lists they came from. That is a residue
// overlap among the supplied sources, not automatically an attack: the
// report shows the source relationship, and a same-source overlap is
// flagged as detected but with exploitability not established by this
// check alone.
import { classifyKeysetVersion } from './keysetVersion.js';

export type KeysetSource = 'token' | 'mint' | 'known';

export interface LabelledKeyset {
  id: string;
  source: KeysetSource;
}

export interface Collision {
  residue: number;
  keysets: LabelledKeyset[];
  // The source relationships present in this collision. A collision is
  // AMBER, not RED, and a same-source overlap is flagged as detected but
  // with exploitability not established by this check alone. The report
  // uses this field to word the finding honestly.
  relationships: Array<'token-mint' | 'token-known' | 'mint-known' | 'same-source'>;
}

export interface ExcludedKeyset {
  id: string;
  source: KeysetSource;
  reason: string;
}

export interface ResidueResult {
  collisions: Collision[];
  excluded: ExcludedKeyset[];
  coverage: string;
}

const MODULUS = 2n ** 31n - 1n;

export const RESIDUE_COVERAGE =
  'This comparison covers only the keyset lists supplied. It cannot prove that no collision exists elsewhere.';

// The residue of a V1 keyset id: the id as a big-endian integer, mod (2^31 - 1).
// Only V1 ids (16 hex characters starting with 00) have a residue; V2 and V3
// use different secret derivation, so their ids are not passed here.
export function keysetResidue(keysetId: string): number {
  const id = keysetId.toLowerCase();
  if (!/^00[0-9a-f]{14}$/.test(id)) {
    throw new Error('keyset id must be a V1 id, 16 hex characters starting with 00');
  }
  return Number(BigInt(`0x${id}`) % MODULUS);
}

export function screenResidues(keysets: readonly LabelledKeyset[]): ResidueResult {
  const excluded: ExcludedKeyset[] = [];
  const byResidue = new Map<number, Map<string, LabelledKeyset[]>>();

  for (const keyset of keysets) {
    const id = keyset.id.toLowerCase();
    const version = classifyKeysetVersion(id);
    if (version === 'v2') {
      excluded.push({
        id: keyset.id,
        source: keyset.source,
        reason:
          'V2 keyset IDs use the NUT-02 SHA256 derivation, and V2 NUT-13 secret derivation is not the legacy BIP32 derivation, so the legacy residue check does not apply',
      });
      continue;
    }
    if (version === 'v3') {
      excluded.push({
        id: keyset.id,
        source: keyset.source,
        reason:
          'V3 keysets use BLS12-381, so the legacy residue does not apply',
      });
      continue;
    }
    if (version !== 'v1') {
      excluded.push({
        id: keyset.id,
        source: keyset.source,
        reason: 'this keyset id has an unknown version, so it was not screened',
      });
      continue;
    }
    const residue = keysetResidue(id);
    let group = byResidue.get(residue);
    if (!group) {
      group = new Map();
      byResidue.set(residue, group);
    }
    const existing = group.get(id);
    if (existing) {
      existing.push(keyset);
    } else {
      group.set(id, [keyset]);
    }
  }

  const collisions: Collision[] = [];
  for (const [residue, group] of byResidue) {
    // A collision needs two different keyset ids sharing a residue.
    // The same id seen twice, even from different lists, is not one.
    if (group.size < 2) {
      continue;
    }
    const keysets: LabelledKeyset[] = [];
    for (const entries of group.values()) {
      keysets.push(...entries);
    }
    // The source relationships present in this collision, so the report
    // can word the finding honestly: a token-mint overlap is the
    // NUT-13 attack shape, a same-source overlap is detected but its
    // exploitability is not established by this check alone.
    const sources = new Set(keysets.map((k) => k.source));
    const relationships: Collision['relationships'] = [];
    if (sources.has('token') && sources.has('mint')) {
      relationships.push('token-mint');
    }
    if (sources.has('token') && sources.has('known')) {
      relationships.push('token-known');
    }
    if (sources.has('mint') && sources.has('known')) {
      relationships.push('mint-known');
    }
    if (sources.size === 1) {
      relationships.push('same-source');
    }
    collisions.push({ residue, keysets, relationships });
  }

  return { collisions, excluded, coverage: RESIDUE_COVERAGE };
}
