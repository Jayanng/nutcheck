// License rules test: the allowlist and SPDX expression check that the
// license gate runs on every dependency. If any of these fail, the gate
// itself is wrong.
import { describe, expect, it } from 'vitest';
import { isAllowed, licenseOf } from '../scripts/license-rules.mjs';

describe('license rules', () => {
  it('allows the standard permissive licenses by name', () => {
    expect(isAllowed('MIT')).toBe(true);
    expect(isAllowed('ISC')).toBe(true);
    expect(isAllowed('BSD-3-Clause')).toBe(true);
    expect(isAllowed('Apache-2.0')).toBe(true);
    expect(isAllowed('MPL-2.0')).toBe(true);
    expect(isAllowed('MIT OR Apache-2.0')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isAllowed('mit')).toBe(true);
    expect(isAllowed('MIT or Apache-2.0')).toBe(true);
    expect(isAllowed('apache-2.0')).toBe(true);
  });

  it('applies OR semantics: one permissive branch is enough', () => {
    expect(isAllowed('MIT OR GPL-2.0')).toBe(true);
    expect(isAllowed('GPL-2.0 OR MIT')).toBe(true);
    expect(isAllowed('MIT, GPL-2.0')).toBe(true);
    expect(isAllowed('(MIT AND GPL-2.0) OR Apache-2.0')).toBe(true);
    expect(isAllowed('MIT OR (Apache-2.0 AND GPL-2.0)')).toBe(true);
  });

  it('applies AND semantics: every part must be allowed', () => {
    expect(isAllowed('MIT AND Apache-2.0')).toBe(true);
    expect(isAllowed('MIT AND GPL-2.0')).toBe(false);
  });

  it('applies AND precedence: a required GPL branch fails the whole expression', () => {
    expect(isAllowed('GPL-3.0 AND (MIT OR Apache-2.0)')).toBe(false);
    expect(isAllowed('GPL-2.0 AND (MIT OR Apache-2.0)')).toBe(false);
    expect(isAllowed('(MIT OR Apache-2.0) AND GPL-2.0')).toBe(false);
  });

  it('handles WITH: the license decides, the exception is ignored', () => {
    expect(isAllowed('Apache-2.0 WITH LLVM-exception')).toBe(true);
    expect(isAllowed('GPL-2.0 WITH Classpath-exception-2.0')).toBe(false);
  });

  it('rejects mixed AND and OR without parentheses', () => {
    expect(isAllowed('MIT OR GPL-2.0 AND UNKNOWN')).toBe(false);
    expect(isAllowed('MIT AND Apache-2.0 OR GPL-2.0')).toBe(false);
    expect(isAllowed('(MIT OR GPL-2.0) AND Apache-2.0')).toBe(true);
    expect(isAllowed('MIT OR (GPL-2.0 AND UNKNOWN)')).toBe(true);
  });

  it('rejects a WITH followed by a structural token', () => {
    expect(isAllowed('(MIT WITH )')).toBe(false);
    expect(isAllowed('MIT WITH AND MIT')).toBe(false);
  });

  it('rejects GPL in every form', () => {
    expect(isAllowed('GPL-3.0')).toBe(false);
    expect(isAllowed('AGPL-3.0')).toBe(false);
    expect(isAllowed('LGPL-3.0')).toBe(false);
    expect(isAllowed('GNU General Public License v3.0')).toBe(false);
    expect(isAllowed('GNU Lesser General Public License')).toBe(false);
  });

  it('rejects non-licenses and placeholders', () => {
    expect(isAllowed('UNLICENSED')).toBe(false);
    expect(isAllowed('BUSL-1.1')).toBe(false);
    expect(isAllowed('SEE LICENSE IN LICENSE.txt')).toBe(false);
    expect(isAllowed('UNKNOWN')).toBe(false);
    expect(isAllowed('')).toBe(false);
  });

  it('treats a licenses array as a choice (OR)', () => {
    expect(licenseOf({ license: ['MIT', 'GPL-2.0'] })).toBe('MIT OR GPL-2.0');
    expect(isAllowed(licenseOf({ license: ['MIT', 'GPL-2.0'] }))).toBe(true);
    expect(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0');
    expect(isAllowed(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }))).toBe(true);
  });

  it('reads an object license and reports unknown when missing', () => {
    expect(licenseOf({ license: { type: 'MIT' } })).toBe('MIT');
    expect(licenseOf({})).toBe('UNKNOWN');
    expect(licenseOf({ licenses: [null] })).toBe('UNKNOWN');
  });
});
