// Web interface tests: validating real library report rendering,
// all 8 fixture states, three-section structure, consent guard,
// absence of banned words, and accessibility attributes.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { diagnoseToken, scanReportCopy, BANNED_WORDS, CANNOT_PROVE, mintFingerprint, type NutCheckReport } from '../src/report.js';
import { parseTokenRaw } from '../src/rawParser.js';
import { classifyKeysetVersion } from '../src/keysetVersion.js';
import { SAMPLES, getSampleFetchFn } from '../src/web/samples.js';
import { renderReportHtml, reportToPlainText } from '../src/web/render.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('web report: real output across fixture states', () => {
  it('clean sample is incomplete without consent and clean after the mint check runs', async () => {
    const sample = SAMPLES.clean;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('clean');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });

    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    // Check DOM elements
    expect(html).toContain('verdict amber');
    expect(html).toContain('Incomplete');
    expect(html).toContain(report.headline);
    expect(html).toContain('Checked');
    expect(html).toContain('Not checked');
    expect(html).toContain('Cannot prove');
    expect(html).toContain(mintFingerprint(sample.mint));
    expect(html).not.toContain('testnut.cashu.space');
    expect(html).toContain('V1');
    expect(html).toContain('V2');

    // No collision diagram on clean token
    expect(html).not.toContain('The collision, drawn out');

    // Verify copy is free of banned words
    expect(scanReportCopy(html)).toEqual([]);
    for (const word of BANNED_WORDS) {
      expect(html.toLowerCase()).not.toContain(` ${word} `);
    }

    // After consent, the mint reports unspent and the headline is clean.
    const cleanReport = await diagnoseToken(sample.token, {
      fetchFn,
      consent: true,
      knownKeysets: sample.knownKeysets,
    });
    expect(cleanReport.headline).toBe('No known issues found.');
    expect(cleanReport.severity).toBe('none');
    const cleanHtml = renderReportHtml(cleanReport, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });
    expect(cleanHtml).toContain('verdict green');
    expect(cleanHtml).toContain('No findings');
    expect(scanReportCopy(cleanHtml)).toEqual([]);
  });

  it('evil mint sample flags collision and renders collision diagram', async () => {
    const sample = SAMPLES.evil;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('evil');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });

    expect(report.headline).toBe('Hold, here is why.');
    expect(report.severity).toBe('amber');

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    expect(html).toContain('verdict amber');
    expect(html).toContain('Hold');
    expect(html).toContain('Hold, here is why');
    expect(html).toContain('The collision, drawn out');
    expect(html).toContain('1138537334');
    expect(html).toContain('Two keysets, one residue. That is the attack.');

    // Plain text export includes collision
    const text = reportToPlainText(report, { sampleName: sample.name, rawToken });
    expect(text).toContain('Headline: Hold, here is why.');
    expect(text).toContain('1138537334');
    expect(scanReportCopy(text)).toEqual([]);
  });

  it('spent sample renders hard fail in red with spent proof state', async () => {
    const sample = SAMPLES.spent;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('spent');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: true,
      knownKeysets: sample.knownKeysets,
    });

    expect(report.headline).toBe('Hold, here is why.');
    expect(report.severity).toBe('red');

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    expect(html).toContain('verdict red');
    expect(html).toContain('Hard fail');
    expect(html).toContain('Do not accept this token');
    expect(html).toContain('status fail');
    expect(html).toContain('The mint reports this proof as spent');
    expect(scanReportCopy(html)).toEqual([]);
  });

  it('spent sample shows not-checked proof state before consent, spent after', async () => {
    const sample = SAMPLES.spent;
    const fetchFn = getSampleFetchFn('spent');

    // Stage 1: consent off, proof state must be not checked, not red from spent
    const before = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });
    const checkstateBefore = before.notChecked.find((c) => c.checkId === 'checkstate');
    expect(checkstateBefore).toBeDefined();
    expect(checkstateBefore?.result).toBe('Consent not given, so the mint was not asked');

    // Stage 2: consent on, mock returns SPENT, report is red
    const after = await diagnoseToken(sample.token, {
      fetchFn,
      consent: true,
      knownKeysets: sample.knownKeysets,
    });
    expect(after.severity).toBe('red');
    const checkstateAfter = after.checked.find((c) => c.checkId === 'checkstate');
    expect(checkstateAfter?.result).toContain('spent');
  });

  it('partial DLEQ sample detects incomplete DLEQ block', async () => {
    const sample = SAMPLES.partial;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('partial');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });

    expect(report.headline).toBe('Hold, here is why.');
    expect(report.severity).toBe('amber');

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    expect(html).toContain('verdict amber');
    expect(html).toContain('Hold');
    expect(html).toContain('Incomplete');
    expect(html).toContain('A proof carries an incomplete DLEQ');
    expect(scanReportCopy(html)).toEqual([]);
  });

  it('pending proof sample reports melt in flight as hold amber', async () => {
    const sample = SAMPLES.pending;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('pending');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: true,
      knownKeysets: sample.knownKeysets,
    });

    expect(report.headline).toBe('Hold, here is why.');
    expect(report.severity).toBe('amber');

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    expect(html).toContain('verdict amber');
    expect(html).toContain('The mint reports this proof as pending');
    expect(scanReportCopy(html)).toEqual([]);
  });

  it('unreachable mint sample degrades gracefully to amber', async () => {
    const sample = SAMPLES.unreachable;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('unreachable');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });

    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    expect(html).toContain('verdict amber');
    expect(html).toContain('The mint did not answer');
    expect(html).toContain('Turn on');
    expect(scanReportCopy(html)).toEqual([]);
  });

  it('auth required sample marks checkstate auth required without crash', async () => {
    const sample = SAMPLES.auth;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('auth');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: true,
      knownKeysets: sample.knownKeysets,
    });

    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    expect(html).toContain('verdict amber');
    expect(html).toContain('Checkstate');
    expect(html).toContain('auth required');
    expect(scanReportCopy(html)).toEqual([]);
  });

  it('v3 sample correctly identifies BLS12-381 keyset and skips secp DLEQ', async () => {
    const sample = SAMPLES.v3;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('v3');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });

    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    expect(html).toContain('verdict amber');
    expect(html).toContain('V3');
    expect(html).toContain('V3 keyset');
    expect(scanReportCopy(html)).toEqual([]);
  });

  it('pipeline groups derivation and DLEQ into steps with sub-steps', async () => {
    const sample = SAMPLES.clean;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('clean');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    // Seven steps, in pipeline order
    expect(html).toContain('Verification pipeline');
    const stepNames = [...html.matchAll(/<span class="step-name">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(stepNames).toEqual([
      'Token decode',
      'Mint facts',
      'Keyset ID derivation',
      'Residue screen',
      'Keyset age',
      'DLEQ',
      'Checkstate',
    ]);
    // Grouped steps show a count, with the per-keyset results as sub-steps
    expect(html).toContain('2 keysets recomputed, both match');
    expect(html).toContain('Keyset 00e1577700e127f1 recomputes to 00e1577700e127f1');
    expect(html).toContain('DLEQ absent on 2 proofs');
    expect(html).toContain('Proof 0: DLEQ absent');
    // The residue full result is in the expanded detail, not lost
    expect(html).toContain('V2 keysets are excluded because the NUT-13 residue collision applies');
    // Verdict counts live in the verdict card, the separate strip is gone
    expect(html).toContain('class="counts"');
    expect(html).not.toContain('summary-strip');
    expect(html).not.toContain('group-label');
    // The three sections are one panel now
    expect(html).toContain('class="limits-panel"');
    expect(html).not.toContain('class="cols"');
    expect(scanReportCopy(html)).toEqual([]);
  });

  it('evil pipeline opens the flagged residue step with the diagram inside', async () => {
    const sample = SAMPLES.evil;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('evil');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    // The flagged step and the Checkstate step (amber without consent)
    // start open, the passed steps start closed
    const openSteps = [...html.matchAll(/<details class="step" open/g)].length;
    expect(openSteps).toBe(2);
    expect(html).toContain('COLLISION: residue 1138537334');
    expect(html).toContain('status hold');
    expect(html).toContain('Collision');
    // The diagram sits inside the residue step, not as its own section
    const diagramPos = html.indexOf('The collision, drawn out');
    const residuePos = html.indexOf('Residue screen');
    expect(diagramPos).toBeGreaterThan(residuePos);
    expect(html).toContain('Two keysets, one residue. That is the attack.');
    // The diagram shows the two distinct keysets that share the residue:
    // the token keyset and the known keyset, not the token keyset twice
    // (the mint lists the same keyset the token uses, so that entry is
    // the same ID and is not a side of the collision).
    expect(html).toContain('Keyset A</div><div class="nv">00102821<span class="hl">c3bc6333</span>');
    expect(html).toContain('Keyset B</div><div class="nv">00206785<span class="hl">c39be46b</span>');
    // Verdict counts show the one step that needs attention
    expect(html).toContain('Needs attention');
    expect(scanReportCopy(html)).toEqual([]);
  });

  it('partial DLEQ pipeline shows the incomplete step open with an Incomplete badge', async () => {
    const sample = SAMPLES.partial;
    const rawToken = await parseTokenRaw(sample.token);
    const fetchFn = getSampleFetchFn('partial');

    const report = await diagnoseToken(sample.token, {
      fetchFn,
      consent: false,
      knownKeysets: sample.knownKeysets,
    });

    const html = renderReportHtml(report, {
      sampleName: sample.name,
      sampleDescription: sample.description,
      isSample: true,
      rawToken,
    });

    expect(html).toContain('A proof carries an incomplete DLEQ');
    expect(html).toContain('Incomplete');
    const openSteps = [...html.matchAll(/<details class="step" open/g)].length;
    expect(openSteps).toBe(2);
    expect(scanReportCopy(html)).toEqual([]);
  });
});

describe('web report: consent dialog and privacy guarantees', () => {
  it('checkstate request never fires without explicit consent', async () => {
    let checkstateCalls = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.endsWith('/v1/checkstate')) {
        checkstateCalls++;
        return getSampleFetchFn('clean')(url, init);
      }
      return getSampleFetchFn('clean')(url, init);
    };

    // Run without consent
    const reportNoConsent = await diagnoseToken(SAMPLES.clean.token, {
      fetchFn: countingFetch,
      consent: false,
    });

    expect(checkstateCalls).toBe(0);
    const checkstateEntry = reportNoConsent.notChecked.find((c) => c.checkId === 'checkstate');
    expect(checkstateEntry).toBeDefined();
    expect(checkstateEntry?.result).toContain('Consent not given');

    // Run with consent
    const reportWithConsent = await diagnoseToken(SAMPLES.clean.token, {
      fetchFn: countingFetch,
      consent: true,
    });

    expect(checkstateCalls).toBeGreaterThan(0);
    const checkstateRun = reportWithConsent.checked.find((c) => c.checkId === 'checkstate');
    expect(checkstateRun).toBeDefined();
  });
});

describe('web report: static index.html and accessibility checks', () => {
  const indexHtml = readFileSync(path.join(root, 'index.html'), 'utf8');
  const appHtml = readFileSync(path.join(root, 'app.html'), 'utf8');

  it('app.html carries the T4 banner', () => {
    expect(appHtml).toContain('NutCheck never spends. If you pasted for recovery, use a wallet restore (NUT-13).');
    expect(appHtml).toContain('class="t4-banner"');
    expect(appHtml).toContain('role="note"');
  });

  it('landing page links to the checker app and keeps the faq', () => {
    expect(indexHtml).toContain('href="/app.html"');
    expect(indexHtml).toContain('aria-expanded');
    expect(indexHtml).not.toContain('id="checker"');
    expect(indexHtml).not.toContain('id="token"');
  });

  it('app.html contains required semantic regions and aria labels', () => {
    expect(appHtml).toContain('aria-label="token checker"');
    expect(appHtml).toContain('aria-label="report"');
    expect(appHtml).toContain('role="status"');
    expect(appHtml).toContain('aria-live="polite"');
  });

  it('index.html is free of banned words in verdict copy', () => {
    expect(scanReportCopy(indexHtml)).toEqual([]);
    for (const word of BANNED_WORDS) {
      expect(indexHtml.toLowerCase()).not.toContain(` ${word} `);
    }
  });

  it('local token decoding runs in well under 2 seconds', async () => {
    const start = performance.now();
    const raw = await parseTokenRaw(SAMPLES.clean.token);
    const elapsed = performance.now() - start;

    expect(raw.proofs.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });

  it('all 8 samples have valid decodable tokens', async () => {
    for (const [key, sample] of Object.entries(SAMPLES)) {
      const parsed = await parseTokenRaw(sample.token);
      expect(parsed.proofs.length).toBeGreaterThan(0);
    }
  });

  it('offline real token runs decode and residue screen locally when mint is unreachable', async () => {
    const offlineFetch: typeof fetch = async () => {
      throw new Error('network down: offline');
    };

    // A pasted real token with no stubbed answers
    const report = await diagnoseToken(SAMPLES.clean.token, {
      fetchFn: offlineFetch,
      consent: false,
      knownKeysets: ['00e1577700e127f1'],
    });

    expect(report.headline).toBe('Not fully checked.');
    expect(report.severity).toBe('amber');

    // Decode and residue screen ran locally
    const decodeCheck = report.checked.find((c) => c.checkId === 'decode');
    expect(decodeCheck).toBeDefined();
    expect(decodeCheck?.outcome).toBe('pass');
    expect(decodeCheck?.message).toContain('mint keyset list was not available');

    const residueCheck = report.checked.find((c) => c.checkId === 'residue');
    expect(residueCheck).toBeDefined();
    expect(residueCheck?.outcome).toBe('pass');
    expect(residueCheck?.result).toMatch(/No collision found across \d+ V1 keysets/);
    expect(residueCheck?.result).toContain('excluded');

    // Proof state is reported under not checked when offline
    const proofStateCheck = report.notChecked.find((c) => c.checkId === 'checkstate');
    expect(proofStateCheck).toBeDefined();
    expect(proofStateCheck?.result).toBe('Not checked, consent not given');

    // Mint facts failed
    const mintCheck = report.notChecked.find((c) => c.checkId === 'mint');
    expect(mintCheck).toBeDefined();
    expect(mintCheck?.severity).toBe('amber');
    expect(mintCheck?.result).toBe('The mint did not answer');
  });

  it('plain-text report export prints mint fingerprint, never raw mint URL', async () => {
    const rawToken = await parseTokenRaw(SAMPLES.clean.token);
    const report = await diagnoseToken(SAMPLES.clean.token, {
      fetchFn: getSampleFetchFn('clean'),
      consent: false,
    });

    const text = reportToPlainText(report, {
      sampleName: 'Clean sample',
      rawToken,
    });

    // Contains 8-char hex fingerprint
    expect(text).toMatch(/^Mint: [0-9a-f]{8}$/m);
    // Never contains the raw URL
    expect(text).not.toContain('https://testnut.cashu.space');
    expect(scanReportCopy(text)).toEqual([]);
  });

  it('page headline and copy button plain-text export show the same report headline', async () => {
    // Clean token
    const cleanRaw = await parseTokenRaw(SAMPLES.clean.token);
    const cleanReport = await diagnoseToken(SAMPLES.clean.token, {
      fetchFn: getSampleFetchFn('clean'),
      consent: false,
    });
    // Assert the headline matches the expected literal for the scenario.
    expect(cleanReport.headline).toBe(SAMPLES.clean.expectedHeadline);
    expect(cleanReport.headline).toBe('Not fully checked.');
    const cleanHtml = renderReportHtml(cleanReport, { rawToken: cleanRaw });
    const cleanText = reportToPlainText(cleanReport, { rawToken: cleanRaw });
    expect(cleanHtml).toContain(`<h2>${cleanReport.headline}</h2>`);
    expect(cleanText).toContain(`Headline: ${cleanReport.headline}`);

    // Spent token
    const spentRaw = await parseTokenRaw(SAMPLES.spent.token);
    const spentReport = await diagnoseToken(SAMPLES.spent.token, {
      fetchFn: getSampleFetchFn('spent'),
      consent: true,
    });
    // Assert the spent headline matches the expected literal after consent.
    expect(spentReport.headline).toBe(SAMPLES.spent.expectedHeadlineAfterConsent);
    expect(spentReport.headline).toBe('Hold, here is why.');
    const spentHtml = renderReportHtml(spentReport, { rawToken: spentRaw });
    const spentText = reportToPlainText(spentReport, { rawToken: spentRaw });
    expect(spentHtml).toContain(`<h2>${spentReport.headline}</h2>`);
    expect(spentText).toContain(`Headline: ${spentReport.headline}`);
  });

  it('clean sample without DLEQ does not claim signatures match', async () => {
    const rawToken = await parseTokenRaw(SAMPLES.clean.token);
    const report = await diagnoseToken(SAMPLES.clean.token, {
      fetchFn: getSampleFetchFn('clean'),
      consent: true,
    });
    const html = renderReportHtml(report, { rawToken });
    expect(html).toContain('the signature check did not run');
    expect(html).not.toContain('the signatures match');
  });

  it('undecodable token shows unknown for format and amount without invented facts', () => {
    const dummyReport: NutCheckReport = {
      headline: 'Hold, here is why.',
      severity: 'amber',
      mint: undefined,
      unit: undefined,
      checked: [],
      notChecked: [
        {
          name: 'Token decode',
          checkId: 'decode',
          result: 'invalid token',
          outcome: 'error',
          severity: 'amber',
          message: 'could not parse',
        },
      ],
      cannotProve: ['Mint honesty'],
    };
    const html = renderReportHtml(dummyReport);
    expect(html).toContain('<div class="k">Format</div><div class="v">(unknown)</div>');
    expect(html).toContain('<div class="k">Amount</div><div class="v">(unknown)</div>');
    expect(html).not.toContain('Mint facts recomputed and verified locally');
  });

  it('all sample configurations have consent set to false', () => {
    for (const sample of Object.values(SAMPLES)) {
      expect(sample.consent).toBe(false);
    }
  });
});

describe('web checker: premium instrument panel', () => {
  const appHtml = readFileSync(path.join(root, 'app.html'), 'utf8');

  it('app.html carries the instrument panel with the token field and the facts line', () => {
    expect(appHtml).toContain('class="instrument"');
    expect(appHtml).toContain('aria-label="token checker"');
    expect(appHtml).toContain('id="token"');
    expect(appHtml).toContain('Paste a Cashu token here');
    expect(appHtml).toContain('id="token-facts"');
    expect(appHtml).toContain('Decoded on your device. Nothing leaves it until you check.');
    expect(appHtml).toContain('Starts with cashuB or cashuA');
  });

  it('app.html has the check button disabled until there is a token', () => {
    expect(appHtml).toContain('id="check-btn"');
    expect(appHtml).toContain('Check token');
    const btnAt = appHtml.indexOf('id="check-btn"');
    const btnTag = appHtml.slice(appHtml.lastIndexOf('<button', btnAt), btnAt + 40);
    expect(btnTag).toContain('disabled');
  });

  it('app.html has the trusted keysets and the mint check as quiet controls', () => {
    expect(appHtml).toContain('Trusted keysets');
    expect(appHtml).toContain('id="known"');
    // The keysets placeholder must read as an example, not a value: a bare
    // hex ID looks pre-filled after Clear empties the field.
    expect(appHtml).toContain('placeholder="e.g. 009a1f293253e41e"');
    expect(appHtml).toContain('id="consent"');
    expect(appHtml).toContain('Ask the mint');
    expect(appHtml).toContain('Why this matters');
    expect(appHtml).toContain('Local checks run on your device.');
  });

  it('app.html has the samples as one row of pills with all 8 cases', () => {
    expect(appHtml).toContain('class="samples"');
    for (const key of ['clean', 'evil', 'spent', 'partial', 'pending', 'unreachable', 'auth', 'v3']) {
      expect(appHtml).toContain(`data-which="${key}"`);
    }
    expect(appHtml).toContain('Clean token');
    expect(appHtml).toContain('Evil mint token');
    expect(appHtml).toContain('Spent token');
    expect(appHtml).toContain('V3 keyset');
  });

  it('app.html no longer carries the rejected three-step checker', () => {
    expect(appHtml).not.toContain('paste-card');
    expect(appHtml).not.toContain('id="token-summary"');
    expect(appHtml).not.toContain('id="paste-zone"');
    expect(appHtml).not.toContain('id="paste-btn"');
    expect(appHtml).not.toContain('class="cases"');
    expect(appHtml).not.toContain('No token handy? Run a case');
    expect(appHtml).not.toContain('class="switch"');
    expect(appHtml).not.toContain('Paste a different token');
  });

  it('token facts match the real clean token', async () => {
    const raw = await parseTokenRaw(SAMPLES.clean.token);
    expect(raw.format).toBe('cashuB');
    const total = raw.proofs.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBe(21);
    expect(raw.proofs.length).toBe(2);
    expect(raw.mints[0]).toBe('https://testnut.cashu.space');
    expect(raw.keysetIds).toContain('00e1577700e127f1');
    expect(raw.keysetIds).toContain('016120b31266f218');
    expect(classifyKeysetVersion('00e1577700e127f1')).toBe('v1');
    expect(classifyKeysetVersion('016120b31266f218')).toBe('v2');
  });

  it('token facts match the real evil token', async () => {
    const raw = await parseTokenRaw(SAMPLES.evil.token);
    expect(raw.format).toBe('cashuB');
    const total = raw.proofs.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBe(1);
    expect(raw.proofs.length).toBe(1);
    expect(raw.keysetIds).toContain('00102821c3bc6333');
    expect(classifyKeysetVersion('00102821c3bc6333')).toBe('v1');
  });
});
