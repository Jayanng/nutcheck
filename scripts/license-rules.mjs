// The license rules for the dependency check (scripts/check-licenses.mjs).
// A license passes only if the SPDX expression can be satisfied by known
// permissive open-source licenses. AND binds tighter than OR within a
// parenthesized group; mixing AND and OR at the same level without
// parentheses is ambiguous, so the parser rejects it (fails closed).
// Parentheses group. GPL fails when it is required in every branch; a
// choice that includes a permissive branch passes (the package can be used
// under that branch). WITH is handled: the license itself decides, the
// exception name is ignored. Two deliberate compatibility choices for real
// npm license strings: a comma separates alternatives like OR, and
// matching is case-insensitive. Anything the parser cannot prove
// permissive fails closed.
const allowed = new Set([
  'MIT',
  'Apache-2.0',
  'MPL-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'Unlicense',
  '0BSD',
  'BSL-1.0',
  'Zlib',
  'Artistic-2.0',
  'Python-2.0',
]);
const allowedUpper = new Set([...allowed].map((s) => s.toUpperCase()));

// Returns the license string for a package.json object. If `license` is a
// string, that string is used. If it is an object with a `type` field, the
// type is used. If it is an array, the entries are joined with " OR " (a
// licenses array means the package is available under any of them).
export function licenseOf(pkg) {
  if (!pkg || typeof pkg !== 'object') return 'UNKNOWN';
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === 'object' && !Array.isArray(pkg.license) && pkg.license.type) {
    return String(pkg.license.type).trim();
  }
  // An array-form license (either `license` or the deprecated `licenses`)
  // is a choice: the package is available under any of the entries.
  for (const field of [pkg.license, pkg.licenses]) {
    if (Array.isArray(field) && field.length) {
      const joined = field
        .map((l) => (typeof l === 'string' ? l : l && l.type))
        .filter(Boolean)
        .join(' OR ');
      if (joined) return joined;
    }
  }
  // A string license that reaches here is empty or whitespace-only (a
  // non-empty one returned above), so it is unknown, not a blank string.
  return 'UNKNOWN';
}

function tokenize(s) {
  const tokens = [];
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === ')') {
      if (cur) tokens.push(cur);
      cur = '';
      tokens.push(ch);
    } else if (ch === ',') {
      // A comma separates alternatives, like OR.
      if (cur) tokens.push(cur);
      cur = '';
      tokens.push('OR');
    } else if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseOr(tokens, pos) {
  let [left, next, sawAnd] = parseAnd(tokens, pos);
  while (next < tokens.length && tokens[next].toUpperCase() === 'OR') {
    const [right, after, rightSawAnd] = parseAnd(tokens, next + 1);
    // Mixing AND and OR at the same level without parentheses is ambiguous
    // (SPDX defines no precedence between them), so fail closed.
    if (sawAnd || rightSawAnd) throw new Error('mixed AND and OR without parentheses');
    left = left || right;
    next = after;
  }
  return [left, next, sawAnd];
}

function parseAnd(tokens, pos) {
  let [left, next] = parseAtom(tokens, pos);
  let sawAnd = false;
  while (next < tokens.length && tokens[next].toUpperCase() === 'AND') {
    sawAnd = true;
    const [right, after] = parseAtom(tokens, next + 1);
    left = left && right;
    next = after;
  }
  return [left, next, sawAnd];
}

function parseAtom(tokens, pos) {
  if (pos >= tokens.length) throw new Error('unexpected end of license expression');
  const tok = tokens[pos];
  if (tok === '(') {
    const [val, next] = parseOr(tokens, pos + 1);
    if (tokens[next] !== ')') throw new Error('missing closing parenthesis');
    return [val, next + 1];
  }
  if (tok === ')' || tok.toUpperCase() === 'AND' || tok.toUpperCase() === 'OR') {
    throw new Error('unexpected token ' + tok);
  }
  // A license name, optionally followed by WITH <exception>. The license
  // itself decides; the exception name does not change whether the license
  // is permissive. The exception must be a real name, not a structural
  // token (a closing paren, AND, OR, or WITH).
  let val = allowedUpper.has(tok.toUpperCase());
  let next = pos + 1;
  if (next < tokens.length && tokens[next].toUpperCase() === 'WITH') {
    if (next + 1 >= tokens.length) throw new Error('WITH without an exception');
    const exc = tokens[next + 1];
    if (exc === '(' || exc === ')' || ['AND', 'OR', 'WITH'].includes(exc.toUpperCase())) {
      throw new Error('WITH followed by a structural token');
    }
    next += 2;
  }
  return [val, next];
}

export function isAllowed(licStr) {
  const tokens = tokenize(licStr);
  if (tokens.length === 0) return false;
  try {
    const [result, pos] = parseOr(tokens, 0);
    return pos === tokens.length && result;
  } catch {
    return false;
  }
}
