// Verdict report. Runs the full diagnostic on a pasted token and assembles
// the result into three sections on every run: Checked, Not checked, and
// Cannot prove. The headline is either "No known issues found." or "Hold,
// here is why." Any error or unknown state lands on AMBER, never the clean
// headline. A clean headline is never the default when something errors.
// The report names which check did the work, so a reader can see whether
// the residue screen, the DLEQ check, or the mint checks caught the problem.
// Report copy never uses the banned words safe, guaranteed, secure, or
// verified safe.
import { parseTokenRaw, type RawToken } from './rawParser.js';
import {
  decodeAndReconcile,
  type DecodedToken,
  type DecodeResult,
} from './decoder.js';
import {
  screenResidues,
  RESIDUE_COVERAGE,
  type LabelledKeyset,
} from './residue.js';
import { getMintFacts, type MintFacts } from './mintFacts.js';
import { checkKeysetDerivation, type KeysetDerivationCheck } from './keysetDerivation.js';
import { verifyProofDleq, type DleqCheck, type DleqProofInput, type KeysetKeys } from './dleq.js';
import {
  checkProofState,
  CHECKSTATE_PRIVACY_COPY,
  type CheckstateResult,
} from './checkstate.js';
import { fetchMintJson, mintEndpointUrl, isRecord, type FetchFn } from './fetch.js';
import { classifyKeysetVersion } from './keysetVersion.js';

export type ReportSeverity = 'none' | 'amber' | 'red';

export interface ReportCheck {
  // Short name for the check, e.g. "Token decode", "Residue screen".
  name: string;
  // Which module did the work, so the report names it: decode, residue,
  // derivation, dleq, checkstate, mint.
  checkId: 'decode' | 'residue' | 'derivation' | 'dleq' | 'checkstate' | 'mint';
  // What it measured, in plain words.
  result: string;
  // 'pass' when the check ran and found nothing wrong, 'flag' when it
  // found something, 'not-checked' when it could not run, 'error' when
  // the check itself failed.
  outcome: 'pass' | 'flag' | 'not-checked' | 'error';
  severity: ReportSeverity;
  message: string;
}

export interface NutCheckReport {
  headline: 'No known issues found.' | 'Hold, here is why.';
  severity: ReportSeverity;
  mint: string | undefined;
  unit: string | undefined;
  // Every run has all three sections, even when they are short.
  checked: ReportCheck[];
  notChecked: ReportCheck[];
  cannotProve: string[];
}

export const CANNOT_PROVE: readonly string[] = [
  'Mint honesty: a mint that owns its key passes DLEQ, so a valid signature does not prove the mint is honest.',
  'Mint solvency: nothing here shows whether the mint holds the funds to redeem these proofs.',
  'Future spend state: a proof unspent now can be spent later; checkstate is a snapshot from the mint at one moment.',
  'Collisions outside the supplied lists: the residue screen covers only the keyset lists supplied, it cannot prove that no collision exists elsewhere.',
];

export const BANNED_WORDS: readonly string[] = ['safe', 'guaranteed', 'secure', 'verified safe'];

export interface DiagnoseOptions {
  // The fetch implementation. Defaults to the global fetch.
  fetchFn?: FetchFn;
  // Checkstate only runs when this is true. The privacy copy must be
  // shown to the user before consent is asked for; that ordering is the
  // caller's job, and this function refuses to send checkstate without
  // the flag.
  consent?: boolean;
  // Keysets the caller already knows about, labelled as known. They are
  // screened for residue collisions alongside the token and mint lists.
  // Empty by default.
  knownKeysets?: readonly string[];
}

async function fetchKeysForDleq(
  mintUrl: string,
  tokenMintUrl: string,
  keysetIds: readonly string[],
  fetchFn: FetchFn,
): Promise<Map<string, KeysetKeys>> {
  const byId = new Map<string, KeysetKeys>();
  // Fetch the keys for each token keyset individually via /v1/keys/{id}.
  // GET /v1/keys returns only ACTIVE keysets (NUT-01), so a token whose
  // proofs belong to a rotated (inactive) keyset would be missed. The
  // per-keyset endpoint returns the keys for any keyset, active or not.
  for (const id of keysetIds) {
    let raw: unknown;
    try {
      raw = await fetchMintJson(
        mintEndpointUrl(mintUrl, `/v1/keys/${id}`),
        tokenMintUrl,
        {},
        fetchFn,
      );
    } catch {
      continue;
    }
    if (!isRecord(raw) || !Array.isArray(raw.keysets)) {
      continue;
    }
    for (const entry of raw.keysets) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !isRecord(entry.keys)) {
        continue;
      }
      const keys: Record<string, string> = {};
      for (const [amount, pubkey] of Object.entries(entry.keys)) {
        if (typeof pubkey === 'string') {
          keys[amount] = pubkey;
        }
      }
      byId.set(entry.id.toLowerCase(), {
        id: entry.id,
        unit: typeof entry.unit === 'string' ? entry.unit : '',
        keys,
      });
    }
  }
  return byId;
}

function headlineFor(checks: ReportCheck[]): {
  headline: NutCheckReport['headline'];
  severity: ReportSeverity;
} {
  let severity: ReportSeverity = 'none';
  for (const check of checks) {
    if (check.severity === 'red') {
      severity = 'red';
      break;
    }
    if (check.severity === 'amber') {
      severity = 'amber';
    }
  }
  if (severity === 'none') {
    return { headline: 'No known issues found.', severity: 'none' };
  }
  return { headline: 'Hold, here is why.', severity };
}

function toText(report: NutCheckReport): string {
  const lines: string[] = [];
  // The header carries no mint URL: the URL is token-supplied data,
  // and a mint whose URL contains a banned word must not put that word
  // into the verdict copy. The mint is identified by a short
  // fingerprint of its URL instead, and the full URL stays in the
  // report's mint field. "The whole report" therefore means every
  // field of the report object except the raw mint URL, which is
  // represented by its fingerprint: the fingerprint lets a reader
  // match the export to the report object's mint field without ever
  // printing untrusted mint text.
  lines.push('NutCheck report');
  lines.push(`Mint: ${report.mint === undefined ? '(unknown)' : mintFingerprint(report.mint)}`);
  lines.push(`Unit: ${report.unit ?? '(unknown)'}`);
  lines.push(`Headline: ${report.headline}`);
  lines.push(`Severity: ${report.severity}`);
  lines.push('');
  lines.push('Checked:');
  if (report.checked.length === 0) {
    lines.push('  (nothing)');
  }
  for (const check of report.checked) {
    lines.push(`  - ${check.name} [${check.checkId}] [${check.outcome}]${severityTag(check.severity)}: ${check.result} ${check.message}`);
  }
  lines.push('');
  lines.push('Not checked:');
  if (report.notChecked.length === 0) {
    lines.push('  (nothing)');
  }
  for (const check of report.notChecked) {
    lines.push(`  - ${check.name} [${check.checkId}] [${check.outcome}]${severityTag(check.severity)}: ${check.result} ${check.message}`);
  }
  lines.push('');
  lines.push('Cannot prove:');
  for (const item of report.cannotProve) {
    lines.push(`  - ${item}`);
  }
  return lines.join('\n');
}

function severityTag(severity: string): string {
  return severity === 'none' ? '' : ` [${severity}]`;
}

function mintFingerprint(mint: string): string {
  // A non-cryptographic fingerprint (FNV-1a, 32-bit) of the mint URL,
  // so the export identifies the mint without printing the raw URL.
  // Pure TypeScript, no platform crypto, so it runs in the browser too.
  let hash = 0x811c9dc5;
  for (let i = 0; i < mint.length; i++) {
    hash ^= mint.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function diagnoseToken(
  tokenString: string,
  options: DiagnoseOptions = {},
): Promise<NutCheckReport> {
  const fetchFn: FetchFn = options.fetchFn ?? fetch;
  const consent = options.consent ?? false;
  const checked: ReportCheck[] = [];
  const notChecked: ReportCheck[] = [];

  let raw: RawToken;
  try {
    raw = await parseTokenRaw(tokenString);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'the token could not be parsed';
    const report: NutCheckReport = {
      headline: 'Hold, here is why.',
      severity: 'amber',
      mint: undefined,
      unit: undefined,
      checked: [],
      notChecked: [
        {
          name: 'Token decode',
          checkId: 'decode',
          result: 'the token could not be parsed',
          outcome: 'error',
          severity: 'amber',
          message,
        },
      ],
      cannotProve: [...CANNOT_PROVE],
    };
    return report;
  }

  const mint = raw.mints.length === 1 ? raw.mints[0] : undefined;
  const unit = raw.unit;

  if (raw.mints.length !== 1 || !mint) {
    notChecked.push({
      name: 'Token decode',
      checkId: 'decode',
      result: 'the token names more than one mint or no mint',
      outcome: 'error',
      severity: 'amber',
      message: 'multi-mint tokens are rejected, so no further check ran',
    });
    const { headline, severity } = headlineFor([...checked, ...notChecked]);
    return { headline, severity, mint, unit, checked, notChecked, cannotProve: [...CANNOT_PROVE] };
  }

  // Mint facts first: the keyset list for decoding comes from the mint.
  let facts: MintFacts;
  try {
    facts = await getMintFacts(mint, mint, fetchFn);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'the mint facts could not be fetched';
    notChecked.push({
      name: 'Mint facts',
      checkId: 'mint',
      result: 'the mint did not answer',
      outcome: 'error',
      severity: 'amber',
      message,
    });
    const { headline, severity } = headlineFor([...checked, ...notChecked]);
    return { headline, severity, mint, unit, checked, notChecked, cannotProve: [...CANNOT_PROVE] };
  }

  if (facts.status === 'ok') {
    // The mint's name and version are not interpolated here: they are
    // untrusted mint-supplied strings, and a mint that names itself
    // with a banned word must not put that word into the report copy.
    // The mint URL is in the report already, so the mint is identified.
    checked.push({
      name: 'Mint facts',
      checkId: 'mint',
      result: `the mint answered, ${facts.keysets.length} keysets listed`,
      outcome: 'pass',
      severity: 'none',
      message: facts.findings.length > 0 ? `note: ${facts.findings.join('; ')}` : 'the mint metadata read cleanly',
    });
  } else {
    notChecked.push({
      name: 'Mint facts',
      checkId: 'mint',
      result: 'the mint did not answer',
      outcome: 'error',
      severity: 'amber',
      message: facts.error ?? 'the mint facts could not be fetched',
    });
    // The mint did not answer, so there is no keyset list and nothing
    // further to check. Return here instead of also pushing a Token
    // decode entry that says the same thing.
    const { headline, severity } = headlineFor([...checked, ...notChecked]);
    return { headline, severity, mint, unit, checked, notChecked, cannotProve: [...CANNOT_PROVE] };
  }

  // Decode with the mint's keyset list. If the mint did not answer, the
  // keyset list is missing, and decoding waits: the report records that
  // keyset context is missing instead of falling back to the token's own
  // short IDs, which are not the mint's full list.
  const keysetIds = facts.keysets.map((k) => k.id);
  if (keysetIds.length === 0) {
    notChecked.push({
      name: 'Token decode',
      checkId: 'decode',
      result: 'the mint did not supply a keyset list, so the token was not decoded',
      outcome: 'not-checked',
      severity: 'amber',
      message: 'decoding needs the mint\'s full keyset list; the token names keysets but the mint did not answer',
    });
    const { headline, severity } = headlineFor([...checked, ...notChecked]);
    return { headline, severity, mint, unit, checked, notChecked, cannotProve: [...CANNOT_PROVE] };
  }
  let decode: DecodeResult;
  try {
    decode = await decodeAndReconcile(tokenString, keysetIds);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'the token could not be decoded';
    notChecked.push({
      name: 'Token decode',
      checkId: 'decode',
      result: 'the token could not be decoded',
      outcome: 'error',
      severity: 'amber',
      message,
    });
    const { headline, severity } = headlineFor([...checked, ...notChecked]);
    return { headline, severity, mint, unit, checked, notChecked, cannotProve: [...CANNOT_PROVE] };
  }

  if (decode.status === 'decoded') {
    const token: DecodedToken = decode.token;
    checked.push({
      name: 'Token decode',
      checkId: 'decode',
      result: `decoded ${token.proofs.length} proof${token.proofs.length === 1 ? '' : 's'}${token.unit ? `, unit ${token.unit}` : ''}`,
      outcome: 'pass',
      severity: 'none',
      message: decode.findings.length > 0 ? decode.findings.map((f) => f.message).join('; ') : 'the token parsed cleanly',
    });
    // Findings from reconciliation (incomplete DLEQ, V3) go to Not checked
    // when they mean a check could not run.
    for (const finding of decode.findings) {
      if (finding.code === 'dleq-incomplete') {
        notChecked.push({
          name: 'DLEQ',
          checkId: 'dleq',
          result: 'a proof carries an incomplete DLEQ',
          outcome: 'not-checked',
          severity: 'amber',
          message: finding.message,
        });
      }
    }
  } else if (decode.status === 'v3-not-checked') {
    // A V3-only token lands on AMBER: its signature was not verified,
    // and that is an unknown state: an unverified signature never earns the clean headline. The V3 DLEQ and
    // derivation checks stay severity none, so the same limitation is
    // not counted three times; this one entry carries it.
    notChecked.push({
      name: 'Token decode',
      checkId: 'decode',
      result: 'the token carries a V3 keyset',
      outcome: 'not-checked',
      severity: 'amber',
      message: 'V3 signatures are not checked; the proof facts are shown but the signatures are not verified',
    });
    // Findings from reconciliation (incomplete DLEQ) go to Not checked
    // when they mean a check could not run. A stripped DLEQ on a V1/V2
    // proof inside a v3-not-checked token must land on AMBER, never
    // silently dropped.
    for (const finding of decode.findings) {
      if (finding.code === 'dleq-incomplete') {
        notChecked.push({
          name: 'DLEQ',
          checkId: 'dleq',
          result: 'a proof carries an incomplete DLEQ',
          outcome: 'not-checked',
          severity: 'amber',
          message: finding.message,
        });
      }
    }
  } else {
    notChecked.push({
      name: 'Token decode',
      checkId: 'decode',
      result: 'the token could not be decoded',
      outcome: 'error',
      severity: 'amber',
      message: decode.findings.map((f) => f.message).join('; '),
    });
    const { headline, severity } = headlineFor([...checked, ...notChecked]);
    return { headline, severity, mint, unit, checked, notChecked, cannotProve: [...CANNOT_PROVE] };
  }

  // Resolve token keyset IDs against the mint's full list. A v4 token
  // can carry a short keyset ID in the CBOR (16 hex chars), while the
  // mint lists the full ID (66 hex for V2/V3). A short ID is resolved
  // to the full ID only when the mint's list has an exact match, or
  // exactly one entry that starts with it. If several entries share
  // the prefix, the short ID is ambiguous and is kept as-is, so a
  // malicious mint cannot steer the resolution to the wrong keyset.
  function resolveTokenKeysetIds(
    rawIds: readonly string[],
    mintKeysets: readonly { id: string }[],
  ): string[] {
    const resolved: string[] = [];
    for (const rawId of rawIds) {
      const lower = rawId.toLowerCase();
      const exact = mintKeysets.find((k) => k.id.toLowerCase() === lower);
      if (exact) {
        resolved.push(exact.id);
        continue;
      }
      const prefixMatches = mintKeysets.filter((k) =>
        k.id.toLowerCase().startsWith(lower),
      );
      const unique = [...new Set(prefixMatches.map((k) => k.id.toLowerCase()))];
      resolved.push(unique.length === 1 ? prefixMatches[0].id : rawId);
    }
    return [...new Set(resolved)];
  }

  // Residue screen over the token keysets, the mint keysets, and any
  // known keysets the caller supplied. The token keyset IDs come from
  // the decoded token's proofs, which hold the full IDs resolved against
  // the mint's list, not the raw CBOR short IDs, which can be 7-byte
  // short forms on v4 tokens. For a v3-not-checked token, the raw IDs
  // are resolved against the mint's list.
  const tokenKeysetIds: string[] =
    decode.status === 'decoded'
      ? [...new Set(decode.token.proofs.map((p) => p.id))]
      : resolveTokenKeysetIds(raw.keysetIds, facts.keysets);
  const labelled: LabelledKeyset[] = [];
  for (const id of tokenKeysetIds) {
    labelled.push({ id, source: 'token' });
  }
  for (const k of facts.keysets) {
    labelled.push({ id: k.id, source: 'mint' });
  }
  for (const id of options.knownKeysets ?? []) {
    labelled.push({ id, source: 'known' });
  }
  const residue = screenResidues(labelled);
  if (residue.collisions.length === 0) {
    checked.push({
      name: 'Residue screen',
      checkId: 'residue',
      result: `no two different V1 keyset IDs in the supplied lists share a residue${residue.excluded.length > 0 ? `; ${residue.excluded.length} keyset${residue.excluded.length === 1 ? '' : 's'} excluded: V2 keysets are excluded because the NUT-13 residue collision applies to the legacy BIP32 derivation (V1), while V2 secret derivation uses HMAC-SHA256 over the full 33-byte keyset ID, so the 31-bit residue reduction does not apply, and V3 keysets use BLS12-381` : ''}`,
      outcome: 'pass',
      severity: 'none',
      message: RESIDUE_COVERAGE,
    });
  } else {
    for (const collision of residue.collisions) {
      const ids = collision.keysets.map((k) => `${k.id} (${k.source})`).join(', ');
      const rel = collision.relationships.includes('token-known')
        ? 'a token keyset collides with a known keyset'
        : collision.relationships.includes('token-mint')
          ? 'a token keyset collides with a mint keyset'
          : collision.relationships.includes('mint-known')
            ? 'a mint keyset collides with a known keyset'
            : 'two keysets from the same source collide';
      const excludedNote =
        residue.excluded.length > 0
          ? ` ${residue.excluded.length} keyset${residue.excluded.length === 1 ? '' : 's'} excluded from this screen: V2 keysets are excluded because the NUT-13 residue collision applies to the legacy BIP32 derivation (V1), while V2 secret derivation uses HMAC-SHA256 over the full 33-byte keyset ID, so the 31-bit residue reduction does not apply, and V3 keysets use BLS12-381.`
          : '';
      checked.push({
        name: 'Residue screen',
        checkId: 'residue',
        result: `COLLISION: residue ${collision.residue} shared by ${ids}`,
        outcome: 'flag',
        severity: 'amber',
        message: `${rel}.${excludedNote} ${RESIDUE_COVERAGE}`,
      });
    }
  }

  // Keyset ID derivation, for each keyset the token references (full
  // resolved IDs from the decoded token, not the raw short IDs).
  let derivation: KeysetDerivationCheck[] = [];
  try {
    derivation = await checkKeysetDerivation(mint, mint, fetchFn, tokenKeysetIds);
  } catch (err) {
    notChecked.push({
      name: 'Keyset ID derivation',
      checkId: 'derivation',
      result: 'the derivation check could not run',
      outcome: 'error',
      severity: 'amber',
      message: err instanceof Error ? err.message : 'the derivation check failed',
    });
  }
  for (const check of derivation) {
    if (check.result === 'match') {
      checked.push({
        name: 'Keyset ID derivation',
        checkId: 'derivation',
        result: `keyset ${check.advertisedId} recomputes to ${check.derivedId}`,
        outcome: 'pass',
        severity: 'none',
        message: 'the advertised ID matches the keys',
      });
    } else if (check.result === 'mismatch') {
      checked.push({
        name: 'Keyset ID derivation',
        checkId: 'derivation',
        result: `keyset ${check.advertisedId} does not match the recomputed ID ${check.derivedId ?? 'unknown'}`,
        outcome: 'flag',
        severity: 'amber',
        message: check.detail,
      });
    } else {
      // A V3 keyset (BLS12-381) is a known limitation, not a problem:
      // V3 derivation is not checked here, so it is not-checked with
      // severity none, like the V3 DLEQ check. Any other unknown result
      // (keys could not be fetched, malformed) is amber.
      const isV3 = classifyKeysetVersion(check.advertisedId) === 'v3';
      notChecked.push({
        name: 'Keyset ID derivation',
        checkId: 'derivation',
        result: `keyset ${check.advertisedId} could not be checked`,
        outcome: 'not-checked',
        severity: isV3 ? 'none' : 'amber',
        message: check.detail,
      });
    }
  }

  // DLEQ verification, for each proof that carries one. The keys come
  // from the mint's /v1/keys. A proof already flagged as incomplete by
  // reconciliation is not reported twice: the reconciliation entry
  // covers it. When the keys could not be fetched (keyset undefined),
  // DLEQ cannot be verified, and that is an unknown state, so it lands
  // on AMBER, never the clean headline. The keys are only fetched when
  // at least one proof still needs verification. A v3-not-checked token
  // also runs this loop: its V1/V2 proofs are verified, and its V3
  // proofs are labelled not-checked (benign) by verifyProofDleq. The
  // raw proofs of a v3-not-checked token are normalized to the same
  // shape as decoded proofs (a DLEQ block is present only when e, s,
  // and r are all there).
  if (decode.status === 'decoded' || decode.status === 'v3-not-checked') {
    const proofs: DleqProofInput[] =
      decode.status === 'decoded'
        ? decode.token.proofs
        : decode.proofs.map((p) => {
            const e = p.dleq.present ? p.dleq.eHex : undefined;
            const s = p.dleq.present ? p.dleq.sHex : undefined;
            const r = p.dleq.present ? p.dleq.rHex : undefined;
            return {
              amount: p.amount,
              id: p.id,
              secret: p.secret,
              C: p.C,
              dleq: e && s && r ? { e, s, r } : undefined,
            };
          });
    const incompleteProofs = new Set(
      decode.findings.filter((f) => f.code === 'dleq-incomplete').map((f) => f.proofIndex),
    );
    const needsKeys = proofs.some(
      (_, i) =>
        !incompleteProofs.has(i) &&
        proofs[i].dleq !== undefined &&
        classifyKeysetVersion(proofs[i].id) !== 'v3',
    );
    const keysById = needsKeys
      ? await fetchKeysForDleq(mint, mint, tokenKeysetIds, fetchFn)
      : new Map();
    for (let i = 0; i < proofs.length; i++) {
      if (incompleteProofs.has(i)) {
        continue;
      }
      const proof = proofs[i];
      const keyset = keysById.get(proof.id.toLowerCase());
      const check: DleqCheck = verifyProofDleq(
        { amount: proof.amount, id: proof.id, secret: proof.secret, C: proof.C, dleq: proof.dleq },
        i,
        keyset,
      );
      if (check.outcome === 'valid') {
        checked.push({
          name: 'DLEQ',
          checkId: 'dleq',
          result: `proof ${i}: DLEQ valid`,
          outcome: 'pass',
          severity: 'none',
          message: 'key consistency only, never evidence of honesty',
        });
      } else if (check.outcome === 'invalid') {
        checked.push({
          name: 'DLEQ',
          checkId: 'dleq',
          result: `proof ${i}: DLEQ invalid`,
          outcome: 'flag',
          severity: 'red',
          message: check.message,
        });
      } else {
        // A not-checked DLEQ is AMBER unless it is one of the known
        // benign limits: a V3 keyset or an absent DLEQ. Any other reason
        // (the keys could not be fetched, the wrong keyset, a missing
        // or unusable amount key, an unusable C) means the proof cannot
        // be verified, and that is an unknown state, so it lands on
        // AMBER, never clean. A DLEQ missing a member (e, s, or r) never
        // reaches this branch: the raw parser flags it as
        // dleq-incomplete and the proof is skipped above.
        const benign =
          classifyKeysetVersion(proof.id) === 'v3' || !proof.dleq;
        notChecked.push({
          name: 'DLEQ',
          checkId: 'dleq',
          result: `proof ${i}: DLEQ ${check.outcome}`,
          outcome: 'not-checked',
          severity: benign ? 'none' : 'amber',
          message: check.message,
        });
      }
    }
  }

  // Checkstate, only with consent. The privacy copy must be shown before
  // consent is offered; that ordering is the caller's job. A v3-not-checked
  // token also runs this loop: checkstate is independent of keyset version.
  if (decode.status === 'decoded' || decode.status === 'v3-not-checked') {
    const proofs: { secret: string }[] =
      decode.status === 'decoded' ? decode.token.proofs : decode.proofs;
    if (!consent) {
      notChecked.push({
        name: 'Checkstate',
        checkId: 'checkstate',
        result: 'consent not given, so the mint was not asked',
        outcome: 'not-checked',
        severity: 'none',
        message: CHECKSTATE_PRIVACY_COPY,
      });
    } else {
      for (let i = 0; i < proofs.length; i++) {
        const proof = proofs[i];
        let state: CheckstateResult;
        try {
          state = await checkProofState(mint, mint, proof.secret, true, fetchFn);
        } catch (err) {
          notChecked.push({
            name: 'Checkstate',
            checkId: 'checkstate',
            result: `proof ${i}: the checkstate call failed`,
            outcome: 'error',
            severity: 'amber',
            message: err instanceof Error ? err.message : 'the checkstate call failed',
          });
          continue;
        }
        if (state.status === 'checked' && state.state === 'spent') {
          checked.push({
            name: 'Checkstate',
            checkId: 'checkstate',
            result: `proof ${i}: the mint reports this proof as spent`,
            outcome: 'flag',
            severity: 'red',
            message: state.message,
          });
        } else if (state.status === 'checked' && state.state === 'pending') {
          checked.push({
            name: 'Checkstate',
            checkId: 'checkstate',
            result: `proof ${i}: the mint reports this proof as pending`,
            outcome: 'flag',
            severity: 'amber',
            message: state.message,
          });
        } else if (state.status === 'checked') {
          checked.push({
            name: 'Checkstate',
            checkId: 'checkstate',
            result: `proof ${i}: the mint reports this proof as unspent`,
            outcome: 'pass',
            severity: 'none',
            message: state.message,
          });
        } else {
          notChecked.push({
            name: 'Checkstate',
            checkId: 'checkstate',
            result: `proof ${i}: not checked`,
            outcome: 'not-checked',
            severity: 'amber',
            message: state.message,
          });
        }
      }
    }
  }

  // Keyset age: shown from the mint facts when available. The age is a
  // trust signal only, never a cryptographic fact.
  const ages = facts.keysets.filter((k) => k.age && !k.age.startsWith('unknown')).length;
  if (facts.keysets.length > 0) {
    checked.push({
      name: 'Keyset age',
      checkId: 'mint',
      result: `keyset age shown for ${ages} of ${facts.keysets.length} keysets; the rest are unknown, trust signal only`,
      outcome: 'pass',
      severity: 'none',
      message: 'the keysets response carries no creation timestamp, so age is a trust signal only when a first-seen time is known',
    });
  }

  const { headline, severity } = headlineFor([...checked, ...notChecked]);
  return { headline, severity, mint, unit, checked, notChecked, cannotProve: [...CANNOT_PROVE] };
}

export function reportToText(report: NutCheckReport): string {
  return toText(report);
}

export function scanReportCopy(text: string): string[] {
  const found: string[] = [];
  for (const word of BANNED_WORDS) {
    // Word-boundary matching, so a mint named SafeMint (a substring)
    // does not trip the scan, while a standalone banned word does.
    const pattern = new RegExp(`\\b${escapeRegExp(word.toLowerCase())}\\b`, 'i');
    if (pattern.test(text)) {
      found.push(word);
    }
  }
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
