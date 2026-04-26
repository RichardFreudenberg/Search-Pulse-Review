/* ==============================================
   Pulse CRM — Granola Meeting Intelligence  v3
   -----------------------------------------------
   Connects to the Granola local API to import
   meeting transcripts, then uses your AI key to
   clean notes, extract action items, and surface
   deal-relevant insights automatically.

   Granola local API: http://localhost:59125
   Auth: tries Bearer + x-api-key, multiple endpoints
   Get your key: Granola → Settings → Integrations
   ============================================== */

// ── Module-level connection cache ────────────────
// Once we find a working endpoint+auth combo, cache it here
let _granolaWorkingConfig = null; // { base, path, authHeader }

// Endpoint patterns to try in order
const GRANOLA_ENDPOINT_PATTERNS = [
  '/v1/documents',
  '/api/v1/documents',
  '/api/documents',
];

// ── API helpers ──────────────────────────────────

async function _granolaKey() {
  const s = await DB.get(STORES.settings, `settings_${currentUser.id}`).catch(() => null);
  return s?.granolaApiKey?.trim() || null;
}

async function _granolaBaseUrl() {
  const s = await DB.get(STORES.settings, `settings_${currentUser.id}`).catch(() => null);
  return (s?.granolaApiUrl?.trim()) || 'http://localhost:59125';
}

/**
 * Try a single fetch variant. Returns the parsed JSON on success,
 * throws on network error or non-OK status.
 */
async function _granolaAttempt(base, path, authHeaderName, key, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = {
    'Content-Type': 'application/json',
    [authHeaderName]: authHeaderName === 'Authorization' ? `Bearer ${key}` : key,
  };
  let res;
  try {
    res = await fetch(url.toString(), { headers });
  } catch (netErr) {
    // CORS from file:// or real network failure
    const msg = netErr?.message || String(netErr);
    if (msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('networkerror')) {
      throw Object.assign(
        new Error(
          'CORS blocked — serve the app from a local server (e.g. VS Code Live Server or ' +
          'python -m http.server 8080), or make sure the Granola app is running on your Mac.'
        ),
        { code: 'CORS' }
      );
    }
    throw Object.assign(new Error('Could not reach Granola — make sure the app is running.'), { code: 'NETWORK' });
  }
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error('Invalid API key — check your Granola key in Settings.'), { code: 'INVALID_KEY' });
  if (!res.ok)
    throw new Error(`Granola API error ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * Main fetch function. Uses cached working config when available,
 * otherwise probes all endpoint+auth combinations.
 */
async function _granolaFetch(path, params = {}) {
  const key = await _granolaKey();
  if (!key) throw Object.assign(new Error('No Granola API key configured.'), { code: 'NO_KEY' });

  const base = await _granolaBaseUrl();

  // If this is a specific document path (not a list endpoint), resolve it directly
  const isSpecificPath = !GRANOLA_ENDPOINT_PATTERNS.includes(path);

  // Use cached config if available (and not a specific path that overrides)
  if (_granolaWorkingConfig && !isSpecificPath) {
    try {
      return await _granolaAttempt(
        _granolaWorkingConfig.base,
        path,
        _granolaWorkingConfig.authHeader,
        key,
        params
      );
    } catch (e) {
      // Cached config failed — clear it and fall through to probe
      if (e.code !== 'CORS') _granolaWorkingConfig = null;
      else throw e;
    }
  }

  // If it's a specific path (e.g. /v1/documents/abc), try with cached base + auth
  if (isSpecificPath && _granolaWorkingConfig) {
    return _granolaAttempt(
      _granolaWorkingConfig.base,
      path,
      _granolaWorkingConfig.authHeader,
      key,
      params
    );
  }

  // Probe all combinations
  const authHeaders = ['Authorization', 'x-api-key'];
  let lastErr = null;

  for (const endpoint of GRANOLA_ENDPOINT_PATTERNS) {
    for (const authHeader of authHeaders) {
      try {
        const data = await _granolaAttempt(base, endpoint, authHeader, key, params);
        // Found a working combo — cache it
        _granolaWorkingConfig = { base, path: endpoint, authHeader };
        return data;
      } catch (e) {
        // CORS blocks all variants — surface immediately, no point retrying
        if (e.code === 'CORS') throw e;
        // Auth failures mean endpoint exists but key is wrong
        if (e.code === 'INVALID_KEY') throw e;
        lastErr = e;
        // Continue trying next combo
      }
    }
  }

  throw lastErr || new Error('Could not connect to Granola — all endpoint variants failed.');
}

/** Fetch recent meetings (returns normalised array). */
async function granolaFetchMeetings(limit = 25) {
  // Determine the correct docs endpoint (use cache if available)
  const path = (_granolaWorkingConfig?.path) || GRANOLA_ENDPOINT_PATTERNS[0];
  const data = await _granolaFetch(path, { limit });
  // Granola may return { documents:[…] } or { items:[…] } or plain array
  return Array.isArray(data) ? data : (data.documents || data.items || data.data || []);
}

/** Fetch one meeting's full details. */
async function granolaFetchMeeting(id) {
  const base = (_granolaWorkingConfig?.path) || GRANOLA_ENDPOINT_PATTERNS[0];
  // Build per-document path by appending id to whichever endpoint worked
  return _granolaFetch(`${base}/${id}`);
}

/** Ping the API — returns { ok, error }. */
async function granolaTestConnection() {
  // Clear cache so we re-probe on test
  _granolaWorkingConfig = null;
  try {
    await granolaFetchMeetings(1);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

// ── Text normalisation ───────────────────────────

function _transcriptToText(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map(seg => {
      const speaker = seg.speaker || seg.speakerName || seg.name || 'Speaker';
      const text    = seg.text || seg.content || seg.words || '';
      const ts      = seg.start_time != null ? ` [${_fmtTs(seg.start_time)}]` : '';
      return `${speaker}${ts}: ${text}`;
    }).filter(l => l.includes(':') && l.split(':')[1].trim()).join('\n');
  }
  return JSON.stringify(raw);
}

function _fmtTs(secs) {
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function _fmtDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── AI processing ────────────────────────────────

/**
 * Run AI on a call to produce cleaned notes, action items, deal insights.
 * Returns parsed JSON object.
 */
async function granolaProcessMeeting(call, deal) {
  const settings = await DB.get(STORES.settings, `settings_${currentUser.id}`).catch(() => null);
  if (!settings?.openaiApiKey && !settings?.claudeApiKey)
    throw Object.assign(new Error('No AI API key configured.'), { code: 'NO_AI_KEY' });

  const src = call.granolaNotes || _transcriptToText(call.rawTranscript) || '';
  if (!src.trim()) throw new Error('No transcript or notes to process.');

  const dealCtx = deal ? `
DEAL CONTEXT (do not invent data not in the transcript):
- Company: ${deal.name}
- Sector: ${deal.sector || 'Unknown'}
- Revenue: ${deal.revenue ? '$' + (deal.revenue / 1e6).toFixed(1) + 'M' : 'Unknown'}
- EBITDA: ${deal.ebitda ? '$' + (deal.ebitda / 1e6).toFixed(1) + 'M' : 'Unknown'}
- Stage: ${deal.stage}
` : '';

  const raw = await callAI(
    'You are an expert M&A analyst for a search fund. Analyse meeting transcripts to extract structured deal intelligence. Return ONLY valid JSON — no markdown fences, no preamble.',
    `Analyse the transcript/notes below and return a single JSON object.${dealCtx}

JSON STRUCTURE (use null for missing fields):
{
  "meetingTitle": "Concise descriptive title for this specific meeting",
  "summary": "3–4 sentence executive summary: what was discussed, decisions made, key outcomes",
  "keyInsights": ["insight relevant to the acquisition", "…"],
  "actionItems": [
    { "task": "Specific action to complete", "owner": "Searcher / Seller / Advisor", "dueContext": "by next call / within 1 week / etc." }
  ],
  "positiveSignals": ["encouraging signal about this deal", "…"],
  "redFlags": ["concern or risk surfaced in the call", "…"],
  "sellerSentiment": "positive|neutral|negative|unknown",
  "dealProgress": "advancing|stalled|early|unclear",
  "nextMeetingContext": "What should be prepared / discussed in the next meeting, or null",
  "dealUpdates": {
    "revenue": <annual revenue USD number if mentioned, else null>,
    "ebitda": <EBITDA USD number if mentioned, else null>,
    "employeeCount": <headcount integer if mentioned, else null>,
    "ownerSituation": "string if discussed, else null",
    "askingPrice": <USD number if mentioned, else null>,
    "concerns": "any new risk or concern not already captured, or null"
  }
}

TRANSCRIPT / NOTES:
${src.substring(0, 14000)}`,
    1500, 0.05
  );

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]+\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  }
  if (!parsed) throw new Error('AI returned invalid JSON — please try again.');
  return parsed;
}

// ── IndexedDB helpers ────────────────────────────
// All calls go to STORES.calls (not STORES.dealCalls)

async function _callsSave(record) {
  await DB.put(STORES.calls, { ...record, updatedAt: new Date().toISOString() });
}

async function _callsForDeal(dealId) {
  const allCalls = await DB.getForUser(STORES.calls, currentUser.id).catch(() => []);
  return allCalls.filter(c => c.dealId === dealId);
}

async function _callDelete(id) {
  await DB.delete(STORES.calls, id).catch(() => {});
}

// ── Import flow ──────────────────────────────────

/** Open the Granola meeting picker modal. */
async function granolaOpenImportModal(dealId) {
  openModal('Import from Granola', `
    <div class="p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-10 h-10 rounded-xl bg-[#7C5CFC]/10 flex items-center justify-center flex-shrink-0">
          ${_gIcon(20)}
        </div>
        <div>
          <p class="text-sm font-semibold">Select a Granola Meeting</p>
          <p class="text-xs text-surface-400 mt-0.5">Choose a recent meeting to import into this deal</p>
        </div>
      </div>
      <div id="g-pick-list">
        <div class="flex items-center gap-2.5 py-6 text-sm text-surface-400">
          <svg class="w-4 h-4 animate-spin flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 12a8 8 0 018-8v8z"/></svg>
          Fetching recent meetings from Granola…
        </div>
      </div>
    </div>
  `);

  let meetings = [];
  try {
    meetings = await granolaFetchMeetings(30);
  } catch (e) {
    const el = document.getElementById('g-pick-list');
    if (el) el.innerHTML = _gErrorHtml(e);
    return;
  }

  const listEl = document.getElementById('g-pick-list');
  if (!listEl) return;

  if (!meetings.length) {
    listEl.innerHTML = `<div class="py-10 text-center text-sm text-surface-400">No meetings found. Record a meeting in Granola first.</div>`;
    return;
  }

  listEl.innerHTML = `
    <div class="space-y-1.5 max-h-80 overflow-y-auto pr-0.5 -mr-1">
      ${meetings.map(m => {
        const title   = m.title || m.name || 'Untitled Meeting';
        const rawDate = m.created_at || m.createdAt || m.date || m.startTime;
        const dateStr = rawDate
          ? new Date(rawDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
          : '';
        const dur = _fmtDuration(m.duration || m.durationSeconds);
        return `
          <button onclick="granolaImportMeeting('${escapeHtml(String(m.id))}', '${dealId}')"
            class="w-full text-left px-3 py-2.5 rounded-xl border border-surface-200 dark:border-surface-700 hover:border-[#7C5CFC]/50 hover:bg-[#7C5CFC]/5 transition-all group">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium truncate group-hover:text-[#7C5CFC]">${escapeHtml(title)}</p>
                ${dateStr || dur ? `<p class="text-xs text-surface-400 mt-0.5">${[dateStr, dur].filter(Boolean).join(' · ')}</p>` : ''}
              </div>
              <svg class="w-4 h-4 text-surface-300 group-hover:text-[#7C5CFC] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            </div>
          </button>`;
      }).join('')}
    </div>`;
}

/** Fetch from Granola, save to STORES.calls, AI-process, refresh tab. */
async function granolaImportMeeting(meetingId, dealId) {
  const listEl = document.getElementById('g-pick-list');
  if (listEl) listEl.innerHTML = `
    <div class="py-10 text-center space-y-3">
      <svg class="w-8 h-8 text-[#7C5CFC] animate-spin mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 12a8 8 0 018-8v8z"/></svg>
      <p class="text-sm text-surface-500 font-medium">Importing & processing with AI…</p>
      <p class="text-xs text-surface-400">Usually takes 10–20 seconds</p>
    </div>`;

  try {
    const [raw, deal] = await Promise.all([
      granolaFetchMeeting(meetingId),
      DB.get(STORES.deals, dealId),
    ]);

    const aiSummary = raw.notes || raw.summary || raw.content || '';
    const actionItems = [];

    const call = {
      id:               generateId(),
      userId:           currentUser.id,
      contactId:        null,
      participantIds:   [],
      dealId,
      date:             raw.created_at || raw.createdAt || new Date().toISOString(),
      duration:         raw.duration || raw.durationSeconds || null,
      outcome:          'Granola Import',
      notes:            aiSummary,
      nextSteps:        null,
      followUpDate:     null,
      tasks:            actionItems,
      // Granola-specific extras
      granolaId:        meetingId,
      title:            raw.title || raw.name || 'Untitled Meeting',
      rawTranscript:    raw.transcript || raw.transcription || null,
      granolaNotes:     aiSummary,
      cleanedNotes:     null,
      aiSummary:        null,
      keyInsights:      [],
      redFlags:         [],
      positiveSignals:  [],
      sellerSentiment:  null,
      dealProgress:     null,
      nextMeetingContext: null,
      source:           'granola',
      processedAt:      null,
      createdAt:        new Date().toISOString(),
      updatedAt:        new Date().toISOString(),
    };

    await DB.add(STORES.calls, call);

    // AI processing (best-effort)
    const hasContent = (call.granolaNotes?.length > 100) || (_transcriptToText(call.rawTranscript).length > 100);
    if (hasContent) {
      try {
        const ai = await granolaProcessMeeting(call, deal);
        _applyAIToCall(call, ai);
        // Sync AI results back to standard fields
        call.notes     = call.aiSummary || call.notes;
        call.nextSteps = call.nextMeetingContext || null;
        call.tasks     = (call.actionItems || []).map(a => ({
          text:           a.task || (typeof a === 'string' ? a : ''),
          assignedToName: a.owner || null,
          dueDate:        null,
        }));
        await _callsSave(call);
        await _applyDealUpdates(ai.dealUpdates, deal, dealId);
      } catch (aiErr) {
        console.warn('[Granola] AI step failed (import continues):', aiErr.message);
      }
    }

    await logDealHistory(dealId, 'call_imported', { callId: call.id, title: call.title, source: 'granola' });

    closeModal();
    showToast(`✓ "${call.title}" imported${call.processedAt ? ' & AI-analysed' : ''}`, 'success');
    if (typeof currentDealId !== 'undefined' && currentDealId === dealId) switchDealTab('calls');

  } catch (e) {
    const el = document.getElementById('g-pick-list');
    if (el) el.innerHTML = _gErrorHtml(e);
  }
}

// ── Manual call logging ──────────────────────────

// Module-level cache for the pending manual call data
let _gManPendingCall = null;

function granolaOpenManualModal(dealId) {
  openModal(`
    <div class="p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-[#7C5CFC]/10 flex items-center justify-center flex-shrink-0">
          ${_gIcon(18)}
        </div>
        <div>
          <h3 class="text-sm font-bold">Log a Call</h3>
          <p class="text-xs text-surface-400 mt-0.5">Enter details or paste meeting notes — AI will extract insights automatically</p>
        </div>
      </div>

      <!-- Step 1: form -->
      <div id="g-man-step1" class="space-y-4">
        <div>
          <label class="block text-sm font-semibold mb-1.5">Meeting Title <span class="text-red-400">*</span></label>
          <input type="text" id="g-man-title" class="input-field" placeholder="e.g., Intro call with founder — Acme Co." />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-sm font-semibold mb-1.5">Date &amp; Time</label>
            <input type="datetime-local" id="g-man-date" class="input-field" value="${new Date().toISOString().slice(0,16)}" />
          </div>
          <div>
            <label class="block text-sm font-semibold mb-1.5">Duration (min)</label>
            <input type="number" id="g-man-dur" class="input-field" placeholder="45" min="1" max="480" />
          </div>
        </div>
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-sm font-semibold">Notes / Transcript <span class="text-red-400">*</span></label>
            <span class="text-xs text-surface-400">Paste transcript for AI analysis</span>
          </div>
          <textarea id="g-man-notes" class="input-field h-36 resize-none font-mono text-xs leading-relaxed"
            placeholder="Paste a meeting transcript, your notes, or a bullet-point summary here.&#10;AI will clean, structure, and extract action items, red flags, and insights automatically…"></textarea>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <button type="button" onclick="closeModal()" class="btn-secondary">Cancel</button>
          <button type="button" id="g-man-process" onclick="granolaPreviewManual('${dealId}')"
            class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-[#7C5CFC] hover:bg-[#6B4EE6] text-white shadow-sm transition-all">
            ${_gIcon(13)} Process with AI
          </button>
        </div>
      </div>

      <!-- Step 2: AI preview (hidden until processing done) -->
      <div id="g-man-step2" class="hidden space-y-4">
        <div id="g-man-preview-content" class="space-y-3 max-h-80 overflow-y-auto pr-1"></div>
        <div class="flex justify-between gap-2 pt-2 border-t border-surface-100 dark:border-surface-800">
          <button type="button" onclick="granolaManualBack()" class="btn-secondary">← Edit</button>
          <button type="button" id="g-man-confirm" onclick="granolaConfirmManual('${dealId}')"
            class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-[#7C5CFC] hover:bg-[#6B4EE6] text-white shadow-sm transition-all">
            ${_gIcon(13)} Save Call
          </button>
        </div>
      </div>

      <!-- Processing overlay (hidden) -->
      <div id="g-man-loading" class="hidden py-10 text-center space-y-3">
        <svg class="w-8 h-8 text-[#7C5CFC] animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <p class="text-sm text-surface-500 font-medium">Processing with AI…</p>
        <p class="text-xs text-surface-400">Extracting insights, action items, and deal signals</p>
      </div>
    </div>
  `);
}

async function granolaPreviewManual(dealId) {
  const title   = document.getElementById('g-man-title')?.value.trim();
  const dateVal = document.getElementById('g-man-date')?.value;
  const durMin  = parseInt(document.getElementById('g-man-dur')?.value || '0');
  const notes   = document.getElementById('g-man-notes')?.value.trim();

  if (!title) { showToast('Please enter a meeting title', 'error'); return; }
  if (!notes) { showToast('Please enter notes or transcript text', 'error'); return; }

  // Switch to loading state
  document.getElementById('g-man-step1').classList.add('hidden');
  document.getElementById('g-man-loading').classList.remove('hidden');

  // Build base call record (not saved yet)
  _gManPendingCall = {
    id:               generateId(),
    userId:           currentUser.id,
    contactId:        null,
    participantIds:   [],
    dealId,
    date:             dateVal ? new Date(dateVal).toISOString() : new Date().toISOString(),
    duration:         durMin ? durMin * 60 : null,
    outcome:          'Manual Log',
    notes,
    nextSteps:        null,
    followUpDate:     null,
    tasks:            [],
    granolaId:        null,
    title,
    rawTranscript:    notes,
    granolaNotes:     null,
    cleanedNotes:     null,
    aiSummary:        null,
    actionItems:      [],
    keyInsights:      [],
    redFlags:         [],
    positiveSignals:  [],
    sellerSentiment:  null,
    dealProgress:     null,
    nextMeetingContext: null,
    source:           'manual',
    processedAt:      null,
    createdAt:        new Date().toISOString(),
    updatedAt:        new Date().toISOString(),
  };

  try {
    const deal = await DB.get(STORES.deals, dealId).catch(() => null);
    const ai   = await granolaProcessMeeting(_gManPendingCall, deal);
    _applyAIToCall(_gManPendingCall, ai);
    _gManPendingCall.notes     = _gManPendingCall.aiSummary || notes;
    _gManPendingCall.nextSteps = _gManPendingCall.nextMeetingContext || null;
    _gManPendingCall.tasks     = (_gManPendingCall.actionItems || []).map(a => ({
      text:           a.task || (typeof a === 'string' ? a : ''),
      assignedToName: a.owner || null,
      dueDate:        null,
    }));
    _gManPendingCall._aiDealUpdates = ai.dealUpdates || null;

    // Render AI preview
    const previewEl = document.getElementById('g-man-preview-content');
    if (previewEl) {
      previewEl.innerHTML = _renderGranolaPreviewHtml(_gManPendingCall);
    }

    // Switch to step 2
    document.getElementById('g-man-loading').classList.add('hidden');
    document.getElementById('g-man-step2').classList.remove('hidden');

  } catch (aiErr) {
    // AI failed — still allow saving with raw notes
    console.warn('[Granola] Preview AI failed:', aiErr.message);
    document.getElementById('g-man-loading').classList.add('hidden');
    document.getElementById('g-man-step2').classList.remove('hidden');

    const previewEl = document.getElementById('g-man-preview-content');
    if (previewEl) {
      previewEl.innerHTML = `
        <div class="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800 text-sm text-amber-700 dark:text-amber-400">
          AI analysis unavailable (${escapeHtml(aiErr.message || 'no AI key')}) — call will be saved with raw notes.
        </div>
        <div class="g-section">
          <p class="g-section-lbl">Notes</p>
          <p class="text-sm text-surface-600 dark:text-surface-400 whitespace-pre-wrap">${escapeHtml(_gManPendingCall.notes.substring(0, 500))}${_gManPendingCall.notes.length > 500 ? '…' : ''}</p>
        </div>`;
    }
  }
}

function granolaManualBack() {
  document.getElementById('g-man-step2').classList.add('hidden');
  document.getElementById('g-man-loading').classList.add('hidden');
  document.getElementById('g-man-step1').classList.remove('hidden');
}

async function granolaConfirmManual(dealId) {
  if (!_gManPendingCall) { closeModal(); return; }
  const btn = document.getElementById('g-man-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await DB.add(STORES.calls, _gManPendingCall);

    // Audit
    try {
      await DB.add(STORES.auditLog, {
        userId: currentUser.id, action: 'call_manual_logged',
        details: { callId: _gManPendingCall.id, dealId, title: _gManPendingCall.title },
        timestamp: new Date().toISOString(),
      });
    } catch (_) {}

    // Apply deal updates from AI
    if (_gManPendingCall.processedAt) {
      const deal = await DB.get(STORES.deals, dealId).catch(() => null);
      if (deal && _gManPendingCall._aiDealUpdates) {
        await _applyDealUpdates(_gManPendingCall._aiDealUpdates, deal, dealId).catch(() => {});
      }
    }

    await logDealHistory(dealId, 'call_logged', {
      callId: _gManPendingCall.id, title: _gManPendingCall.title, source: 'manual'
    }).catch(() => {});

    const savedTitle = _gManPendingCall.title;
    const wasAI = !!_gManPendingCall.processedAt;
    _gManPendingCall = null;
    closeModal();
    showToast(`✓ "${savedTitle}" logged${wasAI ? ' & AI-analysed' : ''}`, 'success');
    if (typeof currentDealId !== 'undefined' && currentDealId === dealId) switchDealTab('calls');

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Call'; }
    showToast('Save failed: ' + err.message, 'error');
  }
}

function _renderGranolaPreviewHtml(call) {
  return `
    ${call.aiSummary ? `
      <div class="g-section">
        <p class="g-section-lbl">${_gIcon(13)} AI Summary</p>
        <p class="text-sm text-surface-700 dark:text-surface-300 leading-relaxed">${escapeHtml(call.aiSummary)}</p>
      </div>` : ''}

    ${(call.positiveSignals?.length || call.redFlags?.length) ? `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${call.positiveSignals?.length ? `
          <div class="g-section">
            <p class="g-section-lbl text-green-600 dark:text-green-400">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              Positive Signals
            </p>
            <ul class="space-y-1">${call.positiveSignals.map(s =>
              `<li class="text-xs text-surface-600 dark:text-surface-400">· ${escapeHtml(s)}</li>`
            ).join('')}</ul>
          </div>` : ''}
        ${call.redFlags?.length ? `
          <div class="g-section">
            <p class="g-section-lbl text-amber-600 dark:text-amber-400">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>
              Red Flags
            </p>
            <ul class="space-y-1">${call.redFlags.map(f =>
              `<li class="text-xs text-surface-600 dark:text-surface-400">· ${escapeHtml(f)}</li>`
            ).join('')}</ul>
          </div>` : ''}
      </div>` : ''}

    ${call.actionItems?.length ? `
      <div class="g-section">
        <p class="g-section-lbl">
          <svg class="w-3.5 h-3.5 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          Action Items
        </p>
        <div class="space-y-1.5">
          ${call.actionItems.map(item => {
            const task  = typeof item === 'string' ? item : (item.task || '');
            const owner = typeof item === 'object' ? (item.owner || '') : '';
            return `<div class="flex items-start gap-2 p-2 rounded-lg bg-[#7C5CFC]/5 border border-[#7C5CFC]/15">
              <div class="w-3.5 h-3.5 rounded border-2 border-[#7C5CFC]/40 flex-shrink-0 mt-0.5"></div>
              <span class="text-xs text-surface-700 dark:text-surface-300 flex-1">${escapeHtml(task)}</span>
              ${owner ? `<span class="text-xs text-surface-400">${escapeHtml(owner)}</span>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

    ${call.nextMeetingContext ? `
      <div class="g-section">
        <p class="g-section-lbl">
          <svg class="w-3.5 h-3.5 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
          Next Steps
        </p>
        <p class="text-xs text-surface-600 dark:text-surface-400 leading-relaxed">${escapeHtml(call.nextMeetingContext)}</p>
      </div>` : ''}
  `;
}

// ── AI result helpers ────────────────────────────

function _applyAIToCall(call, ai) {
  if (ai.meetingTitle && ai.meetingTitle !== 'Untitled Meeting') call.title = ai.meetingTitle;
  call.aiSummary          = ai.summary            || null;
  call.cleanedNotes       = ai.summary            || null;
  call.keyInsights        = ai.keyInsights         || [];
  call.actionItems        = ai.actionItems         || [];
  call.redFlags           = ai.redFlags            || [];
  call.positiveSignals    = ai.positiveSignals     || [];
  call.sellerSentiment    = ai.sellerSentiment     || null;
  call.dealProgress       = ai.dealProgress        || null;
  call.nextMeetingContext = ai.nextMeetingContext   || null;
  call.processedAt        = new Date().toISOString();
}

async function _applyDealUpdates(updates, deal, dealId) {
  if (!updates || !deal) return;
  let changed = false;
  const setIf = (field, val) => { if (val != null && !deal[field]) { deal[field] = val; changed = true; } };
  setIf('ownerSituation', updates.ownerSituation);
  if (updates.revenue    && !deal.revenue)    { deal.revenue    = Math.round(updates.revenue);    changed = true; }
  if (updates.ebitda     && !deal.ebitda)     { deal.ebitda     = Math.round(updates.ebitda);     changed = true; }
  if (updates.askingPrice && !deal.askingPrice){ deal.askingPrice = Math.round(updates.askingPrice); changed = true; }
  if (updates.employeeCount && !deal.employeeCount) { deal.employeeCount = parseInt(updates.employeeCount); changed = true; }
  if (changed) { deal.updatedAt = new Date().toISOString(); await DB.put(STORES.deals, deal); }
}

// ── Calls tab renderer ───────────────────────────

async function renderDealCallsTab() {
  const [deal, allCalls] = await Promise.all([
    DB.get(STORES.deals, currentDealId),
    DB.getForUser(STORES.calls, currentUser.id),
  ]);

  // Filter to calls linked to this deal
  const calls = allCalls.filter(c => c.dealId === currentDealId);
  calls.sort((a, b) => new Date(b.date) - new Date(a.date));

  return `
    <div class="space-y-5">

      <!-- Action bar -->
      <div class="flex items-center justify-between gap-3">
        <p class="text-sm font-semibold text-surface-600 dark:text-surface-400">
          ${calls.length} Call${calls.length !== 1 ? 's' : ''} Logged
        </p>
        <div class="flex items-center gap-2">
          <button onclick="granolaOpenManualModal('${currentDealId}')" class="btn-secondary btn-sm">
            + Log Call
          </button>
        </div>
      </div>

      <!-- Content -->
      ${calls.length === 0
        ? _renderEmpty()
        : `<div class="space-y-3">${calls.map(_renderCard).join('')}</div>`}
    </div>`;
}

// ── Banner ───────────────────────────────────────

function _renderBanner() {
  return '';
}

// ── Empty state ──────────────────────────────────

function _renderEmpty() {
  return `
    <div class="rounded-2xl border-2 border-dashed border-surface-200 dark:border-surface-700 p-12 text-center">
      <div class="w-14 h-14 rounded-2xl bg-brand-50 dark:bg-brand-900/20 flex items-center justify-center mx-auto mb-4">
        <svg class="w-7 h-7 text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"/></svg>
      </div>
      <h4 class="text-sm font-bold mb-1.5">No calls logged yet</h4>
      <p class="text-xs text-surface-400 max-w-xs mx-auto mb-6 leading-relaxed">
        Log a call manually or use the built-in meeting recorder. AI will clean notes and extract key insights automatically.
      </p>
      <div class="flex items-center justify-center gap-2 flex-wrap">
        <button onclick="granolaOpenManualModal('${currentDealId}')" class="btn-secondary">
          + Log Call
        </button>
      </div>
    </div>`;
}

// ── Call card ────────────────────────────────────

function _renderCard(call) {
  const dateStr = new Date(call.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const timeStr = new Date(call.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const dur     = _fmtDuration(call.duration);

  const SENTIMENT = {
    positive: { label: 'Positive', cls: 'g-chip--green' },
    neutral:  { label: 'Neutral',  cls: 'g-chip--yellow' },
    negative: { label: 'Cautious', cls: 'g-chip--red' },
  };
  const PROGRESS = {
    advancing: { label: '↑ Advancing', cls: 'text-green-600 dark:text-green-400' },
    stalled:   { label: '⟳ Stalled',   cls: 'text-amber-600 dark:text-amber-400' },
    early:     { label: '◎ Early',     cls: 'text-blue-600 dark:text-blue-400' },
    unclear:   { label: '? Unclear',   cls: 'text-surface-400' },
  };

  const senti   = SENTIMENT[call.sellerSentiment];
  const prog    = PROGRESS[call.dealProgress];
  const isAI    = !!call.processedAt;

  return `
    <div class="g-card" id="g-card-${call.id}">
      <!-- Header row (always visible, clickable to expand) -->
      <div class="g-card-head" onclick="gToggle('${call.id}')">
        <!-- Source badge -->
        <div class="g-src g-src--m" title="Call log">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>
        </div>

        <!-- Title + meta -->
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold truncate">${escapeHtml(call.title || call.outcome || 'Call')}</p>
          <div class="flex items-center gap-2 mt-0.5 flex-wrap">
            <span class="text-xs text-surface-400">${dateStr} · ${timeStr}</span>
            ${dur ? `<span class="text-xs text-surface-300 dark:text-surface-600">·</span><span class="text-xs text-surface-400">${dur}</span>` : ''}
            ${isAI ? `
              <span class="text-xs text-[#7C5CFC] font-medium flex items-center gap-0.5">
                ${_gIcon(11)} AI analysed
              </span>` : ''}
          </div>
        </div>

        <!-- Chips + chevron + delete -->
        <div class="flex items-center gap-1.5 flex-shrink-0">
          ${senti    ? `<span class="g-chip ${senti.cls}">${senti.label}</span>` : ''}
          ${prog     ? `<span class="text-xs font-medium ${prog.cls} hidden sm:inline">${prog.label}</span>` : ''}
          <svg id="g-chev-${call.id}" class="w-4 h-4 text-surface-300 transition-transform duration-200 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
          <button onclick="event.stopPropagation(); gDeleteCall('${call.id}','${call.dealId}')"
            class="p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-surface-300 hover:text-red-500 transition-colors ml-0.5" title="Remove">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- Expandable detail -->
      <div class="g-card-body hidden" id="g-body-${call.id}">
        ${_renderCardBody(call)}
      </div>
    </div>`;
}

function _renderCardBody(call) {
  const hasAI         = !!call.processedAt;
  const hasTranscript = !!(call.rawTranscript || call.granolaNotes);

  return `
    <div class="g-detail-inner">

      ${hasAI ? `
        <!-- AI Summary -->
        ${call.aiSummary ? `
          <div class="g-section">
            <p class="g-section-lbl">${_gIcon(13)} AI Summary</p>
            <p class="text-sm text-surface-700 dark:text-surface-300 leading-relaxed">${escapeHtml(call.aiSummary)}</p>
          </div>` : ''}

        <!-- Signals grid -->
        ${(call.positiveSignals?.length || call.redFlags?.length) ? `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            ${call.positiveSignals?.length ? `
              <div class="g-section">
                <p class="g-section-lbl text-green-600 dark:text-green-400">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                  Positive Signals
                </p>
                <ul class="space-y-1.5">
                  ${call.positiveSignals.map(s => `
                    <li class="flex items-start gap-2">
                      <span class="w-1.5 h-1.5 rounded-full bg-green-400 mt-1.5 flex-shrink-0"></span>
                      <span class="text-xs text-surface-600 dark:text-surface-400 leading-relaxed">${escapeHtml(s)}</span>
                    </li>`).join('')}
                </ul>
              </div>` : ''}
            ${call.redFlags?.length ? `
              <div class="g-section">
                <p class="g-section-lbl text-amber-600 dark:text-amber-400">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>
                  Red Flags
                </p>
                <ul class="space-y-1.5">
                  ${call.redFlags.map(f => `
                    <li class="flex items-start gap-2">
                      <span class="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0"></span>
                      <span class="text-xs text-surface-600 dark:text-surface-400 leading-relaxed">${escapeHtml(f)}</span>
                    </li>`).join('')}
                </ul>
              </div>` : ''}
          </div>` : ''}

        <!-- Action items -->
        ${call.actionItems?.length ? `
          <div class="g-section">
            <p class="g-section-lbl">
              <svg class="w-3.5 h-3.5 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              Action Items
            </p>
            <div class="space-y-2">
              ${call.actionItems.map(item => {
                const task = typeof item === 'string' ? item : (item.task || '');
                const owner = typeof item === 'object' ? item.owner : null;
                const due   = typeof item === 'object' ? item.dueContext : null;
                return `
                  <div class="flex items-start gap-2.5 p-2.5 rounded-xl bg-[#7C5CFC]/5 border border-[#7C5CFC]/15">
                    <div class="w-4 h-4 rounded border-2 border-[#7C5CFC]/40 flex-shrink-0 mt-0.5"></div>
                    <div class="min-w-0">
                      <p class="text-xs font-semibold text-surface-700 dark:text-surface-300">${escapeHtml(task)}</p>
                      ${(owner || due) ? `
                        <p class="text-xs text-surface-400 mt-0.5">
                          ${[owner, due].filter(Boolean).map(escapeHtml).join(' · ')}
                        </p>` : ''}
                    </div>
                  </div>`;
              }).join('')}
            </div>
          </div>` : ''}

        <!-- Next steps -->
        ${call.nextMeetingContext ? `
          <div class="g-section">
            <p class="g-section-lbl">
              <svg class="w-3.5 h-3.5 text-surface-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
              Next Steps
            </p>
            <p class="text-xs text-surface-600 dark:text-surface-400 leading-relaxed">${escapeHtml(call.nextMeetingContext)}</p>
          </div>` : ''}

      ` : hasTranscript ? `
        <!-- Unprocessed -->
        <div class="p-5 rounded-xl bg-surface-50 dark:bg-surface-800 text-center border border-surface-200 dark:border-surface-700">
          <p class="text-xs text-surface-400 mb-3">This meeting hasn't been AI-analysed yet.</p>
          <button onclick="gProcessCall('${call.id}')"
            class="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-sm font-semibold bg-[#7C5CFC] hover:bg-[#6B4EE6] text-white shadow-sm transition-all"
            id="g-proc-btn-${call.id}">
            ${_gIcon(13)} Analyse with AI
          </button>
        </div>` : ''}

      <!-- Transcript / Granola Notes (collapsible) -->
      ${hasTranscript ? `
        <div class="g-section">
          <button onclick="gToggleTranscript('${call.id}')"
            class="g-section-lbl w-full flex items-center justify-between cursor-pointer hover:text-surface-700 dark:hover:text-surface-300">
            <span class="flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"/></svg>
              ${call.source === 'granola' ? 'Granola Notes' : 'Raw Transcript'}
            </span>
            <svg id="g-tchev-${call.id}" class="w-3.5 h-3.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
          </button>
          <div id="g-trans-${call.id}" class="hidden mt-2">
            <div class="max-h-60 overflow-y-auto rounded-xl bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 p-4">
              <pre class="text-xs text-surface-600 dark:text-surface-400 whitespace-pre-wrap font-mono leading-relaxed">${escapeHtml(
                (call.granolaNotes || _transcriptToText(call.rawTranscript) || '').substring(0, 8000)
              )}</pre>
            </div>
          </div>
        </div>` : ''}

      <!-- AI Actions -->
      ${(hasAI || hasTranscript) ? `
        <div class="g-section">
          <p class="g-section-lbl">AI Actions</p>
          <div class="flex flex-wrap gap-2">
            <button onclick="granolaGenerateFollowUp('${call.id}')" id="g-followup-btn-${call.id}"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#7C5CFC]/30 text-[#7C5CFC] hover:bg-[#7C5CFC]/8 transition-all">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
              Draft Follow-up Email
            </button>
            <button onclick="granolaGenerateDiligence('${call.id}')" id="g-diligence-btn-${call.id}"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-800 transition-all">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>
              Diligence Questions
            </button>
          </div>
          <div id="g-ai-output-${call.id}" class="hidden mt-3"></div>
        </div>` : ''}

    </div>`;
}

// ── Interaction handlers ─────────────────────────

function gToggle(callId) {
  const body  = document.getElementById(`g-body-${callId}`);
  const chev  = document.getElementById(`g-chev-${callId}`);
  if (!body) return;
  const open = body.classList.toggle('hidden');
  chev?.classList.toggle('rotate-180', !open);
}

function gToggleTranscript(callId) {
  const el   = document.getElementById(`g-trans-${callId}`);
  const chev = document.getElementById(`g-tchev-${callId}`);
  if (!el) return;
  const hidden = el.classList.toggle('hidden');
  chev?.classList.toggle('rotate-180', !hidden);
}

async function gProcessCall(callId) {
  const btn = document.getElementById(`g-proc-btn-${callId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Analysing…'; }
  try {
    const call = await DB.get(STORES.calls, callId);
    if (!call) return;
    const deal = await DB.get(STORES.deals, call.dealId);
    const ai   = await granolaProcessMeeting(call, deal);
    _applyAIToCall(call, ai);
    // Sync AI results back to standard fields
    call.notes     = call.aiSummary || call.notes;
    call.nextSteps = call.nextMeetingContext || null;
    call.tasks     = (call.actionItems || []).map(a => ({
      text:           a.task || (typeof a === 'string' ? a : ''),
      assignedToName: a.owner || null,
      dueDate:        null,
    }));
    await DB.put(STORES.calls, { ...call, updatedAt: new Date().toISOString() });
    await _applyDealUpdates(ai.dealUpdates, deal, call.dealId);
    showToast('✓ AI analysis complete', 'success');
    if (typeof currentDealId !== 'undefined' && currentDealId === call.dealId) switchDealTab('calls');
  } catch (e) {
    showToast('Analysis failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = `${_gIcon(13)} Analyse with AI`; }
  }
}

async function granolaGenerateFollowUp(callId) {
  const btn = document.getElementById(`g-followup-btn-${callId}`);
  const outputEl = document.getElementById(`g-ai-output-${callId}`);
  if (!btn || !outputEl) return;

  btn.disabled = true;
  btn.textContent = 'Drafting…';
  outputEl.classList.remove('hidden');
  outputEl.innerHTML = `<div class="flex items-center gap-2 text-xs text-surface-400"><svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Drafting follow-up email…</div>`;

  try {
    const call = await DB.get(STORES.calls, callId);
    if (!call) throw new Error('Call not found');
    const content = call.aiSummary || call.granolaNotes || call.rawTranscript || call.notes || '';
    if (!content.trim()) throw new Error('No call content to base email on');

    const email = await callAI(
      'You are an expert search fund operator drafting professional follow-up emails after M&A discovery calls. Write concise, genuine, and specific emails. No fluff. Reference specifics from the meeting.',
      `Draft a follow-up email based on this meeting summary/notes. Be specific to what was discussed.
Keep it under 200 words. Subject line first, then body.

MEETING: ${escapeHtml(call.title || 'Untitled Meeting')}
DATE: ${new Date(call.date).toLocaleDateString()}
CONTENT:
${content.substring(0, 4000)}`,
      600, 0.4
    );

    outputEl.innerHTML = `
      <div class="rounded-xl border border-surface-200 dark:border-surface-700 overflow-hidden">
        <div class="px-3 py-2 bg-surface-50 dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
          <span class="text-xs font-semibold text-surface-600 dark:text-surface-400">Draft Follow-up Email</span>
          <button onclick="navigator.clipboard?.writeText(document.getElementById('g-email-text-${callId}')?.textContent || '').then(() => showToast('Copied', 'success'))"
            class="text-xs text-brand-600 hover:text-brand-700">Copy</button>
        </div>
        <pre id="g-email-text-${callId}" class="p-3 text-xs text-surface-700 dark:text-surface-300 whitespace-pre-wrap font-sans leading-relaxed">${escapeHtml(email.trim())}</pre>
      </div>`;

    // Audit
    await DB.add(STORES.auditLog, {
      userId: currentUser.id, action: 'followup_email_generated',
      details: { callId }, timestamp: new Date().toISOString(),
    }).catch(() => {});

  } catch (err) {
    outputEl.innerHTML = `<p class="text-xs text-red-500">${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg> Draft Follow-up Email`;
  }
}

async function granolaGenerateDiligence(callId) {
  const btn = document.getElementById(`g-diligence-btn-${callId}`);
  const outputEl = document.getElementById(`g-ai-output-${callId}`);
  if (!btn || !outputEl) return;

  btn.disabled = true;
  btn.textContent = 'Generating…';
  outputEl.classList.remove('hidden');
  outputEl.innerHTML = `<div class="flex items-center gap-2 text-xs text-surface-400"><svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Generating diligence questions…</div>`;

  try {
    const call = await DB.get(STORES.calls, callId);
    if (!call) throw new Error('Call not found');
    const content = call.aiSummary || call.granolaNotes || call.rawTranscript || call.notes || '';
    const redFlags = (call.redFlags || []).join('; ');
    if (!content.trim()) throw new Error('No call content to generate questions from');

    const questions = await callAI(
      'You are a search fund diligence expert. Generate sharp, specific due diligence questions based on what was discussed in a meeting. Focus on gaps, risks, and areas needing verification.',
      `Generate 8–12 targeted due diligence questions for the NEXT conversation, based on this meeting summary and any red flags.
Format as a numbered list. Be specific to what was discussed — no generic questions.

MEETING: ${escapeHtml(call.title || 'Untitled Meeting')}
RED FLAGS: ${redFlags || 'none identified'}
CONTENT:
${content.substring(0, 4000)}`,
      800, 0.3
    );

    outputEl.innerHTML = `
      <div class="rounded-xl border border-surface-200 dark:border-surface-700 overflow-hidden">
        <div class="px-3 py-2 bg-surface-50 dark:bg-surface-800 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
          <span class="text-xs font-semibold text-surface-600 dark:text-surface-400">Diligence Questions for Next Call</span>
          <button onclick="navigator.clipboard?.writeText(document.getElementById('g-diligence-text-${callId}')?.textContent || '').then(() => showToast('Copied', 'success'))"
            class="text-xs text-brand-600 hover:text-brand-700">Copy</button>
        </div>
        <pre id="g-diligence-text-${callId}" class="p-3 text-xs text-surface-700 dark:text-surface-300 whitespace-pre-wrap font-sans leading-relaxed">${escapeHtml(questions.trim())}</pre>
      </div>`;

    await DB.add(STORES.auditLog, {
      userId: currentUser.id, action: 'diligence_questions_generated',
      details: { callId }, timestamp: new Date().toISOString(),
    }).catch(() => {});

  } catch (err) {
    outputEl.innerHTML = `<p class="text-xs text-red-500">${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg> Diligence Questions`;
  }
}

function gDeleteCall(callId, dealId) {
  confirmDialog('Remove Meeting', 'Remove this call log from the deal? Your files are untouched.', async () => {
    await DB.delete(STORES.calls, callId);
    showToast('Call removed', 'info');
    if (typeof currentDealId !== 'undefined' && currentDealId === dealId) switchDealTab('calls');
  });
}

// ── Granola microphone SVG icon ──────────────────

function _gIcon(sz = 16) {
  return `<svg width="${sz}" height="${sz}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="8" fill="#7C5CFC" opacity="0.12"/>
    <rect x="12" y="5" width="8" height="14" rx="4" fill="#7C5CFC"/>
    <path d="M7 16a9 9 0 0018 0" stroke="#7C5CFC" stroke-width="2" stroke-linecap="round"/>
    <line x1="16" y1="25" x2="16" y2="28" stroke="#7C5CFC" stroke-width="2" stroke-linecap="round"/>
    <line x1="11" y1="28" x2="21" y2="28" stroke="#7C5CFC" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function _gErrorHtml(e) {
  const code = e?.code || '';
  const msgs = {
    NO_KEY:      'No Granola API key set. Go to Settings → Integrations to add your key.',
    INVALID_KEY: 'Your Granola API key was rejected. Check it in Settings → Integrations.',
    NETWORK:     'Cannot reach the Granola app — make sure Granola is running on your Mac, then try again.',
    CORS:        e?.message || 'CORS blocked — serve the app from a local server (e.g. VS Code Live Server or python -m http.server 8080).',
  };
  const msg = msgs[code] || e?.message || 'Unknown error';
  return `
    <div class="p-4 rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-800">
      <p class="text-sm font-semibold text-red-700 dark:text-red-400 mb-1">Could not connect to Granola</p>
      <p class="text-xs text-red-600 dark:text-red-500">${escapeHtml(msg)}</p>
      <div class="flex gap-2 mt-3">
        <button onclick="closeModal()" class="btn-secondary btn-sm">Close</button>
        <button onclick="navigate('settings')" class="btn-primary btn-sm">Open Settings</button>
      </div>
    </div>`;
}
