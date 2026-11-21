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
  isLiveSample?: boolean;
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
  const residueCheck = report.checked.find((c) => c.checkId === 'residue' && c.result.includes('COLLISION'));
  if (!residueCheck) return null;

  const residueMatch = residueCheck.result.match(/residue (\d+) shared by/i);
  if (!residueMatch) return null;

  // The two sides of the collision are the first and last distinct keyset
  // IDs after "shared by". The mint lists the same keyset the token uses,
  // so the token and mint entries are the same ID; the distinct pair is
  // the token keyset and the known keyset it collides with. Showing the
  // token and mint entries would draw two identical IDs colliding, which
  // is not what happened.
  const afterShared = residueCheck.result.split(/shared by/i)[1] || '';
  const ids = afterShared.match(/[0-9a-fA-F]{16,}/g) || [];
  const distinct = [...new Set(ids)];
  if (distinct.length < 2) return null;
  return {
    residue: residueMatch[1],
    keysetA: distinct[0],
    keysetB: distinct[distinct.length - 1],
  };
}

// The report's checks become a verification pipeline: each step is one
// stage of the check flow, in the order it runs, and a step that covers
// several checks (one per keyset or proof) shows them as sub-steps.
// The pattern is borrowed from Spectrum UI agent-steps (a timeline of
// steps with status) and Fluid Functionalism thinking-steps (collapsible
// per-step detail), rebuilt here in the page's own tokens because both
// ship as React and this page is plain static HTML.

interface PipelineStep {
  name: string;
  checks: ReportCheck[];
}

// The pipeline order is the logical order the verification runs in:
// decode the token, learn the mint facts, verify the keyset IDs,
// screen residues, note keyset age, verify signatures, ask the mint.
const PIPELINE_ORDER = [
  'decode',
  'mint-facts',
  'derivation',
  'residue',
  'keyset-age',
  'dleq',
  'checkstate',
] as const;

type PipelineStepId = (typeof PIPELINE_ORDER)[number];

const PIPELINE_NAMES: Record<PipelineStepId, string> = {
  decode: 'Token decode',
  'mint-facts': 'Mint facts',
  derivation: 'Keyset ID derivation',
  residue: 'Residue screen',
  'keyset-age': 'Keyset age',
  dleq: 'DLEQ',
  checkstate: 'Checkstate',
};

function pipelineStepId(check: ReportCheck): PipelineStepId | null {
  if (check.checkId === 'decode') return 'decode';
  if (check.checkId === 'derivation') return 'derivation';
  if (check.checkId === 'residue') return 'residue';
  if (check.checkId === 'dleq') return 'dleq';
  if (check.checkId === 'checkstate') return 'checkstate';
  // 'mint' covers two different steps, split by name.
  if (check.checkId === 'mint' && check.name === 'Mint facts') return 'mint-facts';
  if (check.checkId === 'mint' && check.name === 'Keyset age') return 'keyset-age';
  return null;
}

function groupIntoPipeline(report: NutCheckReport): PipelineStep[] {
  const byId = new Map<PipelineStepId, ReportCheck[]>();
  const extra: PipelineStep[] = [];
  for (const check of [...report.checked, ...report.notChecked]) {
    const id = pipelineStepId(check);
    if (id === null) {
      // A check no step knows about gets its own step, named after itself,
      // so nothing is ever silently dropped from the report.
      extra.push({ name: check.name, checks: [check] });
      continue;
    }
    const list = byId.get(id);
    if (list) list.push(check);
    else byId.set(id, [check]);
  }
  const steps: PipelineStep[] = [];
  for (const id of PIPELINE_ORDER) {
    const checks = byId.get(id);
    if (checks) steps.push({ name: PIPELINE_NAMES[id], checks });
  }
  return [...steps, ...extra];
}

// Mock-backed sample results are labelled simulated, not presented as live
// mint answers. A check that never ran (consent not given) has no
// simulated answer to label.
function simulatedLabel(check: ReportCheck, options: RenderOptions): string {
  if (
    options.isSample &&
    !options.isLiveSample &&
    (check.checkId === 'checkstate' || check.checkId === 'mint') &&
    !check.result.includes('Consent not given')
  ) {
    return ' (simulated mint answer)';
  }
  return '';
}

interface StepStatus {
  css: 'pass' | 'fail' | 'hold' | 'idle';
  text: string;
  dot: 'green' | 'red' | 'amber' | 'grey';
  open: boolean;
}

function pipelineStepStatus(step: PipelineStep): StepStatus {
  const worst = step.checks.find((c) => c.severity === 'red');
  if (worst) {
    return { css: 'fail', text: 'Hard fail', dot: 'red', open: true };
  }
  const flagged = step.checks.find((c) => c.severity === 'amber');
  if (flagged) {
    const badge = statusBadgeClass(flagged);
    return { css: 'hold', text: badge.text, dot: 'amber', open: true };
  }
  const allPass = step.checks.every((c) => c.outcome === 'pass');
  if (allPass) {
    return { css: 'pass', text: 'Pass', dot: 'green', open: false };
  }
  const allIdle = step.checks.every((c) => c.outcome === 'not-checked');
  if (allIdle) {
    return { css: 'idle', text: 'Not checked', dot: 'grey', open: false };
  }
  return { css: 'idle', text: 'Partial', dot: 'grey', open: false };
}

// The line a step shows while closed. Single checks show their result
// (the residue result is a paragraph, so the line shows its first clause
// and the full result sits in the expanded detail). Grouped steps show
// a count: derivation counts matching keysets, DLEQ counts proof states.
function pipelineStepValue(step: PipelineStep, options: RenderOptions): string {
  const checks = step.checks;
  if (checks.length === 1) {
    const check = checks[0];
    const result = `${check.result}${simulatedLabel(check, options)}`;
    if (step.name === 'Residue screen') {
      const first = result.split(';')[0];
      return first.length < result.length && first.length >= 20 ? first : result;
    }
    return result;
  }
  if (step.name === 'Keyset ID derivation') {
    const passed = checks.filter((c) => c.outcome === 'pass').length;
    if (passed === checks.length) {
      return `${checks.length} mint keysets recomputed, ${checks.length === 2 ? 'both' : 'all'} match`;
    }
    return `${passed} of ${checks.length} mint keysets recomputed`;
  }
  if (step.name === 'DLEQ') {
    const valid = checks.filter((c) => c.outcome === 'pass').length;
    const absent = checks.filter((c) => c.result.includes('DLEQ absent')).length;
    const incomplete = checks.filter((c) => c.result.includes('incomplete')).length;
    if (absent === checks.length) {
      return `DLEQ absent on ${checks.length} proof${checks.length === 1 ? '' : 's'}`;
    }
    if (valid === checks.length) {
      return `DLEQ valid on ${checks.length} proof${checks.length === 1 ? '' : 's'}`;
    }
    const parts: string[] = [];
    if (valid > 0) parts.push(`${valid} valid`);
    if (absent > 0) parts.push(`${absent} absent`);
    if (incomplete > 0) parts.push(`${incomplete} incomplete`);
    const other = checks.length - valid - absent - incomplete;
    if (other > 0) parts.push(`${other} not checked`);
    return `DLEQ: ${parts.join(', ')}`;
  }
  // Any other multi-check step: the primary check's result (the check
  // named after the step), or the first check's result.
  const primary = checks.find((c) => c.name === step.name) || checks[0];
  return `${primary.result}${simulatedLabel(primary, options)}`;
}

export function renderReportHtml(report: NutCheckReport, options: RenderOptions = {}): string {
  const stateClass =
    report.severity === 'red' ? 'red' : report.severity === 'amber' ? 'amber' : 'green';

  const stateWord =
    report.headline === 'Not fully checked.'
      ? 'Incomplete'
      : report.severity === 'red'
        ? 'Hard fail'
        : report.severity === 'amber'
          ? 'Hold'
          : 'No findings';

  const headline = report.headline;
  const sampleNotice = options.isLiveSample
    ? ' (real token from a live test mint, checked live)'
    : options.isSample
      ? ' (demo token: the checker ran its real checks, the mint answers are simulated)'
      : '';

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
              ? passedCount === 0
                ? 'The token decodes and the keysets check out. DLEQ is absent on the proofs, so no DLEQ check ran. The report below shows exactly what ran and what did not.'
                : `The token decodes and the keysets check out; DLEQ passed on ${passedCount} of ${eligibleCount} proofs, the rest carry no DLEQ. The report below shows exactly what ran and what did not.`
              : 'The token decodes; keyset verification was not completed. The report below shows exactly what ran and what did not.';

  // Determine what to do line if any
  let todoLine = '';
  if (report.severity === 'red') {
    todoLine = 'Do not accept this token. The proofs are invalid or already spent.';
  } else if (report.checked.some((c) => c.checkId === 'residue' && c.severity === 'amber')) {
    todoLine = 'Do not swap this token in a wallet that also holds proofs on the colliding keyset.';
  } else if (report.notChecked.some((c) => c.checkId === 'dleq' && c.result.includes('incomplete'))) {
    todoLine = 'The DLEQ check could not run on one proof, its DLEQ block is incomplete. A proof without DLEQ can still be valid, ask the sender for a full token if you want that check to run.';
  } else if (report.notChecked.some((c) => c.checkId === 'checkstate' && c.result.toLowerCase().includes('consent not given'))) {
    todoLine = 'Turn on \'Ask the mint\' to check whether the proofs are spent.';
  }

  // Outcome counts for the verdict foot: pipeline steps, not individual
  // checks. A step groups one check per proof or keyset, so counting
  // checks made Clean read '6 Passed, 3 Not checked' while the pipeline
  // shows 7 steps. The chips must add up to the steps the user sees.
  const steps = groupIntoPipeline(report);
  const stepStatuses = steps.map((step) => pipelineStepStatus(step));
  const passedStepCount = stepStatuses.filter((s) => s.css === 'pass').length;
  const attentionStepCount = stepStatuses.filter((s) => s.css === 'fail' || s.css === 'hold').length;
  const notCheckedStepCount = stepStatuses.filter((s) => s.css === 'idle').length;
  // The 'Not checked' section header below still counts items, because
  // it labels the list of not-checked checks under it.
  const notCheckedCount = report.notChecked.length;
  const cannotProveCount = report.cannotProve.length;

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
  html += `<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>`;
  html += `<div class="verdict-top"><h2>${escapeHtml(headline)}${escapeHtml(sampleNotice)}</h2><span class="state">${escapeHtml(stateWord)}</span></div>`;
  html += `<p>${escapeHtml(summaryLine)}</p>`;
  if (todoLine) {
    html += `<div class="todo"><b>What to do:</b> ${escapeHtml(todoLine)}</div>`;
  }
  // Counts at the foot of the verdict: the answer and its composition in
  // one glance. The separate summary strip is gone; these chips are it.
  html += `<div class="counts">`;
  html += `<span class="chip"><b>${passedStepCount}</b> Passed</span>`;
  if (attentionStepCount > 0) {
    html += `<span class="chip attention"><b>${attentionStepCount}</b> Needs attention</span>`;
  }
  html += `<span class="chip"><b>${notCheckedStepCount}</b> Not checked</span>`;
  // No 'Cannot prove' chip here: it is not a step outcome, it is a fixed
  // list of limitations, and it is already listed in its own section
  // below with its own count. Adding it would make the foot add up to
  // more than the steps the user sees.
  html += `</div>`;
  html += `</div>`;

  // 3. Decoded Token Facts
  html += `<div class="decoded" role="region" aria-label="Decoded token">`;
  html += `<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>`;
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
  const mintSimulated = options.isSample && !options.isLiveSample ? ' (simulated mint answer)' : '';
  html += `<p style="margin:12px 0 0;font-size:13px;color:var(--muted)">Mint facts: ${escapeHtml(defaultFacts)}${escapeHtml(mintSimulated)}</p>`;
  if (options.isSample && options.sampleDescription) {
    const scenarioLabel = options.isLiveSample ? 'Token' : 'Example scenario';
    const scenarioSuffix = options.isLiveSample ? '' : ' (example only, not a live mint answer)';
    html += `<p style="margin:8px 0 0;font-size:13px;color:var(--muted)">${scenarioLabel}: ${escapeHtml(options.sampleDescription)}${scenarioSuffix}</p>`;
  }
  html += `</div>`;

  // 4. Verification pipeline: the checks as steps of the flow, in order.
  // Passed steps start closed, a flagged step starts open, and the
  // collision diagram sits inside the flagged residue step.
  const collision = extractCollision(report);
  const renderStep = (step: PipelineStep, index: number): string => {
    const status = pipelineStepStatus(step);
    const value = pipelineStepValue(step, options);
    const open = status.open ? ' open' : '';
    let body = '';
    if (step.checks.length === 1) {
      const check = step.checks[0];
      const full = `${check.result}${simulatedLabel(check, options)}`;
      if (full !== value) {
        body += `<p class="full">${escapeHtml(full)}</p>`;
      }
      body += `<p class="msg">${escapeHtml(check.message)}</p>`;
    } else {
      const messages = step.checks.map((c) => c.message);
      const sharedMessage = messages.every((m) => m === messages[0]) ? messages[0] : null;
      for (const check of step.checks) {
        body += `<div class="substep"><span class="mini"></span><span class="r">${escapeHtml(check.result)}${simulatedLabel(check, options)}</span></div>`;
        if (sharedMessage === null) {
          body += `<p class="msg">${escapeHtml(check.message)}</p>`;
        }
      }
      if (sharedMessage !== null) {
        body += `<p class="msg">${escapeHtml(sharedMessage)}</p>`;
      }
    }
    if (step.name === 'Residue screen' && collision) {
      body += `<div class="diagram" role="region" aria-label="Collision diagram">`;
      body += `<div class="label">The collision, drawn out</div>`;
      body += `<div class="flow">`;
      body += `<div class="node"><div class="nk">Keyset A</div><div class="nv">${escapeHtml(collision.keysetA.slice(0, 8))}<span class="hl">${escapeHtml(collision.keysetA.slice(8))}</span></div></div>`;
      body += `<div class="arrow"><span class="sym">&rarr;</span><span>mod 2^31 - 1</span></div>`;
      body += `<div class="node"><div class="nk">Keyset B</div><div class="nv">${escapeHtml(collision.keysetB.slice(0, 8))}<span class="hl">${escapeHtml(collision.keysetB.slice(8))}</span></div></div>`;
      body += `<div class="arrow"><span class="sym">&rarr;</span><span>mod 2^31 - 1</span></div>`;
      body += `<div class="result"><div class="nk">Same residue</div><div class="nv">${escapeHtml(collision.residue)}</div><div class="ns">Two keysets, one residue. That is the attack.</div></div>`;
      body += `</div>`;
      body += `</div>`;
    }
    return `<details class="step"${open} role="listitem"><span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span><summary><span class="step-num">${index}</span><span class="step-name">${escapeHtml(step.name)}</span><span class="step-val">${escapeHtml(value)}</span><span class="status ${status.css}">${escapeHtml(status.text)}</span><span class="chev">&#8250;</span></summary><div class="step-body">${body}</div></details>`;
  };
  html += `<p class="section-title">Verification pipeline</p>`;
  html += `<p class="section-sub">Each step ran in order. Open a step to see what it measured.</p>`;
  html += `<div class="pipeline" role="list">`;
  for (let i = 0; i < steps.length; i++) html += renderStep(steps[i], i + 1);
  html += `</div>`;

  // 5. What this report can and cannot say, as one panel with three columns
  html += `<p class="section-title" id="limits">What this report can and cannot say</p>`;
  html += `<p class="section-sub">The same report, shortened. This is what copies as text.</p>`;
  html += `<div class="limits-panel">`;
  html += `<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>`;

  // Checked column
  html += `<div class="limit-col c-checked">`;
  html += `<h3><span class="b" aria-hidden="true"></span>Checked<span class="count">${report.checked.length}</span></h3>`;
  html += `<ul>`;
  if (report.checked.length === 0) {
    html += `<li>No local checks could complete</li>`;
  } else {
    for (const c of report.checked) {
      html += `<li>${escapeHtml(c.name)}: ${escapeHtml(c.result)}${simulatedLabel(c, options)}</li>`;
    }
  }
  html += `</ul>`;
  html += `</div>`;

  // Not checked column
  html += `<div class="limit-col c-not">`;
  html += `<h3><span class="b" aria-hidden="true"></span>Not checked<span class="count">${notCheckedCount}</span></h3>`;
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

  // Cannot prove column
  html += `<div class="limit-col c-cannot">`;
  html += `<h3><span class="b" aria-hidden="true"></span>Cannot prove<span class="count">${cannotProveCount}</span></h3>`;
  html += `<ul>`;
  for (const item of report.cannotProve) {
    html += `<li>${escapeHtml(item)}</li>`;
  }
  html += `</ul>`;
  html += `</div>`;

  html += `</div>`;

  // 6. Copy bar
  html += `<div class="copybar-card">`;
  html += `<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>`;
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
  if (options.isLiveSample) {
    lines.push('(real token from a live test mint, checked live)');
  } else if (options.isSample) {
    lines.push('(demo token: the checker ran its real checks, the mint answers below are simulated, not live mint answers)');
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
      const simulated = options.isSample && !options.isLiveSample && (c.checkId === 'checkstate' || c.checkId === 'mint') && !c.result.includes('Consent not given') ? ' (simulated mint answer)' : '';
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

