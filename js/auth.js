/* ============================================
   Pulse — Authentication
   ============================================ */

let currentUser = null;
let pendingVerification = null; // { user, code, email }
let pendingPasswordReset = null; // { email, code, expiresAt }

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Pilot Invite System ──────────────────────────────────────────────────────
// Invite codes are self-validating: PULSE-{8 hex random}-{4 hex checksum}
// The checksum = first 4 hex chars of SHA-256(SALT + random).
// No server or DB lookup needed — any valid code can be verified offline.
// The first account in an empty DB is always the owner (no invite needed).

const _INVITE_SALT = 'PulsePilot2025#SearchFund';
const _INVITE_STORE_KEY = 'pulse_pilot_invites'; // localStorage key for generated codes

async function _inviteChecksum(random8) {
  const data = new TextEncoder().encode(_INVITE_SALT + random8);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('').slice(0, 4).toUpperCase();
}

/** Generate a new cryptographically-signed invite code. */
async function generateInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const random = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const cs = await _inviteChecksum(random);
  return `PULSE-${random}-${cs}`;
}

/**
 * Validate an invite code. Returns true if the checksum is correct.
 * Does NOT check if the code has been used (stateless by design for pilot).
 */
async function validateInviteCode(code) {
  if (!code || typeof code !== 'string') return false;
  const clean = code.trim().toUpperCase().replace(/\s+/g, '');
  const m = clean.match(/^PULSE-([A-F0-9]{8})-([A-F0-9]{4})$/);
  if (!m) return false;
  const expected = await _inviteChecksum(m[1]);
  return expected === m[2];
}

/** Load all saved invites from localStorage. */
function loadSavedInvites() {
  try { return JSON.parse(localStorage.getItem(_INVITE_STORE_KEY) || '[]'); }
  catch { return []; }
}

/** Persist invites to localStorage. */
function saveInvites(list) {
  localStorage.setItem(_INVITE_STORE_KEY, JSON.stringify(list));
}

/**
 * Generate + store a new invite and return the record.
 * @param {string} note  Optional label (e.g. "for John Smith")
 */
async function createNewInvite(note = '') {
  const code = await generateInviteCode();
  const record = { code, note, createdAt: new Date().toISOString(), usedByEmail: null, usedAt: null };
  const list = loadSavedInvites();
  list.unshift(record); // newest first
  saveInvites(list);
  return record;
}

/** Mark an invite as used (called after successful registration). */
function markInviteUsed(code, email) {
  const list = loadSavedInvites();
  const rec = list.find(i => i.code.toUpperCase() === code.toUpperCase());
  if (rec && !rec.usedAt) {
    rec.usedAt = new Date().toISOString();
    rec.usedByEmail = email;
    saveInvites(list);
  }
}

/** Registration is open to everyone — no invite code required. */
async function isInviteRequired() {
  return false;
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function register(name, email, password) {
  const existing = await DB.getAll(STORES.users);
  if (existing.find(u => u.email === email)) {
    throw new Error('An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);
  const user = {
    id: generateId(),
    name,
    email,
    passwordHash,
    emailVerified: false,
    createdAt: new Date().toISOString(),
  };

  await DB.add(STORES.users, user);
  await _createDefaultUserData(user.id);
  return user;
}

async function login(email, password) {
  const users = await DB.getAll(STORES.users);
  const user = users.find(u => u.email === email);
  if (!user) throw new Error('No account found with this email');

  const passwordHash = await hashPassword(password);
  if (user.passwordHash !== passwordHash) throw new Error('Incorrect password');

  return user;
}

function setCurrentUser(user) {
  currentUser = user;
  localStorage.setItem('pulse_user_id', user.id);
  document.getElementById('sidebar-user-name').textContent = user.name;
  document.getElementById('user-avatar-initial').textContent = user.name.charAt(0).toUpperCase();
}

async function restoreSession() {
  const userId = localStorage.getItem('pulse_user_id');
  if (!userId) return null;

  const user = await DB.get(STORES.users, userId);
  if (user) {
    setCurrentUser(user);
    const settings = await DB.get(STORES.settings, `settings_${user.id}`);
    if (settings && settings.theme) {
      const html = document.documentElement;
      html.classList.remove('dark', 'light');
      html.classList.add(settings.theme);
    }
  }
  return user;
}

function logout() {
  currentUser = null;
  localStorage.removeItem('pulse_user_id');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

function _showAuthPanel(name) {
  ['login', 'register', 'verify', 'reset', 'new-password', 'recover'].forEach(s =>
    document.getElementById(`auth-${s}`).classList.toggle('hidden', s !== name)
  );
}
function showAuthLogin()       { _showAuthPanel('login'); }
function showAuthVerify()      { _showAuthPanel('verify'); }
function showAuthReset()       {
  _showAuthPanel('reset');
  const h = document.getElementById('new-password-hint');
  if (h) h.innerHTML = '';
  const c = document.getElementById('new-password-code');
  if (c) c.value = '';
}
function showAuthNewPassword() { _showAuthPanel('new-password'); }

async function showAuthRegister() {
  _showAuthPanel('register');
  // Show or hide the invite field depending on whether accounts already exist
  const required = await isInviteRequired();
  const wrap = document.getElementById('invite-code-wrap');
  if (wrap) wrap.classList.toggle('hidden', !required);
  // Pre-fill from URL param if present
  const urlInvite = new URLSearchParams(window.location.search).get('invite');
  if (urlInvite) {
    const field = document.getElementById('register-invite');
    if (field && !field.value) field.value = urlInvite.toUpperCase();
  }
}

async function startAccountRecovery() {
  _showAuthPanel('recover');
  const statusEl  = document.getElementById('recover-status');
  const resultsEl = document.getElementById('recover-results');
  resultsEl.innerHTML = '';
  statusEl.textContent = 'Scanning all local databases for your account…';

  let found;
  try {
    found = await scanAllDBsForAccounts();
  } catch (err) {
    statusEl.textContent = 'Scan failed: ' + err.message;
    return;
  }

  if (found.length === 0) {
    statusEl.textContent = 'No accounts found in any other local database. Your data may have been cleared by the browser, or was stored under a different browser profile.';
    return;
  }

  statusEl.textContent = `Found ${found.reduce((n, f) => n + f.users.length, 0)} account(s) in ${found.length} database(s). Click "Restore" to import into Pulse.`;

  found.forEach(({ dbName, data, users }) => {
    users.forEach(user => {
      const card = document.createElement('div');
      card.className = 'flex items-center justify-between bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded p-3';
      card.innerHTML = `
        <div>
          <p class="text-sm font-medium">${user.name || '(no name)'}</p>
          <p class="text-xs text-surface-500">${user.email} &mdash; <span class="font-mono text-xs">${dbName}</span></p>
        </div>
        <button class="btn-primary text-xs px-3 py-1.5">Restore</button>
      `;
      card.querySelector('button').addEventListener('click', async () => {
        card.querySelector('button').textContent = 'Importing…';
        card.querySelector('button').disabled = true;
        try {
          await importLegacyData(data);
          indexedDB.deleteDatabase(dbName);
          showToast('Account restored — sign in now', 'success');
          // Pre-fill email on login screen
          showAuthLogin();
          const emailField = document.getElementById('login-email');
          if (emailField) emailField.value = user.email;
          document.getElementById('login-password').focus();
        } catch (err) {
          showToast('Restore failed: ' + err.message, 'error');
          card.querySelector('button').textContent = 'Retry';
          card.querySelector('button').disabled = false;
        }
      });
      resultsEl.appendChild(card);
    });
  });
}

// Password visibility toggle (press-and-hold)
function showPassword(inputId) {
  const input = document.getElementById(inputId);
  if (input) input.type = 'text';
  const prefix = inputId.replace('-password', '');
  const eyeOff = document.getElementById(`${prefix}-eye-off`);
  const eyeOn = document.getElementById(`${prefix}-eye-on`);
  if (eyeOff) eyeOff.classList.add('hidden');
  if (eyeOn) eyeOn.classList.remove('hidden');
}

function hidePassword(inputId) {
  const input = document.getElementById(inputId);
  if (input) input.type = 'password';
  const prefix = inputId.replace('-password', '');
  const eyeOff = document.getElementById(`${prefix}-eye-off`);
  const eyeOn = document.getElementById(`${prefix}-eye-on`);
  if (eyeOff) eyeOff.classList.remove('hidden');
  if (eyeOn) eyeOn.classList.add('hidden');
}

// OTP input behavior
function setupOtpInputs() {
  const inputs = document.querySelectorAll('.otp-input');
  inputs.forEach((input, i) => {
    input.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      e.target.value = val;
      if (val && i < inputs.length - 1) {
        inputs[i + 1].focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !e.target.value && i > 0) {
        inputs[i - 1].focus();
      }
    });
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pastedData = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
      for (let j = 0; j < Math.min(pastedData.length, 6); j++) {
        const idx = j < 3 ? j : j; // skip the dash separator
        if (inputs[idx]) inputs[idx].value = pastedData[j];
      }
      if (pastedData.length >= 6) {
        inputs[inputs.length - 1].focus();
      }
    });
  });
}

function getOtpValue() {
  const inputs = document.querySelectorAll('.otp-input');
  return Array.from(inputs).map(i => i.value).join('');
}

async function sendPasswordResetEmail(email, code) {
  console.log(`[Pulse] Password reset code for ${email}: ${code}`);

  // This hint lives on the new-password panel — it's already rendered (just hidden),
  // so we can populate it now and it will be visible once the panel switches.
  const hintEl = document.getElementById('new-password-hint');

  try {
    const ejsRaw = localStorage.getItem('pulse_emailjs_config');
    const ejsCfg = ejsRaw ? JSON.parse(ejsRaw) : null;

    if (ejsCfg && ejsCfg.publicKey && ejsCfg.serviceId && ejsCfg.templateId && window.emailjs) {
      emailjs.init({ publicKey: ejsCfg.publicKey });
      await emailjs.send(ejsCfg.serviceId, ejsCfg.templateId, {
        to_email: email,
        to_name: '',
        code: code,
        app_name: 'Pulse CRM',
        subject: 'Your Pulse CRM password reset code',
      });
      if (hintEl) {
        hintEl.innerHTML = `
          <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px 12px;display:flex;align-items:center;gap:8px;">
            <svg style="width:16px;height:16px;color:#16a34a;flex-shrink:0;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
            <span style="font-size:13px;color:#15803d;font-weight:500;">Reset code sent to ${escapeHtml(email)}</span>
          </div>`;
      }
      return;
    }
  } catch (err) {
    console.warn('[Pulse] EmailJS reset email failed:', err);
  }

  // No email service — show the code directly on the panel and auto-fill the input.
  if (hintEl) {
    hintEl.innerHTML = `
      <div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:12px;">
        <p style="font-size:12px;color:#1d4ed8;margin-bottom:8px;font-weight:600;">Your reset code (copy it below):</p>
        <div style="display:flex;align-items:center;gap:10px;">
          <span id="reset-code-display" style="font-family:monospace;font-size:22px;letter-spacing:0.3em;background:#fff;border:1px solid #bfdbfe;padding:6px 14px;border-radius:6px;color:#1e3a8a;">${code}</span>
          <button type="button" onclick="
            document.getElementById('new-password-code').value='${code}';
            this.textContent='✓ Filled';this.style.color='#16a34a';"
            style="font-size:12px;color:#2563eb;background:none;border:none;cursor:pointer;text-decoration:underline;white-space:nowrap;">
            Auto-fill →
          </button>
        </div>
        <p style="font-size:11px;color:#6b7280;margin-top:8px;">This code expires in 15 minutes. Enter it in the field below.</p>
      </div>`;
  }

  // Also auto-fill the code input if it's already in the DOM
  const codeInput = document.getElementById('new-password-code');
  if (codeInput) codeInput.value = code;
}

async function sendVerificationEmail(email, code) {
  console.log(`[Pulse] Verification code for ${email}: ${code}`);

  const hint = document.getElementById('verify-code-hint');

  // Try EmailJS if configured
  try {
    const ejsRaw = localStorage.getItem('pulse_emailjs_config');
    const ejsCfg = ejsRaw ? JSON.parse(ejsRaw) : null;

    if (ejsCfg && ejsCfg.publicKey && ejsCfg.serviceId && ejsCfg.templateId && window.emailjs) {
      emailjs.init({ publicKey: ejsCfg.publicKey });
      await emailjs.send(ejsCfg.serviceId, ejsCfg.templateId, {
        to_email: email,
        to_name: pendingVerification?.name || '',
        code: code,
        app_name: 'Pulse CRM',
      });
      // Success — hide code, show confirmation
      if (hint) {
        hint.innerHTML = `<span class="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400 text-sm font-medium"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Verification email sent to ${email}</span>`;
      }
      return;
    }
  } catch (err) {
    console.warn('[Pulse] EmailJS send failed:', err);
    // Fall through to show code hint below
  }

  // Fallback: show code in UI (local / no EmailJS configured)
  if (hint) {
    hint.innerHTML = `
      <span class="bg-surface-100 dark:bg-surface-800 px-3 py-1.5 rounded-lg font-mono text-base tracking-widest">${code}</span>
      <br><span class="text-surface-400 text-xs mt-1 inline-block">
        No email service configured — code shown here.
        <button onclick="navigate('settings')" class="text-brand-600 hover:underline ml-1">Configure EmailJS in Settings →</button>
      </span>`;
  }
}

function resendVerificationCode() {
  if (!pendingVerification) return;
  pendingVerification.code = generateVerificationCode();
  sendVerificationEmail(pendingVerification.email, pendingVerification.code);
  showToast('New verification code sent', 'info');
}

async function resetPassword(email, newPassword) {
  const users = await DB.getAll(STORES.users);
  const user = users.find(u => u.email === email);
  if (!user) throw new Error('No account found with this email');

  const passwordHash = await hashPassword(newPassword);
  user.passwordHash = passwordHash;
  await DB.put(STORES.users, user);
  return user;
}

function setupAuthForms() {
  // Login form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const origLabel = btn.textContent;
    btn.textContent = 'Signing in…';
    btn.disabled = true;
    try {
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      const user = await login(email, password);
      setCurrentUser(user);
      showApp();
      showToast('Welcome back, ' + user.name.split(' ')[0], 'success');
    } catch (err) {
      btn.textContent = origLabel;
      btn.disabled = false;
      showToast(err.message, 'error');

      // If the account wasn't found, show the recovery button and auto-run the scan.
      if (err.message && err.message.toLowerCase().includes('no account')) {
        const recoverBtn = document.getElementById('recover-btn');
        if (recoverBtn) {
          recoverBtn.style.display = 'block'; // was display:none — make it visible
          const labelEl = document.getElementById('recover-btn-label');
          if (labelEl) labelEl.textContent = 'Account not found — click to scan & recover your data';
        }
        // Auto-run the scan after a brief delay
        setTimeout(() => startAccountRecovery(), 800);
      }
    }
  });

  // Register form — creates account instantly, no email verification needed
  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Creating account…';
    try {
      const name     = document.getElementById('register-name').value.trim();
      const email    = document.getElementById('register-email').value.trim();
      const password = document.getElementById('register-password').value;
      const passwordConfirm = document.getElementById('register-password-confirm').value;

      if (!name) {
        showToast('Please enter your name', 'error');
        btn.disabled = false; btn.textContent = 'Create account';
        return;
      }
      if (password !== passwordConfirm) {
        showToast('Passwords do not match', 'error');
        document.getElementById('register-password-confirm').focus();
        btn.disabled = false; btn.textContent = 'Create account';
        return;
      }
      if (password.length < 8) {
        showToast('Password must be at least 8 characters', 'error');
        btn.disabled = false; btn.textContent = 'Create account';
        return;
      }

      // Check email isn't already taken
      const existing = await DB.getAll(STORES.users);
      if (existing.find(u => u.email === email)) {
        showToast('An account with this email already exists', 'error');
        btn.disabled = false; btn.textContent = 'Create account';
        return;
      }

      // Create the account directly — no invite code, no email verification
      const passwordHash = await hashPassword(password);
      const user = {
        id: generateId(),
        name,
        email,
        passwordHash,
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      await DB.add(STORES.users, user);
      await _createDefaultUserData(user.id);
      await seedDemoData(user.id);

      // Flag for onboarding tutorial
      localStorage.setItem('pulse_show_tutorial_' + user.id, '1');

      setCurrentUser(user);
      showApp();
      showToast('Welcome to Pulse, ' + name.split(' ')[0] + '!', 'success');
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Create account';
      showToast(err.message || 'Could not create account', 'error');
    }
  });

  // Reset password — Step 1: send code to email
  document.getElementById('reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const origLabel = btn.textContent;
    btn.textContent = 'Sending…';
    btn.disabled = true;
    try {
      const email = document.getElementById('reset-email').value.trim();
      const users = await DB.getAll(STORES.users);
      if (!users.find(u => u.email === email)) throw new Error('No account found with this email');

      const code = generateVerificationCode();
      pendingPasswordReset = { email, code, expiresAt: Date.now() + 15 * 60 * 1000 };

      await sendPasswordResetEmail(email, code);

      showAuthNewPassword();
      const targetEl = document.getElementById('reset-target-email');
      if (targetEl) targetEl.textContent = `Code sent to ${email}`;
      document.getElementById('new-password-code')?.focus();
    } catch (err) {
      showToast(err.message, 'error');
      btn.textContent = origLabel;
      btn.disabled = false;
    }
  });

  // Reset password — Step 2: verify code + set new password
  document.getElementById('new-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const origLabel = btn.textContent;
    btn.textContent = 'Saving…';
    btn.disabled = true;
    try {
      if (!pendingPasswordReset) throw new Error('No reset in progress — please request a new code');
      if (Date.now() > pendingPasswordReset.expiresAt) {
        pendingPasswordReset = null;
        throw new Error('Reset code expired — please request a new one');
      }

      const enteredCode = document.getElementById('new-password-code').value.trim();
      if (enteredCode !== pendingPasswordReset.code) throw new Error('Incorrect reset code');

      const password = document.getElementById('new-password-password').value;
      const passwordConfirm = document.getElementById('new-password-confirm').value;
      if (password !== passwordConfirm) throw new Error('Passwords do not match');
      if (password.length < 8) throw new Error('Password must be at least 8 characters');

      await resetPassword(pendingPasswordReset.email, password);
      const email = pendingPasswordReset.email;
      pendingPasswordReset = null;

      showToast('Password updated — please sign in', 'success');
      document.getElementById('login-email').value = email;
      showAuthLogin();
    } catch (err) {
      showToast(err.message, 'error');
      btn.textContent = origLabel;
      btn.disabled = false;
    }
  });

  // Verification form
  document.getElementById('verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pendingVerification) {
      showToast('No pending verification', 'error');
      return;
    }

    const enteredCode = getOtpValue();
    if (enteredCode.length !== 6) {
      showToast('Please enter all 6 digits', 'warning');
      return;
    }

    if (enteredCode !== pendingVerification.code) {
      showToast('Invalid verification code', 'error');
      // Shake the inputs
      document.getElementById('otp-container').style.animation = 'none';
      setTimeout(() => {
        document.getElementById('otp-container').style.animation = 'shake 0.5s ease';
      }, 10);
      return;
    }

    // Code is correct — create the account
    try {
      const user = await register(
        pendingVerification.name,
        pendingVerification.email,
        pendingVerification.password
      );
      user.emailVerified = true;
      await DB.put(STORES.users, user);

      // Record invite code as used (tracked in owner's localStorage for pilot management)
      if (pendingVerification.inviteCode) {
        markInviteUsed(pendingVerification.inviteCode, pendingVerification.email);
      }

      setCurrentUser(user);
      await seedDemoData(user.id);
      pendingVerification = null;

      // Flag this user for the onboarding tutorial (persists across page refresh)
      localStorage.setItem('pulse_show_tutorial_' + user.id, '1');

      showApp();
      showToast('Welcome to Pulse, ' + user.name.split(' ')[0] + '!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

/**
 * Create default tags + settings for a brand-new user.
 */
async function _createDefaultUserData(userId) {
  const defaultTags = [
    { name: 'Search Fund', color: 'blue' },
    { name: 'PE/VC', color: 'purple' },
    { name: 'Operator', color: 'green' },
    { name: 'Advisor', color: 'yellow' },
    { name: 'Banker', color: 'teal' },
    { name: 'Broker', color: 'gray' },
    { name: 'LP', color: 'red' },
    { name: 'CEO', color: 'blue' },
    { name: 'Board Member', color: 'purple' },
    { name: 'Industry Expert', color: 'green' },
  ];
  for (const tag of defaultTags) await DB.add(STORES.tags, { ...tag, userId });

  // Inherit shared API keys from deployment config (if set by admin)
  const _sharedCfg = window.PULSE_SHARED_CONFIG || {};

  await DB.add(STORES.settings, {
    id: `settings_${userId}`,
    userId,
    theme: 'light',
    emailReminders: false,
    reminderEmail: '',
    defaultFollowUpDays: 14,
    stageCadence: {
      'New intro': 7, 'Met once': 14, 'Active relationship': 30,
      'Warm relationship': 60, 'Needs follow-up': 3,
    },
    openaiApiKey:       _sharedCfg.openaiApiKey       || '',
    claudeApiKey:       _sharedCfg.claudeApiKey       || '',
    tavilyApiKey:       _sharedCfg.tavilyApiKey       || '',
    firecrawlApiKey:    _sharedCfg.firecrawlApiKey    || '',
    rapidApiKey:        _sharedCfg.rapidApiKey        || '',
    googlePlacesApiKey: _sharedCfg.googlePlacesApiKey || '',
    linkedInConnected: false, linkedInProfileUrl: '',
    newsRegions: ['USA', 'Europe'],
  });
}

function deleteAccount() {
  openModal(`
    <div class="p-6">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
          <svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
          </svg>
        </div>
        <div>
          <h3 class="text-lg font-semibold text-red-600">Delete Account</h3>
          <p class="text-xs text-surface-500">This permanently removes your account and all data</p>
        </div>
      </div>
      <div class="bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-800 rounded p-3 mb-5 text-sm text-red-700 dark:text-red-400">
        <strong>Warning:</strong> All contacts, companies, deals, calls, notes, and your account will be <strong>permanently deleted</strong>. This cannot be undone.
      </div>
      <div class="mb-4">
        <label class="block text-sm font-medium mb-1.5">Enter your password to confirm</label>
        <input type="password" id="delete-account-password" class="input-field" placeholder="Your account password"
          onkeydown="if(event.key==='Enter') confirmDeleteAccount()" autofocus />
        <p id="delete-account-error" class="text-xs text-red-600 mt-1.5 hidden">Incorrect password. Please try again.</p>
      </div>
      <div class="flex justify-end gap-3">
        <button onclick="closeModal()" class="btn-secondary">Cancel</button>
        <button onclick="confirmDeleteAccount()" class="btn-danger flex items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
          Delete My Account
        </button>
      </div>
    </div>
  `, { small: true });
  setTimeout(() => document.getElementById('delete-account-password')?.focus(), 50);
}

async function confirmDeleteAccount() {
  const input = document.getElementById('delete-account-password');
  const errorEl = document.getElementById('delete-account-error');
  if (!input) return;

  const password = input.value;
  if (!password) { input.focus(); return; }

  const user = await DB.get(STORES.users, currentUser.id);
  const enteredHash = await hashPassword(password);
  if (enteredHash !== user.passwordHash) {
    errorEl.classList.remove('hidden');
    input.value = '';
    input.focus();
    return;
  }

  closeModal();

  for (const store of Object.values(STORES)) {
    if (store === 'users' || store === 'settings') continue;
    const items = await DB.getAll(store);
    for (const item of items) {
      if (item.userId === currentUser.id) await DB.delete(store, item.id);
    }
  }
  await DB.delete(STORES.settings, `settings_${user.id}`);
  await DB.delete(STORES.users, user.id);

  localStorage.removeItem('pulse_user_id');
  localStorage.removeItem('pulse_show_tutorial_' + user.id);
  currentUser = null;

  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
  showAuthLogin();
  showToast('Account deleted', 'info');
}

function showApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');

  // Seed the demo deal for this user (fire-and-forget — won't block the UI)
  if (currentUser) {
    seedDemoDeal(currentUser.id).catch(() => {});
  }

  // Restore the page from URL hash (so refresh keeps you on the same tab)
  const hashPage = location.hash.slice(1);
  const startPage = (hashPage && typeof VALID_PAGES !== 'undefined' && VALID_PAGES.has(hashPage))
    ? hashPage
    : 'dashboard';
  navigate(startPage);
  checkReminders();

  // Show onboarding tutorial for new users (flag set at registration time)
  if (currentUser && localStorage.getItem('pulse_show_tutorial_' + currentUser.id)) {
    setTimeout(() => {
      if (typeof startTutorial === 'function') startTutorial();
    }, 600);
  }

  // Restore Gmail token if user had connected previously
  if (typeof initGmailSync === 'function') initGmailSync();
}
