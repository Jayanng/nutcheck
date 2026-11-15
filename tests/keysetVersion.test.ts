// Keyset version classification: the first byte of the id selects the version.
import { describe, expect, it } from 'vitest';
import { classifyKeysetVersion } from '../src/keysetVersion.js';

describe('classifyKeysetVersion', () => {
  it('classifies the official V1 vector id', () => {
    expect(classifyKeysetVersion('009a1f293253e41e')).toBe('v1');
    expect(classifyKeysetVersion('00ad268c4d1f5826')).toBe('v1');
    expect(classifyKeysetVersion('00ffd48b8f5ecf80')).toBe('v1');
  });

  it('classifies the official V2 vector id', () => {
    expect(
      classifyKeysetVersion('015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a'),
    ).toBe('v2');
  });

  it('classifies a V3 id by its first byte', () => {
    expect(classifyKeysetVersion('02' + '00'.repeat(32))).toBe('v3');
    expect(classifyKeysetVersion('02' + 'ff'.repeat(32))).toBe('v3');
  });

  it('classifies the 16-character short form the same way', () => {
    expect(classifyKeysetVersion('01' + '00'.repeat(7))).toBe('v2');
    expect(classifyKeysetVersion('02' + '00'.repeat(7))).toBe('v3');
    expect(classifyKeysetVersion('00' + '00'.repeat(7))).toBe('v1');
  });

  it('reports anything else as unknown', () => {
    expect(classifyKeysetVersion('03' + '00'.repeat(32))).toBe('unknown');
    expect(classifyKeysetVersion('ff' + '00'.repeat(7))).toBe('unknown');
    expect(classifyKeysetVersion('02')).toBe('unknown');
    expect(classifyKeysetVersion('')).toBe('unknown');
    expect(classifyKeysetVersion('not-hex')).toBe('unknown');
    expect(classifyKeysetVersion('0')).toBe('unknown');
  });

  it('rejects a 33-byte id starting with 00, since V1 ids are only 8 bytes', () => {
    expect(classifyKeysetVersion('00' + '00'.repeat(32))).toBe('unknown');
  });

  it('classifies any 66-character hex id by its first byte, V2 or V3', () => {
    expect(classifyKeysetVersion('01' + 'ab'.repeat(32))).toBe('v2');
    expect(classifyKeysetVersion('02' + 'ab'.repeat(32))).toBe('v3');
  });

  it('is case-insensitive', () => {
    expect(classifyKeysetVersion('009A1F293253E41E')).toBe('v1');
    expect(classifyKeysetVersion('015BA18A8ADCD02E715A58358EB618DA4A4B3791151A4BEE5E968BB88406CCF76A')).toBe(
      'v2',
    );
  });
});
