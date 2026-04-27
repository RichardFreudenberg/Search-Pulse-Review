/* ============================================
   Nexus CRM — Main App Bootstrap
   ============================================ */

let currentPage = 'dashboard';

// Valid pages — anything not in this set falls back to dashboard
const VALID_PAGES = new Set([
  'dashboard','contacts','companies','calls','reminders',
  'suggestions','news','resources','deals','deal-search',
  'company-scout','sourcing','settings','shared-dashboard',
  'email-templates','brokers',
]);

// Nav tab switcher
const DEALS_PAGES = new Set(['deals','deal-search','company-scout','sourcing','shared-dashboard','email-templates','brokers']);

function switchNavTab(tab) {
  const relPanel  = document.getElementById('nav-panel-relationships');
  const dealPanel = document.getElementById('nav-panel-deals');
  const relTab    = document.getElementById('tab-relationships');
  const dealTab   = document.getElementById('tab-deals');
  if (!relPanel || !dealPanel) return;
  const isDeals = tab === 'deals';
  relPanel.classList.toggle('hidden', isDeals);
  dealPanel.classList.toggle('hidden', !isDeals);
  relTab?.classList.toggle('active', !isDeals);
  dealTab?.classList.toggle('active', isDeals);

  // When already on the dashboard, sync the dashboard tab automatically.
  // This makes clicking "Deals" switch to the Deals dashboard tab, and
  // clicking "Relationships" switch to the Overview tab — no extra click needed.
  if (currentPage === 'dashboard' && typeof switchDashboardTab === 'function') {
    switchDashboardTab(isDeals ? 'deals' : 'overview');
  }
}

// Navigation
function navigate(page, { pushState = true } = {}) {
  if (!VALID_PAGES.has(page)) page = 'dashboard';
  currentPage = page;

  // Update URL hash so refresh / back-button work
  if (pushState) {
    history.pushState({ page }, '', '#' + page);
  }

  // Switch sidebar tab to match the page
  switchNavTab(DEALS_PAGES.has(page) ? 'deals' : 'relationships');

  // Update nav active states
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // Close mobile sidebar
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.remove('open');
  overlay.classList.add('hidden');

  // Render page
  switch (page) {
    case 'dashboard': renderDashboard(); break;
    case 'contacts': renderContacts(); break;
    case 'companies': renderCompanies(); break;
    case 'calls': renderCalls(); break;
    case 'reminders': renderReminders(); break;
    case 'suggestions': renderSuggestions(); break;
    case 'news': renderNews(); break;
    case 'resources': renderResources(); break;
    case 'deals': renderDeals(); break;
    case 'deal-search': renderDealSearch(); break;
    case 'company-scout': renderCompanyScout(); break;
    case 'sourcing': renderSourcing(); break;
    case 'settings': renderSettings(); break;
    case 'shared-dashboard': renderSharedDashboardPage(); break;
    case 'email-templates': renderEmailTemplates(); break;
    case 'brokers': renderBrokers(); break;
    default: renderDashboard();
  }
}

// Back / forward button support
window.addEventListener('popstate', (e) => {
  if (!currentUser) return; // ignore if not logged in
  const page = (e.state?.page) || (location.hash.slice(1)) || 'dashboard';
  navigate(page, { pushState: false });
});

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('hidden');
}

// ============================================
// Networking Suggestions Tab
// ============================================
async function renderSuggestions() {
  const pageContent = document.getElementById('page-content');
  pageContent.innerHTML = `<div class="p-4 lg:p-8 max-w-5xl mx-auto">${renderLoadingSkeleton(5)}</div>`;

  const [contacts, companies, calls, tags, settings] = await Promise.all([
    DB.getForUser(STORES.contacts, currentUser.id),
    DB.getForUser(STORES.companies, currentUser.id),
    DB.getForUser(STORES.calls, currentUser.id),
    DB.getForUser(STORES.tags, currentUser.id),
    DB.get(STORES.settings, `settings_${currentUser.id}`),
  ]);

  const activeContacts = getActiveContacts(contacts);
  const companyMap = buildMap(companies);
  const linkedInConnected = !!(settings && settings.linkedInProfileUrl);

  // Analyze existing network to generate suggestions
  const analysis = analyzeNetwork(activeContacts, companies, calls);

  pageContent.innerHTML = `
    <div class="p-4 lg:p-8 max-w-5xl mx-auto animate-fade-in">
      ${renderPageHeader('Networking Suggestions', 'People you should consider connecting with based on your network')}

      <!-- LinkedIn Connection Banner -->
      ${!linkedInConnected ? `
        <div class="card mb-6 bg-gradient-to-r from-[#0A66C2]/5 to-brand-50 dark:from-[#0A66C2]/10 dark:to-brand-900/20 border-[#0A66C2]/20">
          <div class="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div class="flex items-center gap-3 flex-1">
              <svg class="w-8 h-8 text-[#0A66C2] flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
              <div>
                <h3 class="text-sm font-semibold">Connect your LinkedIn for better suggestions</h3>
                <p class="text-xs text-surface-500">Get personalized connection recommendations based on your profile and network.</p>
              </div>
            </div>
            <button onclick="navigate('settings')" class="btn-primary btn-sm whitespace-nowrap">Connect LinkedIn</button>
          </div>
        </div>
      ` : `
        <div class="flex items-center gap-2 px-4 py-2 bg-green-50 dark:bg-green-900/15 border border-green-200 dark:border-green-800 rounded mb-6">
          <svg class="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span class="text-sm text-green-700 dark:text-green-400">LinkedIn connected — suggestions personalized to your profile</span>
          <a href="${escapeHtml(settings.linkedInProfileUrl)}" target="_blank" class="ml-auto text-xs text-green-600 hover:underline">View profile →</a>
        </div>
      `}

      <!-- Network Analysis Summary -->
      <div class="card mb-6">
        <h2 class="text-base font-semibold mb-3">Your Network Profile</h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
          <div>
            <div class="text-2xl font-bold text-brand-600">${activeContacts.length}</div>
            <div class="text-xs text-surface-500">Total Contacts</div>
          </div>
          <div>
            <div class="text-2xl font-bold text-purple-600">${analysis.industries.length}</div>
            <div class="text-xs text-surface-500">Industries</div>
          </div>
          <div>
            <div class="text-2xl font-bold text-green-600">${calls.length}</div>
            <div class="text-xs text-surface-500">Calls Made</div>
          </div>
          <div>
            <div class="text-2xl font-bold text-yellow-600">${analysis.topTags.length}</div>
            <div class="text-xs text-surface-500">Active Tags</div>
          </div>
        </div>
      </div>

      <!-- Priority Contacts (real data only) -->
      ${(() => {
        const priority = getPrioritizedContacts(activeContacts, companyMap, calls);
        if (priority.length === 0) return '';
        return `
        <div class="card mb-6">
          <h2 class="text-base font-semibold mb-2">Contacts to Prioritize</h2>
          <p class="text-xs text-surface-500 mb-4">People already in your network who need attention — no calls yet, stale LP/investor relationships, or stuck in early stages.</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            ${priority.map(p => {
              const company = companyMap[p.companyId];
              return `
              <div class="flex items-start gap-3 p-4 rounded border border-surface-200 dark:border-surface-700 hover:border-brand-300 dark:hover:border-brand-600 transition-colors cursor-pointer" onclick="viewContact('${p.id}')">
                ${renderAvatar(p.fullName, p.photoUrl, 'md', p.linkedInUrl)}
                <div class="flex-1 min-w-0">
                  <h3 class="text-sm font-semibold truncate">${escapeHtml(p.fullName)}</h3>
                  <p class="text-xs text-surface-500 truncate">${escapeHtml(p.title || '')}${company ? ' · ' + escapeHtml(company.name) : ''}</p>
                  <p class="text-xs text-amber-600 dark:text-amber-400 mt-1">${escapeHtml(p._reason)}</p>
                  <div class="flex gap-2 mt-2">
                    <button onclick="event.stopPropagation(); openNewCallModal('${p.id}')" class="btn-primary btn-xs">Log Call</button>
                    ${p.linkedInUrl ? `<a href="${escapeHtml(p.linkedInUrl)}" target="_blank" onclick="event.stopPropagation()" class="btn-secondary btn-xs">LinkedIn</a>` : ''}
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      })()}

      <!-- LinkedIn Searches (keep redirect capability) -->
      <div class="card mb-6">
        <h2 class="text-base font-semibold mb-2">Targeted LinkedIn Searches</h2>
        <p class="text-xs text-surface-500 mb-4">Open these searches directly on LinkedIn to find more people.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${analysis.suggestedSearches.slice(0, 6).map((s, i) => `
            <a href="${escapeHtml(s.linkedInUrl)}" target="_blank" class="flex items-center gap-3 p-3 rounded border border-surface-200 dark:border-surface-700 hover:border-brand-300 dark:hover:border-brand-600 transition-colors">
              <div class="p-2 rounded-lg bg-brand-50 dark:bg-brand-900/20 text-brand-600 dark:text-brand-400 flex-shrink-0">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="text-sm font-medium truncate">${escapeHtml(s.title)}</h3>
                <p class="text-xs text-surface-500">${escapeHtml(s.reason)}</p>
              </div>
              <svg class="w-4 h-4 text-surface-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
            </a>
          `).join('')}
        </div>
      </div>

      <!-- Company-based suggestions -->
      ${analysis.suggestedCompanies.length > 0 ? `
        <div class="card mb-6">
          <h2 class="text-base font-semibold mb-2">Companies to Explore</h2>
          <p class="text-xs text-surface-500 mb-4">Companies similar to those in your network</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${analysis.suggestedCompanies.map(c => `
              <div class="p-3 rounded border border-surface-200 dark:border-surface-700">
                <div class="flex items-center gap-2 mb-1">
                  <div class="w-6 h-6 rounded bg-white border border-surface-200 flex items-center justify-center overflow-hidden">
                    <img src="https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(c.name.toLowerCase().replace(/[^a-z0-9]/g,''))}.com" class="w-4 h-4" onerror="this.style.display='none'" />
                  </div>
                  <h3 class="text-sm font-medium">${escapeHtml(c.name)}</h3>
                </div>
                <p class="text-xs text-surface-500 mt-0.5">${escapeHtml(c.reason)}</p>
                <a href="https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(c.name)}&origin=GLOBAL_SEARCH_HEADER" target="_blank" class="text-xs text-brand-600 hover:underline mt-2 inline-block">Find people →</a>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Smart suggestions -->
      <div class="card mb-6">
        <h2 class="text-base font-semibold mb-2">People in Your Network to Re-engage</h2>
        <p class="text-xs text-surface-500 mb-4">Existing contacts you haven't spoken to recently</p>
        ${await renderReengageSuggestions(activeContacts, companyMap)}
      </div>
    </div>
  `;
}

function getPrioritizedContacts(contacts, companyMap, calls) {
  // Returns real contacts from the DB that need attention — never called, stale LPs, or stuck in early stage
  const callContactIds = new Set(calls.map(c => c.contactId));
  const seen = new Set();
  const results = [];

  // 1. LP / Investor / Advisor contacts not contacted in 30+ days (highest priority)
  const investorTags = ['LP', 'Investor', 'Search Fund', 'PE/VC', 'Advisor', 'Board Member'];
  const staleInvestors = contacts
    .filter(c => {
      const hasTag = (c.tags || []).some(t => investorTags.includes(t));
      if (!hasTag || seen.has(c.id)) return false;
      const days = c.lastContactDate ? Math.abs(daysUntil(c.lastContactDate)) : 999;
      return days > 30;
    })
    .sort((a, b) => {
      const da = a.lastContactDate ? new Date(a.lastContactDate) : new Date(0);
      const db = b.lastContactDate ? new Date(b.lastContactDate) : new Date(0);
      return da - db;
    });
  for (const c of staleInvestors.slice(0, 3)) {
    const days = c.lastContactDate ? Math.abs(daysUntil(c.lastContactDate)) : null;
    results.push({ ...c, _reason: days ? `${investorTags.find(t => (c.tags||[]).includes(t))} — ${days} days since last contact` : 'Key contact — never contacted' });
    seen.add(c.id);
  }

  // 2. Contacts added but never had a call logged
  const neverCalled = contacts
    .filter(c => !callContactIds.has(c.id) && !seen.has(c.id))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  for (const c of neverCalled.slice(0, 3)) {
    results.push({ ...c, _reason: 'No calls logged yet — schedule your first conversation' });
    seen.add(c.id);
  }

  // 3. Contacts stuck in "New intro" for 14+ days
  const stuckNewIntro = contacts
    .filter(c => {
      if (seen.has(c.id) || c.stage !== 'New intro') return false;
      return Math.abs(daysUntil(c.createdAt || new Date().toISOString())) > 14;
    });
  for (const c of stuckNewIntro.slice(0, 2)) {
    results.push({ ...c, _reason: 'Still at "New intro" — follow up to deepen the relationship' });
    seen.add(c.id);
  }

  return results.slice(0, 8);
}

function analyzeNetwork(contacts, companies, calls) {
  // Extract patterns from existing network
  const companyMap = buildMap(companies);

  // Collect industries
  const industries = [...new Set(companies.map(c => c.industry).filter(Boolean))];

  // Collect tags
  const tagCounts = {};
  contacts.forEach(c => (c.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([tag]) => tag);

  // Collect titles/roles
  const titles = contacts.map(c => c.title).filter(Boolean);
  const titlePatterns = extractTitlePatterns(titles);

  // Most called contacts (to understand focus areas)
  const callCounts = {};
  calls.forEach(c => { callCounts[c.contactId] = (callCounts[c.contactId] || 0) + 1; });
  const mostCalled = Object.entries(callCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const focusContacts = mostCalled.map(([id]) => contacts.find(c => c.id === id)).filter(Boolean);

  // Generate suggested LinkedIn searches
  const suggestedSearches = [];

  // Search for similar roles at companies in the network
  if (industries.length > 0) {
    for (const industry of industries.slice(0, 2)) {
      suggestedSearches.push({
        title: `Search fund professionals in ${industry}`,
        reason: `You have ${companies.filter(c => c.industry === industry).length} companies in ${industry}`,
        linkedInUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`search fund ${industry}`)}&origin=GLOBAL_SEARCH_HEADER`,
        googleUrl: `https://www.google.com/search?q=${encodeURIComponent(`"search fund" "${industry}" site:linkedin.com`)}`,
      });
    }
  }

  // Search based on top tags
  if (topTags.includes('PE/VC')) {
    suggestedSearches.push({
      title: 'Private equity professionals in lower middle market',
      reason: 'Based on your PE/VC connections',
      linkedInUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('private equity lower middle market')}&origin=GLOBAL_SEARCH_HEADER`,
      googleUrl: `https://www.google.com/search?q=${encodeURIComponent('"private equity" "lower middle market" site:linkedin.com')}`,
    });
  }

  if (topTags.includes('Advisor') || topTags.includes('Board Member')) {
    suggestedSearches.push({
      title: 'Operating advisors and board members',
      reason: 'Based on your advisor connections',
      linkedInUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('operating advisor small business acquisition')}&origin=GLOBAL_SEARCH_HEADER`,
    });
  }

  if (topTags.includes('Broker')) {
    suggestedSearches.push({
      title: 'Business brokers and M&A intermediaries',
      reason: 'Based on your broker relationships',
      linkedInUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('business broker M&A intermediary')}&origin=GLOBAL_SEARCH_HEADER`,
    });
  }

  // General search fund network expansion
  suggestedSearches.push({
    title: 'Search fund entrepreneurs and alumni',
    reason: 'Core search fund network expansion',
    linkedInUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('search fund entrepreneur CEO acquisition')}&origin=GLOBAL_SEARCH_HEADER`,
    googleUrl: `https://www.google.com/search?q=${encodeURIComponent('"search fund" entrepreneur site:linkedin.com')}`,
  });

  suggestedSearches.push({
    title: 'HBS search fund alumni',
    reason: 'Fellow HBS searchers and operators',
    linkedInUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('Harvard Business School search fund')}&origin=GLOBAL_SEARCH_HEADER`,
  });

  // Company-based people search
  for (const contact of focusContacts.slice(0, 2)) {
    const company = companyMap[contact.companyId];
    if (company) {
      suggestedSearches.push({
        title: `More people at ${company.name}`,
        reason: `You've had ${callCounts[contact.id]} calls with ${contact.fullName} there`,
        linkedInUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(company.name)}&origin=GLOBAL_SEARCH_HEADER`,
      });
    }
  }

  // Generate role suggestions
  const suggestedRoles = [
    {
      role: 'Search Fund Investors / LPs',
      reason: 'Key for raising your search fund capital',
      color: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400',
      icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>',
      searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('search fund investor LP')}&origin=GLOBAL_SEARCH_HEADER`,
    },
    {
      role: 'Successful Search Fund CEOs',
      reason: 'Learn from operators who completed acquisitions',
      color: 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400',
      icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M18.75 4.236c.982.143 1.954.317 2.916.52A6.003 6.003 0 0016.27 9.728M18.75 4.236V4.5c0 2.108-.966 3.99-2.48 5.228m0 0a6.003 6.003 0 01-2.54.828" /></svg>',
      searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('search fund CEO acquisition entrepreneur')}&origin=GLOBAL_SEARCH_HEADER`,
    },
    {
      role: 'Industry Operators',
      reason: 'Domain experts in target acquisition industries',
      color: 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
      icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11.42 15.17l-5.1-5.1m0 0L12 4.36m-5.67 5.71h14.34" /></svg>',
      searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('CEO small business operator')}&origin=GLOBAL_SEARCH_HEADER`,
    },
    {
      role: 'M&A Advisors and Bankers',
      reason: 'Source deal flow and get valuation guidance',
      color: 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400',
      icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" /></svg>',
      searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent('M&A advisor investment banker lower middle market')}&origin=GLOBAL_SEARCH_HEADER`,
    },
  ];

  // Suggested companies (based on industries in network)
  const suggestedCompanies = [];
  const searchFundCompanies = [
    { name: 'Pacific Lake Partners', reason: 'Major search fund investor' },
    { name: 'Search Fund Partners', reason: 'Dedicated search fund LP' },
    { name: 'Relay Investments', reason: 'Active search fund accelerator' },
    { name: 'Enduring Ventures', reason: 'Search fund holding company' },
  ];

  // Only suggest companies not already in the user's network
  const existingCompanyNames = new Set(companies.map(c => c.name.toLowerCase()));
  for (const sc of searchFundCompanies) {
    if (!existingCompanyNames.has(sc.name.toLowerCase())) {
      suggestedCompanies.push(sc);
    }
  }

  return {
    industries,
    topTags,
    titlePatterns,
    suggestedSearches: suggestedSearches.slice(0, 8),
    suggestedRoles,
    suggestedCompanies,
  };
}

function extractTitlePatterns(titles) {
  const patterns = {};
  for (const title of titles) {
    const normalized = title.toLowerCase();
    const keywords = ['director', 'partner', 'vp', 'ceo', 'cfo', 'coo', 'managing', 'principal', 'associate', 'analyst', 'founder', 'president', 'advisor'];
    for (const kw of keywords) {
      if (normalized.includes(kw)) {
        patterns[kw] = (patterns[kw] || 0) + 1;
      }
    }
  }
  return Object.entries(patterns).sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

async function renderReengageSuggestions(contacts, companyMap) {
  // Contacts not contacted in 30+ days, or never contacted
  const stale = contacts.filter(c => {
    if (!c.lastContactDate) return true;
    return Math.abs(daysUntil(c.lastContactDate)) > 30;
  }).sort((a, b) => {
    const da = a.lastContactDate ? new Date(a.lastContactDate) : new Date(0);
    const db = b.lastContactDate ? new Date(b.lastContactDate) : new Date(0);
    return da - db;
  });

  if (stale.length === 0) {
    return '<p class="text-sm text-surface-500 py-4 text-center">All contacts are active — great job!</p>';
  }

  return `
    <div class="space-y-2">
      ${stale.slice(0, 8).map(c => {
        const company = companyMap[c.companyId];
        const daysSince = c.lastContactDate ? Math.abs(daysUntil(c.lastContactDate)) : null;
        return `
          <div class="flex items-center gap-3 p-3 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-800/50 cursor-pointer" onclick="viewContact('${c.id}')">
            ${renderAvatar(c.fullName, c.photoUrl, 'sm', c.linkedInUrl)}
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium truncate">${escapeHtml(c.fullName)}</div>
              <div class="text-xs text-surface-500 truncate">${escapeHtml(c.title || '')}${company ? ' · ' + escapeHtml(company.name) : ''}</div>
            </div>
            <span class="text-xs text-surface-400">${daysSince ? `${daysSince} days ago` : 'Never contacted'}</span>
            <button onclick="event.stopPropagation(); openNewCallModal('${c.id}')" class="btn-primary btn-xs">
              Call
            </button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}


// ============================================
// Seed Demo Data
// ============================================
async function seedDemoData(userId) {
  // Idempotency guard: don't seed if demo companies already exist for this user
  try {
    const existing = await DB.getAll(STORES.companies);
    if (existing.some(c => c.userId === userId && c.isDemo)) return;
  } catch (_) {}

  // Companies
  const companies = [
    { name: 'Alpine Investors', industry: 'Private Equity', size: '100-200', website: 'https://alpineinvestors.com', description: 'PeopleFirst PE firm focused on software and services', logoUrl: '' },
    { name: 'Search Fund Partners', industry: 'Search Fund Investing', size: '10-20', website: 'https://searchfundpartners.com', description: 'Dedicated search fund LP and advisor', logoUrl: '' },
    { name: 'McKinsey & Company', industry: 'Management Consulting', size: '10000+', website: 'https://mckinsey.com', description: 'Global management consulting firm', logoUrl: '' },
    { name: 'Riverside Partners', industry: 'Private Equity', size: '50-100', website: 'https://riversidepartners.com', description: 'Lower middle market PE firm', logoUrl: '' },
    { name: 'Enduring Ventures', industry: 'Holding Company', size: '20-50', website: '', description: 'Search fund holding company and incubator', logoUrl: '' },
  ];

  const companyIds = [];
  for (const c of companies) {
    const saved = await DB.add(STORES.companies, { ...c, userId, isDemo: true });
    companyIds.push(saved.id);
  }

  // Contacts
  const contactData = [
    { fullName: 'Sarah Chen', title: 'Managing Director', companyId: companyIds[0], email: 'sarah.chen@alpineinvestors.com', phone: '+1 (415) 555-0101', stage: 'Active relationship', tags: ['PE/VC', 'Search Fund', 'LP'], location: 'San Francisco, CA', linkedInUrl: 'https://linkedin.com/in/sarahchen', notes: 'Met at HBS search fund conference. Very knowledgeable about B2B software acquisitions. She mentioned they look at deals in the $5-20M revenue range.' },
    { fullName: 'Michael Torres', title: 'Partner', companyId: companyIds[1], email: 'michael@searchfundpartners.com', phone: '+1 (212) 555-0202', stage: 'Warm relationship', tags: ['Search Fund', 'LP', 'Advisor'], location: 'New York, NY', linkedInUrl: 'https://linkedin.com/in/michaeltorres', notes: 'Introduced by Professor Smith. Has funded 15+ searchers. Prefers traditional search model. Family is from Mexico, grew up in Texas. Very warm and helpful.' },
    { fullName: 'Emma Richardson', title: 'Engagement Manager', companyId: companyIds[2], email: 'emma.richardson@mckinsey.com', phone: '+1 (617) 555-0303', stage: 'Met once', tags: ['Operator', 'Industry Expert'], location: 'Boston, MA', linkedInUrl: '', notes: 'Met at networking event. Considering leaving consulting to do a search. Background in healthcare services. Has two kids, lives in Brookline.' },
    { fullName: 'David Park', title: 'CEO & Founder', companyId: companyIds[4], email: 'david@enduringventures.com', phone: '+1 (650) 555-0404', stage: 'Active relationship', tags: ['CEO', 'Search Fund', 'Operator'], location: 'Palo Alto, CA', notes: 'Successfully completed search in 2019, acquired HVAC services company. Great mentor for the search process. Recommended reading the Stanford search fund primer.' },
    { fullName: 'Lisa Wang', title: 'Principal', companyId: companyIds[3], email: 'lwang@riversidepartners.com', stage: 'New intro', tags: ['PE/VC', 'Banker'], location: 'Chicago, IL', notes: 'Cold outreach via LinkedIn. She focuses on healthcare and business services deals.' },
    { fullName: 'James Okafor', title: 'Operating Advisor', companyId: null, email: 'james.okafor@gmail.com', phone: '+1 (310) 555-0606', stage: 'Needs follow-up', tags: ['Advisor', 'Board Member', 'Operator'], location: 'Los Angeles, CA', notes: 'Former CEO of a search fund acquisition. Now advises 3 portfolio companies. Mentioned he\'s looking for more board seats. Follow up with our deck.' },
    { fullName: 'Rachel Abramson', title: 'Business Broker', companyId: null, email: 'rachel@sunbeltbrokers.com', phone: '+1 (404) 555-0707', stage: 'Warm relationship', tags: ['Broker'], location: 'Atlanta, GA', notes: 'Met through James. Specializes in B2B services businesses in the Southeast. $2-10M revenue range. Send her our acquisition criteria.' },
    { fullName: 'Tom Fitzgerald', title: 'Search Fund Entrepreneur', companyId: null, email: 'tom.fitz@stanford.edu', stage: 'Active relationship', tags: ['Search Fund', 'CEO'], location: 'Austin, TX', notes: 'Fellow searcher, HBS 2024. Currently in active search phase. Shares deal flow occasionally. Good sounding board for due diligence questions.' },
  ];

  const contactIds = [];
  for (const c of contactData) {
    const daysAgo = Math.floor(Math.random() * 60);
    const saved = await DB.add(STORES.contacts, {
      ...c,
      userId,
      isDemo: true,
      photoUrl: '',
      lastContactDate: addDays(new Date(), -daysAgo),
      nextFollowUpDate: addDays(new Date(), Math.floor(Math.random() * 21) - 7),
      archived: false,
    });
    contactIds.push(saved.id);

    // Add activity
    await DB.add(STORES.activities, {
      userId,
      isDemo: true,
      contactId: saved.id,
      type: 'created',
      title: 'Contact created',
      description: `Added ${c.fullName}`,
      timestamp: addDays(new Date(), -(daysAgo + 5)),
    });

    // Add note
    if (c.notes) {
      await DB.add(STORES.notes, {
        userId,
        isDemo: true,
        contactId: saved.id,
        callId: null,
        content: c.notes,
        cleanedContent: null,
      });
    }
  }

  // Calls
  const callsData = [
    { contactId: contactIds[0], date: addDays(new Date(), -5), duration: 30, outcome: 'Great call', notes: 'Discussed their investment thesis for B2B software. They look for $5-20M revenue, >70% recurring, low churn. She offered to intro me to two searchers in their portfolio. Very impressed by the alpine people-first approach.', nextSteps: 'Send our search criteria document. Schedule intro calls with their portfolio searchers.' },
    { contactId: contactIds[1], date: addDays(new Date(), -12), duration: 45, outcome: 'Good conversation', notes: 'Deep dive on the economics of search funds. He shared data on median outcomes and common pitfalls. Key insight: focus on industries with fragmented ownership and recurring revenue. He wants to see our PPM when ready.', nextSteps: 'Draft PPM executive summary. Send articles he recommended about search fund structures.' },
    { contactId: contactIds[2], date: addDays(new Date(), -20), duration: 25, outcome: 'Intro made', notes: 'Quick coffee chat. She is seriously considering leaving McKinsey in 6 months. Interested in healthcare services specifically home health and hospice. I offered to connect her with David Park who has experience in services.', nextSteps: 'Make intro to David. Send her the HBS search fund study.' },
    { contactId: contactIds[3], date: addDays(new Date(), -3), duration: 60, outcome: 'Great call', notes: 'Extensive mentorship call. Walked through his entire search process from fundraising to close. Key takeaways: 1) Start building LP relationships 6 months before you need capital 2) The best deals come from proprietary outreach not brokers 3) Dont skip quality of earnings. He acquired at 4.5x EBITDA for a $8M revenue HVAC business.', nextSteps: 'Review his recommended DD checklist. Ask about his QoE provider.' },
    { contactId: contactIds[6], date: addDays(new Date(), -8), duration: 20, outcome: 'Good conversation', notes: 'She has 3 potential listings coming to market in Q2. B2B janitorial services ($4M rev), commercial landscaping ($6M rev), and a staffing company ($8M rev). Will send teasers when available. Prefers to work with search fund buyers.', nextSteps: 'Send her our formal acquisition criteria one-pager.' },
  ];

  for (const call of callsData) {
    const saved = await DB.add(STORES.calls, { ...call, userId, isDemo: true });

    await DB.add(STORES.notes, {
      userId,
      isDemo: true,
      contactId: call.contactId,
      callId: saved.id,
      content: call.notes,
      cleanedContent: null,
    });

    await DB.add(STORES.activities, {
      userId,
      isDemo: true,
      contactId: call.contactId,
      type: 'call',
      title: 'Call logged',
      description: call.outcome,
      timestamp: call.date,
    });
  }

  // Reminders
  const remindersData = [
    { contactId: contactIds[0], title: 'Follow up with Sarah Chen', description: 'Send search criteria doc and ask about portfolio intros', dueDate: addDays(new Date(), 2), type: 'one-time', recurring: false },
    { contactId: contactIds[1], title: 'Send PPM draft to Michael Torres', description: 'He wants to review our fundraising materials', dueDate: addDays(new Date(), -1), type: 'one-time', recurring: false },
    { contactId: contactIds[5], title: 'Follow up with James Okafor', description: 'Send him our pitch deck for board advisory', dueDate: addDays(new Date(), 0), type: 'one-time', recurring: false },
    { contactId: contactIds[6], title: 'Check in with Rachel on Q2 listings', description: 'She mentioned 3 deals coming to market', dueDate: addDays(new Date(), 5), type: 'one-time', recurring: false },
    { contactId: contactIds[7], title: 'Monthly catch-up with Tom', description: 'Share deal flow and search updates', dueDate: addDays(new Date(), 10), type: 'recurring', recurring: true, cadenceDays: 30 },
  ];

  for (const r of remindersData) {
    await DB.add(STORES.reminders, { ...r, userId, isDemo: true, status: 'pending' });
  }
}


// ============================================
// Seed Demo Deal — Apex Precision Manufacturing
// ============================================
async function seedDemoDeal(userId) {
  // Don't re-seed if the user has already cleared demo data
  if (localStorage.getItem('pulse_demo_cleared_' + userId)) return;
  // Only seed if the user has no deals yet
  const existing = await DB.getAll(STORES.deals).catch(() => []);
  if (existing.some(d => d.userId === userId)) return;

  // Helper: ISO date string N days from today (negative = past, positive = future)
  const fromToday = n => addDays(new Date(), n);

  // Create the acquisition target company
  const apexCo = await DB.add(STORES.companies, {
    userId,
    isDemo: true,
    name: 'Apex Precision Manufacturing',
    industry: 'Industrial Manufacturing',
    companyType: 'Acquisition Target',
    size: '51-200',
    location: 'Tulsa, OK',
    website: '',
    description: 'Precision CNC machining and fabrication serving oil & gas, aerospace, and industrial OEM clients. Founded 1987.',
    logoUrl: '',
  });

  // Create the deal
  const deal = await DB.add(STORES.deals, {
    userId,
    isDemo: true,
    name: 'Apex Precision Manufacturing',
    companyId: apexCo.id,
    stage: 'Due Diligence',
    status: 'Active',
    priority: 'High',
    source: 'Business Broker',
    sector: 'Industrial Manufacturing',
    location: 'Tulsa, OK',
    revenue:     8500000,
    ebitda:      1900000,
    askingPrice: 11875000,
    employees:   87,
    description: 'Precision CNC machining and fabrication shop serving oil & gas, aerospace, and industrial OEM clients. Founded 1987. Owner seeking retirement. Strong backlog, highly recurring customer revenue, and proprietary tooling for several large accounts.',
    highlights: [
      '$8.5M revenue with 22% EBITDA margins — above industry average for precision machining',
      '73% of revenue from customers with 5+ year relationships',
      'Proprietary tooling creates meaningful switching costs for top accounts',
      'Experienced management team (VP Ops + plant manager) willing to stay post-acquisition',
      '$2.1M backlog as of December 2024',
      'No single customer exceeds 18% of total revenue',
    ],
    concerns: [
      'Equipment fleet aging 8–12 years — capex investment likely required in years 1–3',
      'Oil & gas exposure (~40% of revenue) adds cyclical risk',
      'Owner holds key customer relationships — detailed transition plan needed',
      'Working capital intensity higher than peers (~28% of revenue)',
    ],
  });

  // Deal history — sourced 90 days ago, now in DD
  const historyItems = [
    { action: 'Sourced',               description: 'Received teaser from broker Rachel Abramson at Sunbelt Business Brokers. Precision machining, $8.5M revenue, 22% margins — fits our target profile.',       daysAgo: 90 },
    { action: 'NDA Signed',            description: 'Executed mutual NDA with seller. Received CIM and preliminary financial model from broker.',                                                               daysAgo: 75 },
    { action: 'CIM Review',            description: 'Completed internal CIM review. Revenue and EBITDA confirmed directionally with seller. Flagged capex cycle and oil & gas concentration as key DD items.', daysAgo: 58 },
    { action: 'Management Meeting',    description: 'Met with owner Bill Kowalski (CEO) and Sandra Reyes (VP Operations) at the plant in Tulsa. Toured facility. Strong team — Sandra is clearly running day-to-day. Confirmed $2.1M backlog. Owner looking for 18–24 month transition period.',  daysAgo: 43 },
    { action: 'LOI Submitted',         description: 'Submitted LOI at $11.875M (6.25x trailing EBITDA, 1.40x revenue). Requested 45-day exclusivity for due diligence. Seller countered at $13M — broker indicated $12M range is workable.',                                                     daysAgo: 21 },
    { action: 'Due Diligence Started', description: 'DD kickoff with seller and broker. Engaged Dixon Hughes Goodman for QoE (4-week timeline). Received data room access. LOI accepted at $11.875M after seller negotiation.',                                                                    daysAgo: 10 },
  ];

  for (const h of historyItems) {
    await DB.add(STORES.dealHistory, {
      dealId:      deal.id,
      userId,
      isDemo:      true,
      action:      h.action,
      description: h.description,
      timestamp:   fromToday(-h.daysAgo),
    });
  }

  // Deal documents (metadata only — data is null, not stored)
  const docItems = [
    { name: 'Apex Precision — Confidential Information Memorandum.pdf', category: 'CIM',         type: 'pdf',  size: 4310000, daysAgo: 73 },
    { name: 'Apex — 3-Year P&L 2022–2024.xlsx',                         category: 'Financials',  type: 'xlsx', size: 284000,  daysAgo: 72 },
    { name: 'Apex — Balance Sheet December 2024.xlsx',                   category: 'Financials',  type: 'xlsx', size: 148000,  daysAgo: 72 },
    { name: 'Executed NDA — Apex Precision Manufacturing.pdf',           category: 'Legal',       type: 'pdf',  size: 318000,  daysAgo: 74 },
    { name: 'LOI — Apex Precision Manufacturing (Signed).pdf',           category: 'Legal',       type: 'pdf',  size: 183000,  daysAgo: 20 },
    { name: 'Customer Revenue Concentration Analysis.xlsx',              category: 'DD Materials', type: 'xlsx', size: 97000,   daysAgo: 9  },
    { name: 'Equipment List & Independent Appraisal 2024.pdf',           category: 'DD Materials', type: 'pdf',  size: 763000,  daysAgo: 7  },
    { name: 'QoE Engagement Letter — Dixon Hughes Goodman.pdf',          category: 'DD Materials', type: 'pdf',  size: 213000,  daysAgo: 9  },
  ];

  for (const doc of docItems) {
    await DB.add(STORES.dealDocuments, {
      dealId:     deal.id,
      userId,
      isDemo:     true,
      name:       doc.name,
      category:   doc.category,
      type:       doc.type,
      size:       doc.size,
      data:       null,
      uploadedAt: fromToday(-doc.daysAgo),
    });
  }

  // Deal notes
  const noteItems = [
    { content: 'Initial impression: solid business. 37-year track record, established customer relationships, and strong EBITDA margins for precision machining. Main risks are capex cycle and oil & gas exposure. Worth proceeding to management meeting.', daysAgo: 70 },
    { content: 'Post-management meeting notes:\n\nBill (owner) is genuinely motivated — health concerns, no family successor. Sandra (VP Ops) is clearly running the plant day-to-day and is open to staying. Backlog feels real and was confirmed with specific customer names.\n\nKey items to focus on in DD:\n1. Customer contract stickiness and switching costs\n2. Capex requirements for the next 3–5 years (equipment aging)\n3. Revenue bridge 2022–2024 (slight dip in \'23 recovered in \'24)\n4. Owner\'s personal customer relationships — how transferable?', daysAgo: 40 },
    { content: 'LOI notes:\n\nSubmitted at $11.875M (6.25x trailing EBITDA). Justified to seller as in-line with comparable precision machining transactions in the lower middle market. Seller countered at $13M — broker signaled $12M range is workable. Standing firm at $11.875M and will use capex concerns from DD to justify. Exclusivity secured for 45 days.', daysAgo: 18 },
    { content: 'DD kickoff summary:\n\n• QoE firm: Dixon Hughes Goodman — 4-week timeline, prelim findings in week 3\n• Data room is well-organized; CIM financials appear to match QuickBooks exports\n• Open items: AR aging schedule, backlog detail by customer, equipment appraisal, top-5 customer reference calls\n• Legal: schedule SPA drafting for week 3 once QoE preliminary received\n• Environmental: Phase I report ordered, results expected in 2 weeks', daysAgo: 8 },
  ];

  for (const note of noteItems) {
    await DB.add(STORES.dealNotes, {
      dealId:    deal.id,
      userId,
      isDemo:    true,
      content:   note.content,
      createdAt: fromToday(-note.daysAgo),
    });
  }

  // Open deal tasks
  const taskItems = [
    { title: 'Review QoE preliminary findings from Dixon Hughes Goodman', status: 'in-progress', priority: 'High',   dueDate: fromToday(7)  },
    { title: 'Conduct top-3 customer reference calls',                    status: 'pending',     priority: 'High',   dueDate: fromToday(5)  },
    { title: 'Review independent equipment appraisal report',             status: 'pending',     priority: 'High',   dueDate: fromToday(3)  },
    { title: 'Confirm Phase I environmental report is clean',             status: 'pending',     priority: 'High',   dueDate: fromToday(5)  },
    { title: 'Model capex scenarios — maintenance vs. growth',            status: 'pending',     priority: 'Medium', dueDate: fromToday(10) },
    { title: 'Negotiate SPA terms with seller counsel',                   status: 'pending',     priority: 'Medium', dueDate: fromToday(14) },
  ];

  for (const task of taskItems) {
    await DB.add(STORES.dealTasks, {
      dealId:   deal.id,
      userId,
      isDemo:   true,
      title:    task.title,
      status:   task.status,
      priority: task.priority,
      dueDate:  task.dueDate,
    });
  }
}


// ============================================
// App Initialization
// ============================================
async function initApp() {
  // 1 — Migrate legacy databases (fire-and-forget errors are safe here)
  try {
    await migrateLegacyDB();
  } catch (err) {
    console.warn('[Pulse] Legacy DB migration failed (non-fatal):', err);
  }

  // 2 — Open / upgrade the main database
  let dbOk = false;
  try {
    await openDB();
    dbOk = true;
  } catch (err) {
    console.error('[Pulse] DB open failed:', err);
    if (err && (err.message === 'DB_BLOCKED' || err.message === 'DB_OPEN_TIMEOUT')) {
      // Surface a human-readable banner — don't block the rest of init.
      setTimeout(() => {
        if (typeof showToast === 'function') {
          showToast(
            'Database upgrade blocked — please close other Pulse tabs and refresh.',
            'warning'
          );
        }
      }, 200);
    }
  }

  // 3 — Check for shared dashboard link before anything else
  if (typeof checkSharedDashboardRoute === 'function' && checkSharedDashboardRoute()) {
    return; // Render shared view, skip auth
  }

  // 4 — Always wire up the auth forms regardless of DB status.
  //     Without this call the login submit handler is never attached,
  //     which makes the Sign-In button appear broken.
  try {
    setupAuthForms();
  } catch (err) {
    console.error('[Pulse] setupAuthForms failed:', err);
  }

  try {
    setupGlobalSearch();
  } catch (_) {}

  // 5 — Restore session (skip if DB failed to open)
  if (dbOk) {
    try {
      const user = await restoreSession();
      if (user) {
        showApp();
        return;
      }
    } catch (err) {
      console.warn('[Pulse] Session restore failed:', err);
    }
  }

  // 6 — Show login screen
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

// Boot
initApp();
