// Keyset version classification. The first byte of the keyset id selects the
// version: 00 is V1, 01 is V2, 02 is V3 (BLS12-381). Anything else is unknown.
// V1 ids are strictly 8 bytes (16 hex characters); only V2 and V3 have a
// 33-byte full form (66 hex characters), and the short form of any version
// is 8 bytes. So a 66-character id starting with 00 is malformed and
// classifies as unknown, and a bare "02" cannot force a V3 verdict.
export type KeysetVersion = 'v1' | 'v2' | 'v3' | 'unknown';

export function classifyKeysetVersion(keysetId: string): KeysetVersion {
  if (typeof keysetId !== 'string') {
    return 'unknown';
  }
  const id = keysetId.toLowerCase();
  if (!/^[0-9a-f]+$/.test(id)) {
    return 'unknown';
  }
  if (id.length === 16) {
    const firstByte = id.slice(0, 2);
    if (firstByte === '00') {
      return 'v1';
    }
    if (firstByte === '01') {
      return 'v2';
    }
    if (firstByte === '02') {
      return 'v3';
    }
    return 'unknown';
  }
  if (id.length === 66) {
    const firstByte = id.slice(0, 2);
    if (firstByte === '01') {
      return 'v2';
    }
    if (firstByte === '02') {
      return 'v3';
    }
    return 'unknown';
  }
  return 'unknown';
}
