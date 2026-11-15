// License check: every installed dependency must declare a known, allowed license.
// The rule is no GPL linkage, and the check is an allowlist (see
// license-rules.mjs): a license passes only if every part of its SPDX
// expression is a known permissive open-source license. Anything else (GPL in
// any form, UNLICENSED, a business-source license, a placeholder, or a missing
// license) fails. The scan walks node_modules recursively, so nested
// dependencies are covered too. The repo itself must carry a LICENSE file at
// the root. Run with `npm run licenses`.
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenseOf, isAllowed } from './license-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkNodeModules(dir, out, seen) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Accept plain directories and symlinks (linked or workspace packages).
    if ((!e.isDirectory() && !e.isSymbolicLink()) || e.name === '.bin') continue;
    const sub = path.join(dir, e.name);
    // Guard against symlink cycles: skip a directory already visited by its
    // canonical path. This covers scoped dirs too.
    let real = sub;
    try {
      real = realpathSync(sub);
    } catch {
      real = sub;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    if (e.name.startsWith('@')) {
      walkNodeModules(sub, out, seen);
      continue;
    }
    const pj = path.join(sub, 'package.json');
    if (existsSync(pj)) out.push(pj);
    const nested = path.join(sub, 'node_modules');
    if (existsSync(nested)) walkNodeModules(nested, out, seen);
  }
}

const bad = [];
const other = [];

if (!existsSync(path.join(root, 'LICENSE'))) {
  bad.push('repo root: no LICENSE file');
}

const dir = path.join(root, 'node_modules');
if (!existsSync(dir)) {
  console.error('License check FAILED: node_modules is missing. Run `npm install` first.');
  process.exit(1);
}

const packageJsons = [];
walkNodeModules(dir, packageJsons, new Set());

// A check that finds nothing has proved nothing: an empty node_modules (or
// a tree the walk could not read) must fail, not print a pass for zero
// dependencies.
if (packageJsons.length === 0) {
  console.error('License check FAILED: no dependencies found in node_modules. Run `npm install` first.');
  process.exit(1);
}

for (const pj of packageJsons) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pj, 'utf8'));
  } catch (err) {
    bad.push(pj + ': unreadable package.json (' + err.message + ')');
    continue;
  }
  const licStr = licenseOf(pkg);
  if (licStr === 'UNKNOWN' || !isAllowed(licStr)) {
    bad.push(pkg.name + '@' + pkg.version + ': ' + licStr);
  } else {
    other.push(pkg.name + '@' + pkg.version + ': ' + licStr);
  }
}

if (bad.length) {
  console.error('License check FAILED:');
  for (const b of bad) console.error('  ' + b);
  process.exit(1);
}
console.log('License check passed. ' + other.length + ' dependencies, all on the allowlist.');
for (const o of other) console.log('  ' + o);
