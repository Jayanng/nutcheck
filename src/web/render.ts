// Report rendering logic for the web client.
// Transforms a NutCheckReport into accessible semantic HTML.

import type { NutCheckReport, ReportCheck } from '../report.js';
import type { RawToken } from '../rawParser.js';
import { classifyKeysetVersion } from '../keysetVersion.js';
import { scanReportCopy, mintFingerprint } from '../report.js';

export interface RenderOptions {
  sampleName?: string;
  sampleDescription?: string;
  isSample?: boolean;
  knownKeysets?: readonly string[];
  rawToken?: RawToken;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadgeClass(check: ReportCheck): { css: string; text: string } {
  if (check.severity === 'red') {
    return { css: 'fail', text: 'Hard fail' };
  }
  if (check.severity === 'amber') {
    if (check.result.includes('COLLISION')) {
      return { css: 'hold', text: 'Collision' };
    }
    if (check.result.includes('incomplete')) {
      return { css: 'hold', text: 'Incomplete' };
    }
    return { css: 'hold', text: 'Hold' };
  }
  if (check.outcome === 'pass') {
    return { css: 'pass', text: 'Pass' };
  }
  return { css: 'idle', text: 'Not checked' };
}

function formatAmount(rawToken?: RawToken): string {
  if (!rawToken || !rawToken.proofs || rawToken.proofs.length === 0) {
    return '(unknown)';
  }
  const total = rawToken.proofs.reduce((sum, p) => sum + p.amount, 0);
  const count = rawToken.proofs.length;
  const unit = rawToken.unit || '(unknown unit)';
  return `${total} ${unit}, ${count} proof${count === 1 ? '' : 's'}`;
}

interface CollisionInfo {
  keysetA: string;
  keysetB: string;
  residue: string;
}

function extractCollision(report: NutCheckReport): CollisionInfo | null {
  const residueCheck = report.checked.find((c) => c.checkId === 'residue' && c.severity === 'amber');
  if (!residueCheck) return null;

  const match = residueCheck.result.match(/residue (\d+) shared by ([0-9a-fA-F]+).*?, ([0-9a-fA-F]+)/i);
  if (match) {
    return {
      residue: match[1],
      keysetA: match[2],
      keysetB: match[3],
    };
  }
  return null;
}

export function renderReportHtml(report: NutCheckReport, options: RenderOptions = {}): string {
  const stateClass =
    report.severity === 'red' ? 'red' : report.severity === 'amber' ? 'amber' : 'green';

  const stateWord =
    report.severity === 'red'
      ? 'Hard fail'
      : report.severity === 'amber'
        ? 'Hold'
        : 'No findings';

  const headline = report.headline;
  const sampleNotice = options.isSample ? ' (sample demo: mint results are simulated)' : '';

  // Only claim signatures match when every eligible proof was verified and
  // passed. The proof count comes from the parsed token, not from report
  // entries, so a proof with no DLEQ entry is not silently dropped from
  // the denominator. V3 proofs use a different scheme and are excluded.
  const totalProofs = options.rawToken?.proofs?.length ?? 0;
  const dleqChecks = report.checked.filter((c) => c.checkId === 'dleq');
  const dleqNotChecked = report.notChecked.filter((c) => c.checkId === 'dleq');
  const dleqAmber = dleqNotChecked.filter((c) => c.severity === 'amber');
  const dleqV3 = dleqNotChecked.filter((c) => c.severity === 'none');
  const passedCount = dleqChecks.filter((c) => c.outcome === 'pass').length;
  // Eligible proofs are V1/V2 proofs. V3 proofs are excluded.
  const v3Count = options.rawToken?.proofs?.filter((p) => {
    const version = p.id ? p.id.slice(0, 2) : '';
    return version === '02';
  }).length ?? 0;
  const eligibleCount = totalProofs - v3Count;
  const dleqPassed =
    eligibleCount > 0 && passedCount === eligibleCount && dleqAmber.length === 0;
  const dleqCount = eligibleCount;
  const mintChecked = report.checked.some((c) => c.checkId === 'mint' && c.outcome === 'pass');
  const v3Note = v3Count > 0 ? ` (${v3Count} V3 proof${v3Count === 1 ? '' : 's'} use a different scheme)` : '';
  // V3-only tokens use pairing-based verification, not secp DLEQ, so the
  // summary must not describe a DLEQ check as incomplete for them.
  const isV3Only = totalProofs > 0 && v3Count === totalProofs;
  const summaryLine =
    report.severity === 'red'
      ? 'One or more proofs failed verification or are already spent according to the mint.'
      : report.severity === 'amber'
        ? 'A check raised an issue or could not be completed. Review the findings below before accepting.'
        : dleqPassed && mintChecked
          ? `The token decodes, the keysets check out, and DLEQ passed for ${dleqCount} V1/V2 proof${dleqCount === 1 ? '' : 's'}${v3Note}. The report below shows exactly what ran and what did not.`
          : isV3Only
            ? 'The token decodes and the keysets check out. V3 proofs use pairing-based verification, not DLEQ. The report below shows exactly what ran and what did not.'
            : mintChecked
              ? 'The token decodes and the keysets check out; the signature check did not run on all proofs. The report below shows exactly what ran and what did not.'
              : 'The token decodes; keyset verification was not completed. The report below shows exactly what ran and what did not.';

  // Determine what to do line if any
  let todoLine = '';
  if (report.severity === 'red') {
    todoLine = 'Do not accept this token. The proofs are invalid or already spent.';
  } else if (report.checked.some((c) => c.checkId === 'residue' && c.severity === 'amber')) {
    todoLine = 'Do not swap this token in a wallet that also holds proofs on the colliding keyset.';
  } else if (report.notChecked.some((c) => c.checkId === 'dleq' && c.result.includes('incomplete'))) {
    todoLine = 'Do not accept this token until the DLEQ block is complete. Ask the sender for a full token.';
  }

  const rawMint = report.mint || options.rawToken?.mints[0];
  const mintDisplay = rawMint !== undefined ? mintFingerprint(rawMint) : 'Unknown mint';
  const sampleName = options.sampleName || (rawMint ? `Token from ${mintDisplay}` : 'Diagnostic report');

  let html = '';

  // 1. Label
  html += `<div class="report-label">`;
  html += `<span class="tag">Diagnostic report</span>`;
  html += `<span>${escapeHtml(sampleName)}, ${escapeHtml(mintDisplay)}</span>`;
  html += `</div>`;

  // 2. Verdict
  html += `<div class="verdict ${stateClass}" role="region" aria-label="verdict">`;
  html += `<div class="state">${escapeHtml(stateWord)}</div>`;
  html += `<h2>${escapeHtml(headline)}${escapeHtml(sampleNotice)}</h2>`;
  html += `<p>${escapeHtml(summaryLine)}</p>`;
  if (todoLine) {
    html += `<div class="todo"><b>What to do:</b> ${escapeHtml(todoLine)}</div>`;
  }
  html += `</div>`;

  // 3. Decoded Token Facts
  html += `<div class="decoded" role="region" aria-label="decoded token">`;
  html += `<div class="label">Decoded token</div>`;
  html += `<div class="grid">`;
  html += `<div class="fact"><div class="k">Mint</div><div class="v mono">${escapeHtml(mintDisplay)}</div></div>`;
  html += `<div class="fact"><div class="k">Amount</div><div class="v">${escapeHtml(formatAmount(options.rawToken))}</div></div>`;
  const formatDisplay = options.rawToken?.format
    ? options.rawToken.format === 'cashuA'
      ? 'cashuA, v3'
      : 'cashuB, v4'
    : '(unknown)';
  html += `<div class="fact"><div class="k">Format</div><div class="v">${escapeHtml(formatDisplay)}</div></div>`;

  const keysetList = options.rawToken?.keysetIds || [];
  const keysetHtml =
    keysetList.length > 0
      ? keysetList
          .map((id) => {
            const ver = classifyKeysetVersion(id).toUpperCase();
            return `${escapeHtml(id)}<span class="ver">${escapeHtml(ver)}</span>`;
          })
          .join('<br>')
      : '(unknown)';

  html += `<div class="fact"><div class="k">Keysets</div><div class="v mono">${keysetHtml}</div></div>`;
  html += `</div>`;

  const mintCheck =
    report.checked.find((c) => c.checkId === 'mint') ||
    report.notChecked.find((c) => c.checkId === 'mint');
  const defaultFacts = mintCheck
    ? `${mintCheck.result}${mintCheck.message ? ` (${mintCheck.message})` : ''}`
    : 'Mint facts not checked.';
  // Mint facts always derive from checks that actually ran, never from a
  // sample description. The sample description goes in its own labelled field.
  // When the mint facts came from a sample mock, label them simulated on this line.
  const mintSimulated = options.isSample ? ' (simulated)' : '';
  html += `<p style="margin:12px 0 0;font-size:13px;color:var(--muted)">Mint facts: ${escapeHtml(defaultFacts)}${escapeHtml(mintSimulated)}</p>`;
  if (options.isSample && options.sampleDescription) {
    html += `<p style="margin:8px 0 0;font-size:13px;color:var(--muted)">Example scenario: ${escapeHtml(options.sampleDescription)} (example only, not a live mint answer)</p>`;
  }
  html += `</div>`;

  // 4. Collision diagram if collision occurred
  const collision = extractCollision(report);
  if (collision) {
    html += `<div class="diagram" role="region" aria-label="collision diagram">`;
    html += `<div class="label">The collision, drawn out</div>`;
    html += `<div class="flow">`;
    html += `<div class="node"><div class="nk">Keyset A</div><div class="nv">${escapeHtml(collision.keysetA.slice(0, 8))}<span class="hl">${escapeHtml(collision.keysetA.slice(8))}</span></div></div>`;
    html += `<div class="arrow"><span class="sym">&rarr;</span><span>mod 2^31 - 1</span></div>`;
    html += `<div class="node"><div class="nk">Keyset B</div><div class="nv">${escapeHtml(collision.keysetB.slice(0, 8))}<span class="hl">${escapeHtml(collision.keysetB.slice(8))}</span></div></div>`;
    html += `<div class="arrow"><span class="sym">&rarr;</span><span>mod 2^31 - 1</span></div>`;
    html += `<div class="result"><div class="nk">Same residue</div><div class="nv">${escapeHtml(collision.residue)}</div><div class="ns">Two keysets, one residue. That is the attack.</div></div>`;
    html += `</div>`;
    html += `</div>`;
  }

  // 5. Tests and measured values
  html += `<p class="section-title">Tests and measured values</p>`;
  html += `<div class="checks" role="list">`;
  const allChecks = [...report.checked, ...report.notChecked];
  for (const check of allChecks) {
    const badge = statusBadgeClass(check);
    // Mock-backed sample results are labelled simulated, not presented as live mint answers.
    // A check that never ran (consent not given) has no simulated answer to label.
    const simulated = options.isSample && (check.checkId === 'checkstate' || check.checkId === 'mint') && !check.result.includes('consent not given') ? ' (simulated)' : '';
    html += `<div class="check" role="listitem">`;
    html += `<div class="body">`;
    html += `<h3>${escapeHtml(check.name)}<span class="val">${escapeHtml(check.result)}${simulated}</span></h3>`;
    html += `<p>${escapeHtml(check.message)}</p>`;
    html += `</div>`;
    html += `<span class="status ${badge.css}">${escapeHtml(badge.text)}</span>`;
    html += `</div>`;
  }
  html += `</div>`;

  // 6. What this report can and cannot say (Checked, Not checked, Cannot prove)
  html += `<p class="section-title" id="limits">What this report can and cannot say</p>`;
  html += `<div class="cols">`;

  // Checked card
  html += `<div class="card c-checked">`;
  html += `<h3><span class="b" aria-hidden="true"></span>Checked</h3>`;
  html += `<ul>`;
  if (report.checked.length === 0) {
    html += `<li>No local checks could complete</li>`;
  } else {
    for (const c of report.checked) {
      const simulated = options.isSample && (c.checkId === 'checkstate' || c.checkId === 'mint') && !c.result.includes('consent not given') ? ' (simulated)' : '';
      html += `<li>${escapeHtml(c.name)}: ${escapeHtml(c.result)}${simulated}</li>`;
    }
  }
  html += `</ul>`;
  html += `</div>`;

  // Not checked card
  html += `<div class="card c-not">`;
  html += `<h3><span class="b" aria-hidden="true"></span>Not checked</h3>`;
  html += `<ul>`;
  if (report.notChecked.length === 0) {
    html += `<li>All scheduled checks ran</li>`;
  } else {
    for (const c of report.notChecked) {
      html += `<li>${escapeHtml(c.name)}: ${escapeHtml(c.result)}</li>`;
    }
  }
  html += `</ul>`;
  html += `</div>`;

  // Cannot prove card
  html += `<div class="card c-cannot">`;
  html += `<h3><span class="b" aria-hidden="true"></span>Cannot prove</h3>`;
  html += `<ul>`;
  for (const item of report.cannotProve) {
    html += `<li>${escapeHtml(item)}</li>`;
  }
  html += `</ul>`;
  html += `</div>`;

  html += `</div>`;

  // 7. Copy bar
  html += `<div class="copybar">`;
  html += `<button class="copybtn" id="copy-btn" type="button" aria-label="Copy diagnostic report to clipboard">Copy report as text</button>`;
  html += `<span class="note">Pastes as plain text, with the same three sections.</span>`;
  html += `</div>`;

  // Scan output for banned words
  const bannedMatches = scanReportCopy(html);
  if (bannedMatches.length > 0) {
    throw new Error(`Report HTML contains banned words: ${bannedMatches.join(', ')}`);
  }

  return html;
}

export function reportToPlainText(report: NutCheckReport, options: RenderOptions = {}): string {
  const lines: string[] = [];
  const sampleName = options.sampleName || 'Diagnostic report';
  const rawMint = report.mint || options.rawToken?.mints[0];
  const mintDisplay = rawMint !== undefined ? mintFingerprint(rawMint) : '(unknown)';

  lines.push(`NutCheck report: ${sampleName}`);
  if (options.isSample) {
    lines.push('(sample demo: mint and proof-state results below are simulated, not live mint answers)');
  }
  lines.push(`Mint: ${mintDisplay}`);
  lines.push(`Unit: ${report.unit || '(unknown)'}`);
  lines.push(`Headline: ${report.headline}`);
  lines.push(`Severity: ${report.severity}`);
  lines.push('');

  lines.push('Decoded token:');
  lines.push(`  Amount: ${formatAmount(options.rawToken)}`);
  const formatText = options.rawToken?.format
    ? options.rawToken.format === 'cashuA'
      ? 'cashuA, v3'
      : 'cashuB, v4'
    : '(unknown)';
  lines.push(`  Format: ${formatText}`);
  lines.push(`  Keysets: ${(options.rawToken?.keysetIds || []).join(', ') || '(none)'}`);
  lines.push('');

  lines.push('Checked:');
  if (report.checked.length === 0) {
    lines.push('  (nothing)');
  } else {
    for (const c of report.checked) {
      const simulated = options.isSample && (c.checkId === 'checkstate' || c.checkId === 'mint') && !c.result.includes('consent not given') ? ' (simulated)' : '';
      lines.push(`  - ${c.name} [${c.checkId}]: ${c.result}${simulated} - ${c.message}`);
    }
  }
  lines.push('');

  lines.push('Not checked:');
  if (report.notChecked.length === 0) {
    lines.push('  (nothing)');
  } else {
    for (const c of report.notChecked) {
      lines.push(`  - ${c.name} [${c.checkId}]: ${c.result} - ${c.message}`);
    }
  }
  lines.push('');

  lines.push('Cannot prove:');
  for (const item of report.cannotProve) {
    lines.push(`  - ${item}`);
  }

  const fullText = lines.join('\n');
  const banned = scanReportCopy(fullText);
  if (banned.length > 0) {
    throw new Error(`Plain text report contains banned words: ${banned.join(', ')}`);
  }

  return fullText;
}

