// NutCheck web application entry point.
// Connects the diagnostic engine to the interactive user interface.
import './shims.js';
import { diagnoseToken, type NutCheckReport } from '../report.js';
import { parseTokenRaw, type RawToken } from '../rawParser.js';
import { SAMPLES, getSampleFetchFn, type SampleToken } from './samples.js';
import { renderReportHtml, reportToPlainText } from './render.js';

let activeSampleKey: string | null = null;
let lastReport: NutCheckReport | null = null;
let lastRawToken: RawToken | undefined = undefined;
let lastSampleName = 'Clean token';

function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Element with id #${id} not found`);
  }
  return el as T;
}

function parseKnownKeysets(text: string): string[] {
  return text
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function showMessage(text: string): void {
  const msgEl = document.getElementById('msg');
  if (!msgEl) return;
  if (text) {
    msgEl.textContent = text;
    msgEl.classList.add('show');
  } else {
    msgEl.textContent = '';
    msgEl.classList.remove('show');
  }
}

// The token facts line. When the pasted token parses, this line shows
// what the token actually is: format, amount, mint, and keyset count.
// The token itself stays visible in the textarea, never hidden behind
// a summary card. When the field is empty, the line shows a hint. When
// the token does not parse, it says so plainly.
async function updateTokenFacts(): Promise<void> {
  const tokenBox = document.getElementById('token') as HTMLTextAreaElement | null;
  const facts = document.getElementById('token-facts');
  if (!tokenBox || !facts) return;

  const raw = tokenBox.value.trim();
  updateCheckButton();

  if (!raw) {
    facts.innerHTML = '';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Decoded on your device. Nothing leaves it until you check.';
    facts.appendChild(hint);
    return;
  }

  let parsed: RawToken | undefined;
  try {
    parsed = await parseTokenRaw(raw);
  } catch {
    parsed = undefined;
  }

  // Only apply the result if the token has not changed while parsing.
  if (tokenBox.value.trim() !== raw) return;

  facts.innerHTML = '';
  if (!parsed) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Not a Cashu token yet. It starts with cashuB or cashuA.';
    facts.appendChild(hint);
    return;
  }

  const fmt = document.createElement('span');
  fmt.className = 'fmt';
  fmt.textContent = parsed.format === 'cashuA' ? 'cashuA, v3' : 'cashuB, v4';
  facts.appendChild(fmt);

  const total = parsed.proofs.reduce((sum, p) => sum + p.amount, 0);
  const unit = parsed.unit || 'sat';
  const count = parsed.proofs.length;
  const mint = parsed.mints[0]
    ? parsed.mints[0].replace(/^https?:\/\//, '').replace(/\/$/, '')
    : 'unknown mint';
  const ftext = document.createElement('span');
  ftext.className = 'ftext';
  ftext.textContent = `${total} ${unit} \u00b7 ${count} proof${count === 1 ? '' : 's'} \u00b7 ${mint} \u00b7 ${parsed.keysetIds.length} keyset${parsed.keysetIds.length === 1 ? '' : 's'}`;
  facts.appendChild(ftext);
}

// The Check button is only enabled when there is a token to check.
function updateCheckButton(): void {
  const tokenBox = document.getElementById('token') as HTMLTextAreaElement | null;
  const checkBtn = document.getElementById('check-btn') as HTMLButtonElement | null;
  if (!tokenBox || !checkBtn) return;
  checkBtn.disabled = tokenBox.value.trim().length === 0;
}

function fallbackCopyText(text: string, onDone: () => void): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    // ignore
  }
  document.body.removeChild(ta);
  onDone();
}

function copyReport(): void {
  if (!lastReport) return;
  const copyBtn = document.getElementById('copy-btn');
  const plainText = reportToPlainText(lastReport, {
    sampleName: lastSampleName,
    rawToken: lastRawToken,
  });

  const onDone = () => {
    if (copyBtn) {
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('done');
      setTimeout(() => {
        copyBtn.textContent = 'Copy report as text';
        copyBtn.classList.remove('done');
      }, 2000);
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(plainText).then(onDone, () => fallbackCopyText(plainText, onDone));
  } else {
    fallbackCopyText(plainText, onDone);
  }
}

// Incremented for each runCheck call. A late async response only renders
// if its request ID still matches the latest one.
let currentRequestId = 0;

async function runCheck(scrollIntoView = false): Promise<void> {
  const requestId = ++currentRequestId;
  const tokenBox = getElement<HTMLTextAreaElement>('token');
  const knownBox = getElement<HTMLInputElement>('known');
  const consentBox = getElement<HTMLInputElement>('consent');
  const checkBtn = getElement<HTMLButtonElement>('check-btn');
  const reportContainer = getElement<HTMLDivElement>('report');

  const rawInput = tokenBox.value.trim();
  if (!rawInput) {
    showMessage('Paste a Cashu token first, or run one of the cases below.');
    tokenBox.focus();
    return;
  }

  showMessage('');
  const originalBtnText = checkBtn.textContent;
  checkBtn.disabled = true;
  checkBtn.innerHTML = '<span class="loading" aria-hidden="true"></span> checking...';

  const knownKeysets = parseKnownKeysets(knownBox.value);
  const consent = consentBox.checked;

  // Determine if this is a sample run from an active sample button click
  const isSample = activeSampleKey !== null && SAMPLES[activeSampleKey]?.token === rawInput;
  const sampleObj = isSample && activeSampleKey ? SAMPLES[activeSampleKey] : undefined;

  const sampleNameForReport = sampleObj ? `${sampleObj.name} (sample demo)` : 'Custom token';

  try {
    // Attempt raw parsing first for UI token facts. Keep the result in a
    // run-local variable so an overlapping run cannot overwrite it.
    let rawTokenParsed: RawToken | undefined;
    try {
      rawTokenParsed = await parseTokenRaw(rawInput);
    } catch {
      rawTokenParsed = undefined;
    }

    // Pick mock fetch ONLY if user actually clicked a sample button and token is untouched
    const fetchFn = sampleObj ? getSampleFetchFn(sampleObj.key) : undefined;

    const report = await diagnoseToken(rawInput, {
      fetchFn,
      consent,
      knownKeysets,
    });

    // Only render if this is still the latest request and the token
    // has not changed since the check started.
    if (requestId !== currentRequestId) return;
    if (tokenBox.value.trim() !== rawInput) return;

    // Update shared display state only after the guard passes, so an
    // overlapping run cannot mix one token's report with another's facts.
    lastReport = report;
    lastRawToken = rawTokenParsed;
    lastSampleName = sampleNameForReport;

    const html = renderReportHtml(report, {
      sampleName: lastSampleName,
      sampleDescription: sampleObj?.description,
      isSample: isSample,
      knownKeysets,
      rawToken: lastRawToken,
    });

    reportContainer.innerHTML = html;

    const copyBtn = document.getElementById('copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', copyReport);
    }

    if (scrollIntoView && reportContainer.scrollIntoView) {
      reportContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error during token diagnostics';
    showMessage(`Diagnostic check halted: ${errMsg}`);
  } finally {
    checkBtn.textContent = originalBtnText;
    updateCheckButton();
  }
}

function loadSample(key: string, autoRun = true): void {
  const sample = SAMPLES[key];
  if (!sample) return;

  activeSampleKey = key;
  showMessage('');

  const tokenBox = getElement<HTMLTextAreaElement>('token');
  const knownBox = getElement<HTMLInputElement>('known');
  const consentBox = getElement<HTMLInputElement>('consent');

  tokenBox.value = sample.token;
  knownBox.value = sample.knownKeysets.join(', ');
  consentBox.checked = false;

  document.querySelectorAll<HTMLButtonElement>('.samples .sample').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-which') === key);
  });

  void updateTokenFacts();

  if (autoRun) {
    runCheck(false);
  }
}

function clearForm(): void {
  const tokenBox = document.getElementById('token') as HTMLTextAreaElement | null;
  const knownBox = document.getElementById('known') as HTMLInputElement | null;
  const consentBox = document.getElementById('consent') as HTMLInputElement | null;
  const reportContainer = document.getElementById('report');
  const copyBtn = document.getElementById('copy-btn');
  if (tokenBox) {
    tokenBox.value = '';
    tokenBox.focus();
  }
  if (knownBox) {
    knownBox.value = '';
  }
  if (consentBox) {
    consentBox.checked = false;
  }
  activeSampleKey = null;
  document.querySelectorAll<HTMLButtonElement>('.samples .sample').forEach((btn) => {
    btn.classList.remove('active');
  });
  showMessage('');
  lastReport = null;
  lastRawToken = undefined;
  lastSampleName = '';
  if (reportContainer) {
    reportContainer.innerHTML = '';
  }
  if (copyBtn) {
    copyBtn.style.display = 'none';
  }
  void updateTokenFacts();
}

export function initApp(): void {
  const tokenBox = document.getElementById('token') as HTMLTextAreaElement | null;
  const consentBox = document.getElementById('consent') as HTMLInputElement | null;
  const checkBtn = document.getElementById('check-btn');
  const clearBtn = document.getElementById('clear-btn');
  const consentDialog = document.getElementById('consent-dialog') as HTMLDialogElement | null;
  const consentConfirm = document.getElementById('consent-confirm');
  const consentCancel = document.getElementById('consent-cancel');

  if (checkBtn) {
    checkBtn.addEventListener('click', () => runCheck(true));
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => clearForm());
  }

  const knownBox = document.getElementById('known') as HTMLInputElement | null;
  if (knownBox) {
    knownBox.addEventListener('input', () => {
      // Changing the supplied keysets invalidates any pending run and
      // clears the stale report, since the residue screen covers only
      // the lists actually supplied.
      const reportContainer = document.getElementById('report');
      if (reportContainer) {
        reportContainer.innerHTML = '';
      }
      lastReport = null;
      lastRawToken = undefined;
      lastSampleName = '';
      currentRequestId++;
    });
  }

  if (tokenBox) {
    tokenBox.addEventListener('input', () => {
      showMessage('');
      activeSampleKey = null;
      if (consentBox) {
        consentBox.checked = false;
      }
      // Clear the displayed report immediately. Findings for the old token
      // must not stay on screen, and Copy must not export the old report.
      const reportContainer = document.getElementById('report');
      if (reportContainer) {
        reportContainer.innerHTML = '';
      }
      lastReport = null;
      lastRawToken = undefined;
      lastSampleName = '';
      // Invalidate any pending request so a late response cannot render.
      currentRequestId++;
      document.querySelectorAll<HTMLButtonElement>('.samples .sample').forEach((btn) => {
        btn.classList.remove('active');
      });
      void updateTokenFacts();
    });

    tokenBox.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        runCheck(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        clearForm();
      }
    });

    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearForm();
      }
    });
  }

  // Token the consent dialog was opened for. Confirmation only applies
  // to this token; if the input changes while the dialog is open, the
  // confirmation is discarded and fresh consent is required.
  let dialogToken = '';

  if (consentBox) {
    consentBox.addEventListener('click', (e) => {
      if (consentBox.checked) {
        e.preventDefault();
        // Revert the checkbox now, then set it after confirmation. Setting
        // checked inside a cancelled click can be undone by the browser.
        consentBox.checked = false;
        // Capture the token visible when the dialog opened.
        dialogToken = tokenBox?.value ?? '';
        if (consentDialog && typeof consentDialog.showModal === 'function') {
          consentDialog.showModal();
        } else {
          const ok = window.confirm(
            'Asking a mint whether proofs are spent sends it identifiers (Y) derived from your proof secrets, so the mint learns which proofs you hold. The answer is only the mint\'s own word at one moment in time. Proceed?',
          );
          if (ok) {
            // Capture the token the user approved, so an intervening edit
            // cannot restore consent for a different token.
            const approvedToken = tokenBox?.value ?? '';
            setTimeout(() => {
              // Only proceed if the token is still the one the user approved.
              if (!tokenBox || tokenBox.value !== approvedToken) return;
              consentBox.checked = true;
              runCheck(false);
            }, 0);
          }
        }
      } else {
        runCheck(false);
      }
    });
  }

  if (consentConfirm) {
    consentConfirm.addEventListener('click', () => {
      const cBox = document.getElementById('consent') as HTMLInputElement | null;
      const currentToken = tokenBox?.value ?? '';
      // Only apply consent if the token is still the one the dialog opened for.
      // If it changed, close without checking and require fresh consent.
      if (currentToken !== dialogToken) {
        if (consentDialog && typeof consentDialog.close === 'function') {
          consentDialog.close();
        }
        return;
      }
      if (cBox) cBox.checked = true;
      if (consentDialog && typeof consentDialog.close === 'function') {
        consentDialog.close();
      }
      runCheck(false);
    });
  }

  if (consentCancel) {
    consentCancel.addEventListener('click', () => {
      const cBox = document.getElementById('consent') as HTMLInputElement | null;
      if (cBox) cBox.checked = false;
      if (consentDialog && typeof consentDialog.close === 'function') {
        consentDialog.close();
      }
    });
  }

  if (consentDialog) {
    consentDialog.addEventListener('cancel', () => {
      const cBox = document.getElementById('consent') as HTMLInputElement | null;
      if (cBox) cBox.checked = false;
    });
  }

  document.querySelectorAll<HTMLButtonElement>('.samples .sample').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.getAttribute('data-which');
      if (which) {
        loadSample(which, true);
      }
    });
  });

  // Accordion for FAQ
  document.querySelectorAll('.faq-item').forEach((item) => {
    const q = item.querySelector('.faq-q');
    if (!q) return;
    q.addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach((o) => {
        o.classList.remove('open');
        const trigger = o.querySelector('.faq-q');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      });
      if (!wasOpen) {
        item.classList.add('open');
        q.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // Load the clean sample by default
  loadSample('clean', true);
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
