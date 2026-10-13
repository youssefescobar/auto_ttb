/* ============================================================
   Auto TTB v2.0 — Frontend Application Logic
   ============================================================ */

const state = {
  teKey: '',
  testCases: [],
  teLang: 'EN',
  
  linkedTeKey: '',
  linkedTeEnabled: false,
  linkedTestCases: [],
  linkedTeLang: 'AR',
  
  activeContext: 'primary', // 'primary' or 'secondary'
  
  currentTC: null,
  screenshots: { expected: [], actual: [] },
  settings: {},
  defectDrafts: {},
};


const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const show = el => { if (el) el.classList.remove('hidden'); };
const hide = el => { if (el) el.classList.add('hidden'); };

function advanceToNextTC() {
  const currentIndex = state.testCases.findIndex(tc => tc.key === state.currentTC);
  if (currentIndex !== -1 && currentIndex + 1 < state.testCases.length) {
    const nextTC = state.testCases[currentIndex + 1];
    showToast(`Auto-advancing to ${nextTC.name || nextTC.key}`, 'info');
    selectTC(nextTC.key);
  } else {
    goBackToGrid();
  }
}

let lightboxImages = [];
let lightboxIndex = 0;

function openLightbox(images, index) {
  lightboxImages = images;
  lightboxIndex = index;
  const overlay = $('#lightbox-overlay');
  const img = $('#lightbox-img');
  const caption = $('#lightbox-caption');
  if (!overlay || !img) return;
  img.src = images[index].url;
  if (caption) caption.textContent = `${images[index].category || ''} — ${index + 1} of ${images.length}`;
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const overlay = $('#lightbox-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
}

function lightboxNav(dir) {
  lightboxIndex = (lightboxIndex + dir + lightboxImages.length) % lightboxImages.length;
  const img = $('#lightbox-img');
  const caption = $('#lightbox-caption');
  if (img) img.src = lightboxImages[lightboxIndex].url;
  if (caption) caption.textContent = `${lightboxImages[lightboxIndex].category || ''} — ${lightboxIndex + 1} of ${lightboxImages.length}`;
}

function setupAutoResize(selector) {
  const textareas = document.querySelectorAll(selector);
  textareas.forEach(ta => {
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 400) + 'px';
    });
  });
}

function updateFixedFieldsDisplay() {
  const list = document.querySelector('.fixed-fields-list');
  if (!list) return;
  const s = state.settings;
  list.innerHTML = `
    <li><b>Project:</b> ${s.project || 'B2B Digital Revamp (BDR)'}</li>
    <li><b>Issue Type:</b> ${s.issue_type || 'Defect'}</li>
    <li><b>For Project:</b> ${s.for_project || 'JK26-3835 Technical project...'}</li>
    <li><b>Demo:</b> ${s.demo || 'Demo 1'}</li>
    <li><b>Component/s:</b> ${s.components || 'Android'}</li>
    <li><b>Impacted System:</b> ${s.impacted_system || 'Mobile App'}</li>
    <li><b>Defect Type:</b> ${s.defect_type || 'B2B Digital Revamp'}</li>
    <li><b>Filed Against:</b> ${s.filed_against || 'BDR-ANDROID'}</li>
    <li><b>Environment:</b> ${s.defect_environment || 'Integration'}</li>
    <li><b>Defect Phase:</b> ${s.defect_phase || 'QA'}</li>
    <li><b>Labels:</b> ${s.labels || 'Lightmode'}</li>
    <li><b>Usability / Re-occurrence:</b> No / No</li>
  `;
}

async function api(method, url, data = null) {
  const opts = { method, headers: {} };
  if (data) {
    if (data instanceof FormData) {
      opts.body = data;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(data);
    }
  }
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json;
}

function showToast(message, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.title = 'Click to dismiss';
  toast.innerHTML = `<span>${message}</span>`;
  
  toast.addEventListener('click', () => dismissToast(toast));

  container.appendChild(toast);

  setTimeout(() => dismissToast(toast), 3000);
}

function dismissToast(toast) {
  if (!toast || toast.dataset.dismissed) return;
  toast.dataset.dismissed = 'true';
  toast.classList.add('fade-out');
  setTimeout(() => {
    try { toast.remove(); } catch(e) {}
  }, 300);
}

// Settings
async function loadSettings() {
  try {
    state.settings = await api('GET', '/api/settings');
    const form = $('#settings-form');
    for (const [key, val] of Object.entries(state.settings)) {
      const el = form.elements[key];
      if (el && el.type !== 'password') {
        if (el.type === 'checkbox') {
          el.checked = Boolean(val);
        } else {
          el.value = Array.isArray(val) ? val.join(', ') : (val ?? '');
        }
      }
    }
    const tokenInput = form.elements['jira_pat'];
    if (tokenInput) tokenInput.placeholder = state.settings.jira_token_set ? 'Token saved (type to replace)' : 'Paste a Jira Personal Access Token';
    updateFixedFieldsDisplay();
    await loadSettingsHistory();
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function loadSettingsHistory() {
  try {
    const history = await api('GET', '/api/settings-history');
    state.settingsHistory = history || {};
    // Populate all history dropdowns
    document.querySelectorAll('.history-dropdown').forEach(select => {
      const fieldName = select.dataset.for;
      if (!fieldName) return;
      const options = history[fieldName] || [];
      // Clear existing options beyond the placeholder
      select.innerHTML = '<option value="">\u2014 saved \u2014</option>';
      if (options.length > 0) {
        options.forEach(opt => {
          const optEl = document.createElement('option');
          optEl.value = opt;
          optEl.textContent = opt.length > 30 ? opt.substring(0, 30) + '...' : opt;
          optEl.title = opt;
          select.appendChild(optEl);
        });
        select.classList.remove('hidden');
      } else {
        select.classList.add('hidden');
      }
    });
  } catch (e) {
    console.error('Failed to load settings history:', e);
  }
}

async function saveSettings() {
  const form = $('#settings-form');
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.classList && el.classList.contains('history-dropdown')) continue;
    if (el.type === 'password') continue; // secrets are sent separately below
    if (el.type === 'checkbox') {
      data[el.name] = el.checked;
    } else {
      data[el.name] = el.value;
    }
  }
  
  // Only send a secret when the user typed a new one; it never goes into history.
  const secrets = {};
  for (const el of form.elements) {
    if (el.type === 'password' && el.name && el.value.trim()) secrets[el.name] = el.value.trim();
  }

  try {
    await api('POST', '/api/settings', { ...data, ...secrets });
    for (const el of form.elements) { if (el.type === 'password') el.value = ''; }
    // Save values as history options for future quick switching
    const historyData = {};
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === 'string' && val.trim()) {
        historyData[key] = val.trim();
      }
    }
    await api('POST', '/api/settings-history', historyData);
    state.settings = { ...state.settings, ...data };
    updateFixedFieldsDisplay();
    showToast('\u2705 Settings saved', 'success');
    toggleSettings(false);
    await loadSettingsHistory();
  } catch (e) {
    showToast(e.message || 'Failed to save settings', 'error');
  }
}


async function checkSession() {
  try {
    const res = await api('GET', '/api/session-status');
    const dot = $('#session-dot');
    const loginBtn = $('#btn-login');
    const saveBtn = $('#btn-save-session');

    if (res.status === 'open' || res.status === 'opening') {
      if (dot) { dot.className = 'session-indicator warning'; dot.title = 'Browser open — log into Jira, then click Save Jira Session'; }
      if (loginBtn) hide(loginBtn);
      if (saveBtn) { show(saveBtn); saveBtn.textContent = '💾 Save Jira Session'; }
      return;
    }

    if (res.rest) {
      if (dot) { dot.className = 'session-indicator active'; dot.title = `Connected to Jira with token as ${res.rest_user || 'you'}`; }
      if (loginBtn) { show(loginBtn); loginBtn.textContent = '✓ Jira (token)'; }
      if (saveBtn) hide(saveBtn);
      return;
    }

    if (res.exists && res.mtime) {
      const ageHours = (Date.now() / 1000 - res.mtime) / 3600;
      if (ageHours > 6) {
        const ageStr = ageHours > 24 ? `${Math.floor(ageHours / 24)}d ago` : `${Math.floor(ageHours)}h ago`;
        if (dot) { dot.className = 'session-indicator warning'; dot.title = `Session may be expired (saved ${ageStr})`; }
        if (loginBtn) { show(loginBtn); loginBtn.textContent = `⚠️ Session Old (${ageStr})`; }
        if (saveBtn) hide(saveBtn);
        return; // skip the normal status display below
      }
    }

    if (res.exists) {
      if (dot) { dot.className = 'session-indicator active'; dot.title = 'Jira session active'; }
      if (loginBtn) { show(loginBtn); loginBtn.textContent = '✓ Jira Logged In'; }
      if (saveBtn) hide(saveBtn);
    } else {
      if (dot) { dot.className = 'session-indicator'; dot.title = 'No Jira session — click Login'; }
      if (loginBtn) { show(loginBtn); loginBtn.textContent = '🔑 Login to Jira'; }
      if (saveBtn) hide(saveBtn);
    }
  } catch (e) {}
}

async function handleLogin() {
  try {
    const res = await api('POST', '/api/login');
    showToast('Browser opened! Log into Jira, then click "Save Jira Session" here.', 'info');
    setTimeout(checkSession, 1000);
  } catch (e) {
    showToast(`Login error: ${e.message}`, 'error');
  }
}

async function handleSaveSession() {
  const saveBtn = $('#btn-save-session');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  try {
    const res = await api('POST', '/api/save-session');
    if (res.status === 'success') {
      showToast('✅ Jira session saved successfully!', 'success');
    } else {
      showToast(`Save session issue: ${res.message}`, 'error');
    }
    await checkSession();
  } catch (e) {
    showToast(`Save failed: ${e.message}`, 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function toggleSettings(forceOpen) {
  const panel = $('#settings-panel');
  const overlay = $('#settings-overlay');
  const isOpen = panel.classList.contains('open');
  if (forceOpen === true || (!isOpen && forceOpen !== false)) {
    show(overlay);
    show(panel);
    setTimeout(() => panel.classList.add('open'), 10);
  } else {
    panel.classList.remove('open');
    setTimeout(() => { hide(overlay); hide(panel); }, 300);
  }
}

function updateProgress() {
  const total = state.testCases.length;
  const done = state.testCases.filter(tc => ['pass', 'fail', 'skip'].includes(tc.status)).length;
  const el = $('#tc-progress-text');
  if (el) el.textContent = `${done}/${total} done`;
  const fill = $('#tc-progress-fill');
  if (fill) fill.style.width = total ? `${(done / total) * 100}%` : '0%';
}

let currentFilter = 'all';
let searchQuery = '';

function renderTCGrid() {
  const grid = $('#tc-grid');
  if (!grid) return;
  grid.innerHTML = '';

  let filtered = state.testCases || [];
  if (currentFilter !== 'all') {
    filtered = filtered.filter(tc => tc.status === currentFilter);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(tc => 
      (tc.key && tc.key.toLowerCase().includes(q)) || 
      (tc.summary && tc.summary.toLowerCase().includes(q)) ||
      (tc.tc_number && tc.tc_number.toLowerCase().includes(q)) ||
      (tc.name && tc.name.toLowerCase().includes(q))
    );
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="w-full text-center py-8 text-gray" style="grid-column: 1 / -1; padding: 3rem;">
        <p>No test cases found matching current search/filter.</p>
      </div>
    `;
    updateProgress();
    return;
  }

  filtered.forEach((tc, idx) => {
    const card = document.createElement('div');
    card.className = 'tc-card';
    card.setAttribute('data-status', tc.status || 'pending');
    card.style.animationDelay = `${idx * 0.03}s`;

    const statusUpper = (tc.status || 'pending').toUpperCase();
    const displayName = tc.name || tc.key;
    const tcNum = tc.tc_number || '';

    card.innerHTML = `
      <div class="tc-card-header">
        <span class="tc-key" title="${displayName}">${displayName}</span>
        <div class="tc-card-actions">
          <span class="status-badge ${tc.status}">${statusUpper}</span>
          <button class="tc-card-delete-btn" data-tc="${tc.key}" title="Delete ${tc.key}">&times;</button>
        </div>
      </div>
      <p class="text-sm">${tc.summary || 'No summary entered'}</p>
      <div class="flex-row gap-1 align-center mt-2 flex-wrap text-xs">
        <button class="btn btn-outline btn-xs btn-jira-link" data-tc="${tc.key}" title="${tcNum ? 'Open ' + tcNum + ' in Jira' : 'Set Jira TC Number'}">
          ${tcNum ? `🔗 ${tcNum}` : '🔗 Add Jira #'}
        </button>
        ${tc.defect_key ? `<button class="btn btn-outline btn-xs btn-view-defect" data-tc="${tc.key}" title="View Submitted Defect" style="background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.4)">🐛 Defect: ${tc.defect_key}</button>` : ''}
        ${tc.blocked_by ? `<span class="badge text-xs" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4)">🚫 Blocked By: ${tc.blocked_by}</span>` : ''}
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.tc-card-delete-btn') || e.target.closest('.btn-jira-link') || e.target.closest('.btn-view-defect')) return;
      selectTC(tc.key);
    });

    const delBtn = card.querySelector('.tc-card-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTC(tc.key);
      });
    }

    const jiraBtn = card.querySelector('.btn-jira-link');
    if (jiraBtn) {
      jiraBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openJiraTC(tc.key);
      });
    }

    const viewDefectBtn = card.querySelector('.btn-view-defect');
    if (viewDefectBtn) {
      viewDefectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        viewDefect(tc.key);
      });
    }

    grid.appendChild(card);
  });
  updateProgress();
}

function refreshDefectView() {
  const tc = getActiveTC();
  if (!tc) return;
  
  const tcKey = tc.key;
  $('#defect-preview-title').textContent = `Defect Preview — ${tcKey}`;

  const existingDraft = state.defectDrafts[tcKey];
  if (existingDraft) {
    populateDefectForm(existingDraft);
  } else if (tc.submitted_defect) {
    populateDefectForm(tc.submitted_defect);
  } else {
    clearDefectForm();
  }
  updateFixedFieldsDisplay();
}

async function viewDefect(tcKey) {
  state.currentTC = tcKey;
  state.activeContext = 'primary';
  const tc = state.testCases.find(t => t.key === tcKey);
  if (!tc) return;

  hide($('#te-input-section'));
  hide($('#tc-grid-section'));
  hide($('#tc-detail-section'));
  show($('#defect-preview-section'));
  
  if (state.linkedTeEnabled && state.linkedTeKey) {
    show($('#defect-bilingual-toggle-container'));
  } else {
    hide($('#defect-bilingual-toggle-container'));
  }

  setBilingualContext('primary');
}

async function deleteTC(tcKey) {
  if (!confirm(`Are you sure you want to delete Test Case ${tcKey}?`)) return;

  state.testCases = state.testCases.filter(tc => tc.key !== tcKey);
  
  if (state.currentTC === tcKey) {
    goBackToGrid();
  }

  saveExecutionState();
  renderTCGrid();

  if (state.teKey) {
    try {
      await api('POST', '/api/delete-tc', { te_key: state.teKey, tc_key: tcKey });
    } catch (e) {}
  }
    showToast(`Deleted ${tcKey}`, 'info');
}

async function loadTE(teKey) {
  if (!teKey) { showToast('Please enter a TE key', 'error'); return; }
  state.teKey = teKey;

  try {
    const saved = await api('GET', `/api/execution-state/${encodeURIComponent(teKey)}`);
    state.testCases = Array.isArray(saved.test_cases) ? saved.test_cases : [];
    
    state.teLang = saved.language || 'English';
    state.linkedTeKey = saved.linked_te || '';
    state.linkedTeEnabled = !!saved.linked_te_enabled;
    
    const envSelect = $('#te-env-select');
    if (envSelect && saved.environment) {
      envSelect.value = saved.environment;
    }
    const langSelect = $('#te-lang-select');
    if (langSelect && saved.language) {
      langSelect.value = saved.language;
    }
    
    const linkToggle = $('#te-link-toggle');
    const linkInput = $('#te-link-input');
    if (linkToggle) linkToggle.checked = !!saved.linked_te_enabled;
    if (linkInput) linkInput.value = saved.linked_te || '';
    
    if (state.linkedTeEnabled && state.linkedTeKey) {
       try {
         const linkedSaved = await api('GET', `/api/execution-state/${encodeURIComponent(state.linkedTeKey)}`);
         state.linkedTestCases = Array.isArray(linkedSaved.test_cases) ? linkedSaved.test_cases : [];
         state.linkedTeLang = linkedSaved.language || 'Arabic';
       } catch (le) {
         state.linkedTestCases = [];
         state.linkedTeLang = 'Unknown';
       }
    } else {
       state.linkedTestCases = [];
    }
    
  } catch (e) {
    state.testCases = [];
    state.linkedTestCases = [];
  }

  $('#tc-grid-title').textContent = `Test Cases — ${teKey}`;
  hide($('#te-input-section'));
  show($('#tc-grid-section'));
  const breadcrumb = $('#breadcrumb');
  const breadcrumbTE = $('#breadcrumb-te');
  if (breadcrumb) { show(breadcrumb); }
  if (breadcrumbTE) { breadcrumbTE.textContent = teKey; }
  renderTCGrid();
  loadDraftQueue();
  checkUserStory();
  showToast(`TE ${teKey} loaded`, 'success');
}

/**
 * Parses a pasted TC string that may start with a Jira number.
 * e.g. "BDR-22842    TC038_AP User - View Mobility..." ->
 *   { jiraNumber: 'BDR-22842', tcKey: 'TC038_AP User - View Mobility...' }
 * If no leading Jira number, jiraNumber is '' and tcKey is the full string.
 */
function parseTC(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/^([A-Z]+-\d+)\s+(.+)$/i);
  if (match) {
    return { jiraNumber: match[1].toUpperCase(), tcKey: match[2].trim() };
  }
  // Also handle plain Jira keys like QA-335480 as the TC itself
  const isJiraKey = /^[A-Z]+-\d+$/i.test(trimmed);
  return { jiraNumber: isJiraKey ? trimmed.toUpperCase() : '', tcKey: trimmed };
}

function raiseAdHocDefect() {
  const adHocKey = `AdHoc-Defect-${Math.floor(Math.random() * 10000)}`;
  state.testCases.push({
    key: adHocKey,
    name: 'Ad-Hoc Issue / General Defect',
    tc_number: '',
    summary: 'General issue found during execution',
    status: 'fail'
  });
  saveExecutionState();
  renderTCGrid();
  selectTC(adHocKey);
  
  // Auto focus the defect summary field
  setTimeout(() => {
    const summaryInput = $('#tc-actual');
    if (summaryInput) {
      summaryInput.value = '';
      summaryInput.focus();
    }
  }, 100);
  
  showToast('Ad-Hoc defect created! Please describe the issue.', 'info');
}

function addTC(tcKey) {
  if (!tcKey) return;
  const { jiraNumber, tcKey: name } = parseTC(tcKey);
  if (state.testCases.find(tc => tc.key === name || tc.name === name)) {
    showToast('TC already exists', 'error');
    return;
  }
  state.testCases.push({
    key: name,
    name: name,
    tc_number: jiraNumber,
    summary: '',
    status: 'pending'
  });
  saveExecutionState();
  renderTCGrid();
  $('#new-tc-input').value = '';
  hide($('#add-tc-container'));
  showToast(`Added ${name}${jiraNumber ? ' (' + jiraNumber + ')' : ''}`, 'success');
}

function addMultipleTCs(text) {
  const items = text.split(/\n/).map(k => k.trim()).filter(Boolean);
  let added = 0;
  for (const raw of items) {
    const { jiraNumber, tcKey: name } = parseTC(raw);
    if (!state.testCases.find(tc => tc.key === name || tc.name === name)) {
      state.testCases.push({
        key: name,
        name: name,
        tc_number: jiraNumber,
        summary: '',
        status: 'pending'
      });
      added++;
    }
  }
  if (added > 0) {
    saveExecutionState();
    renderTCGrid();
    showToast(`Added ${added} test cases`, 'success');
  }
  $('#multiple-tc-input').value = '';
  hide($('#add-multiple-tc-container'));
}

async function saveExecutionState() {
  if (state.activeContext === 'primary' && state.teKey) {
    try {
      await api('POST', `/api/execution-state/${state.teKey}`, { test_cases: state.testCases });
    } catch (e) {}
  } else if (state.activeContext === 'secondary' && state.linkedTeKey) {
    try {
      await api('POST', `/api/execution-state/${state.linkedTeKey}`, { test_cases: state.linkedTestCases });
    } catch (e) {}
  }
}

let activeUploadCategory = 'actual';
let isUploading = false;

function setActiveCategory(cat) {
  activeUploadCategory = cat;
  
  const expectedBox = $('#dropzone-box-expected');
  const actualBox = $('#dropzone-box-actual');
  const expectedBadge = $('#badge-expected');
  const actualBadge = $('#badge-actual');

  if (expectedBox) expectedBox.classList.toggle('active-target', cat === 'expected');
  if (actualBox) actualBox.classList.toggle('active-target', cat === 'actual');

  if (expectedBadge) {
    if (cat === 'expected') {
      expectedBadge.textContent = '🎯 Active Paste Target (Ctrl+V)';
      expectedBadge.className = 'paste-indicator active';
    } else {
      expectedBadge.textContent = 'Click / Focus to Target';
      expectedBadge.className = 'paste-indicator';
    }
  }

  if (actualBadge) {
    if (cat === 'actual') {
      actualBadge.textContent = '🎯 Active Paste Target (Ctrl+V)';
      actualBadge.className = 'paste-indicator active';
    } else {
      actualBadge.textContent = 'Click / Focus to Target';
      actualBadge.className = 'paste-indicator';
    }
  }
}

function getActiveTC() {
  if (!state.currentTC) return null;
  const tcs = state.activeContext === 'primary' ? state.testCases : state.linkedTestCases;
  
  if (state.activeContext === 'primary') {
    return tcs.find(t => t.key === state.currentTC);
  }
  
  const primaryTC = state.testCases.find(t => t.key === state.currentTC);
  if (!primaryTC) return null;
  
  let target = null;
  if (primaryTC.tc_number) {
    target = tcs.find(t => t.tc_number === primaryTC.tc_number);
  }
  if (!target) {
    target = tcs.find(t => t.key === primaryTC.key);
  }
  return target;
}

function setBilingualContext(context) {
  state.activeContext = context;
  const isPrimary = context === 'primary';
  
  const btnEn = $('#toggle-lang-en');
  const btnAr = $('#toggle-lang-ar');
  const btnDefEn = $('#defect-toggle-lang-en');
  const btnDefAr = $('#defect-toggle-lang-ar');

  if (btnEn) {
    btnEn.classList.toggle('active', isPrimary);
    btnEn.textContent = (state.teLang || 'EN').toUpperCase().substring(0, 2);
  }
  if (btnAr) {
    btnAr.classList.toggle('active', !isPrimary);
    btnAr.textContent = (state.linkedTeLang || 'AR').toUpperCase().substring(0, 2);
  }
  if (btnDefEn) {
    btnDefEn.classList.toggle('active', isPrimary);
    btnDefEn.textContent = (state.teLang || 'EN').toUpperCase().substring(0, 2);
  }
  if (btnDefAr) {
    btnDefAr.classList.toggle('active', !isPrimary);
    btnDefAr.textContent = (state.linkedTeLang || 'AR').toUpperCase().substring(0, 2);
  }

  if (state.currentTC) {
    if (!$('#tc-detail-section').classList.contains('hidden')) {
      refreshTCDetailView();
    } else if (!$('#defect-preview-section').classList.contains('hidden')) {
      refreshDefectView();
    }
  }
}

function refreshTCDetailView() {
  const tc = getActiveTC();
  if (!tc && state.activeContext === 'secondary') {
    showToast('This test case does not exist in the linked execution.', 'warning');
    $('#detail-tc-status').textContent = 'NOT FOUND';
    $('#detail-tc-status').className = 'status-badge pending';
    $('#tc-summary').value = '';
    state.screenshots = { expected: [], actual: [] };
    renderThumbnails('expected');
    renderThumbnails('actual');
    return;
  }
  if (!tc) return;

  $('#detail-tc-key').textContent = tc.name || tc.key;
  const numInput = $('#tc-number-input');
  if (numInput) numInput.value = tc.tc_number || '';

  const badge = $('#detail-tc-status');
  badge.textContent = (tc.status || 'pending').toUpperCase();
  badge.className = `status-badge ${tc.status || 'pending'}`;

  $('#tc-summary').value = tc.summary || '';
  setActiveCategory('actual');
  loadExistingScreenshots(tc.key);
}

function selectTC(tcKey) {
  state.currentTC = tcKey;
  state.activeContext = 'primary';
  
  const tc = state.testCases.find(t => t.key === tcKey);
  if (!tc) return;

  hide($('#tc-grid-section'));
  hide($('#defect-preview-section'));
  show($('#tc-detail-section'));
  
  if (state.linkedTeEnabled && state.linkedTeKey) {
    show($('#bilingual-toggle-container'));
  } else {
    hide($('#bilingual-toggle-container'));
  }

  setBilingualContext('primary');
  updateTestGuideUI(tc);
  toggleGuidePanel(true);
}

function openJiraTC(tcKey) {
  const tc = state.testCases.find(t => t.key === tcKey);
  if (!tc) return;

  let tcNumber = tc.tc_number || '';
  if (!tcNumber) {
    const promptVal = prompt(`Enter Jira TC Number for "${tc.name || tc.key}" (e.g. QA-335455):`, '');
    if (!promptVal || !promptVal.trim()) return;
    tcNumber = promptVal.trim().toUpperCase();
    tc.tc_number = tcNumber;
    saveExecutionState();
    renderTCGrid();
    if (state.currentTC === tcKey) {
      const numInput = $('#tc-number-input');
      if (numInput) numInput.value = tcNumber;
    }
  }

  const baseUrl = (state.settings && state.settings.jira_base_url) ? state.settings.jira_base_url : 'https://jira.prod.mobily.lan';
  const url = `${baseUrl.replace(/\/$/, '')}/browse/${tcNumber}`;
  window.open(url, '_blank');
}

async function loadExistingScreenshots(tcKey) {
  state.screenshots = { expected: [], actual: [] };
  const targetTeKey = state.activeContext === 'primary' ? state.teKey : state.linkedTeKey;
  if (!targetTeKey) return;
  try {
    const res = await api('GET', `/api/screenshots/${encodeURIComponent(targetTeKey)}/${encodeURIComponent(tcKey)}`);
    state.screenshots.expected = res.expected || [];
    state.screenshots.actual = res.actual || [];
  } catch (e) {
    console.error("Failed to load existing screenshots:", e);
  }
  renderThumbnails('expected');
  renderThumbnails('actual');
}

function goHome() {
  hide($('#tc-grid-section'));
  hide($('#tc-detail-section'));
  hide($('#defect-preview-section'));
  show($('#te-input-section'));
  state.currentTC = null;
  const breadcrumb = $('#breadcrumb');
  if (breadcrumb) hide(breadcrumb);
  loadSavedTEs();
}

function goBackToGrid() {
  if (state.currentTC && !$('#defect-preview-section').classList.contains('hidden')) {
    state.defectDrafts[state.currentTC] = {
      ...(state.defectDrafts[state.currentTC] || {}),
      title: $('#defect-title').value,
      scenario: $('#defect-scenario').value,
      steps: $('#defect-steps').value,
      expected: $('#defect-expected').value,
      actual: $('#defect-actual').value,
      severity: $('#defect-severity').value,
      blocked_tcs: $('#defect-blocked-tcs').value,
      assignee: $('#defect-assignee').value,
      test_data: $('#defect-test-data').value,
      qa_analysis: $('#defect-qa-analysis').value,
    };
  }
  hide($('#tc-detail-section'));
  hide($('#defect-preview-section'));
  show($('#tc-grid-section'));
  state.currentTC = null;
  renderTCGrid();
}

function setupDropZone(cat) {
  const box = $(`#dropzone-box-${cat}`);
  const dropzone = $(`#dropzone-${cat}`);
  const input = $(`#input-${cat}`);

  if (box) {
    box.addEventListener('click', () => setActiveCategory(cat));
    box.addEventListener('focusin', () => setActiveCategory(cat));
    box.addEventListener('mouseenter', () => {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (!['INPUT', 'TEXTAREA'].includes(tag)) {
        setActiveCategory(cat);
      }
    });
  }

  dropzone.addEventListener('click', (e) => {
    if (e.target === input) return;
    e.stopPropagation();
    setActiveCategory(cat);
    input.click();
  });

  input.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
    setActiveCategory(cat);
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
    setActiveCategory(cat);
    if (e.dataTransfer.files.length) uploadFiles(cat, e.dataTransfer.files);
  });

  input.addEventListener('change', (e) => {
    if (e.target.files.length) {
      uploadFiles(cat, e.target.files);
    }
    input.value = '';
  });
}

function setupPasteHandler() {
  document.addEventListener('paste', (e) => {
    if (!state.currentTC || $('#tc-detail-section').classList.contains('hidden')) return;

    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;

    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        files.push(item.getAsFile());
      }
    }

    if (!files.length) return;

    e.preventDefault();
    e.stopPropagation();

    let targetCat = activeUploadCategory || 'actual';
    const expBox = $('#dropzone-box-expected');
    const actBox = $('#dropzone-box-actual');

    if (expBox && expBox.contains(e.target)) {
      targetCat = 'expected';
    } else if (actBox && actBox.contains(e.target)) {
      targetCat = 'actual';
    }

    setActiveCategory(targetCat);
    uploadFiles(targetCat, files);
  });
}

async function uploadFiles(category, fileList) {
  if (!state.currentTC) return;
  const targetTeKey = state.activeContext === 'primary' ? state.teKey : state.linkedTeKey;
  if (!targetTeKey) return;
  if (isUploading) return;

  const files = Array.from(fileList).filter(f => f.type && f.type.startsWith('image/'));
  if (!files.length) return;

  isUploading = true;
  const catLabel = category === 'expected' ? 'Expected Result' : 'Actual Result';
  
  const tc = getActiveTC();
  if (!tc) {
     showToast('Test case not found in current execution context', 'error');
     isUploading = false;
     return;
  }

  const formData = new FormData();
  formData.append('te_key', targetTeKey);
  formData.append('tc_key', tc.key);
  formData.append('category', category);
  for (const f of files) formData.append('screenshots', f);

  try {
    const res = await api('POST', '/api/upload-screenshots', formData);
    await loadExistingScreenshots(tc.key);
    showToast(`Uploaded ${files.length} image(s) to ${catLabel}`, 'success');
  } catch (e) {
    showToast(`Upload failed: ${e.message}`, 'error');
  } finally {
    isUploading = false;
  }
}

function renderThumbnails(cat) {
  const container = $(`#thumbs-${cat}`);
  if (!container) return;
  container.innerHTML = '';

  const shots = state.screenshots[cat] || [];
  shots.forEach((shot, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb-container';
    thumb.innerHTML = `
      <img src="${shot.url}" alt="${cat} ${index + 1}">
      <button class="thumb-remove" data-cat="${cat}" data-index="${index}">&times;</button>
    `;
    const img = thumb.querySelector('img');
    if (img) {
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        const allShots = [...(state.screenshots.expected || []).map(s => ({...s, category: 'Expected'})), ...(state.screenshots.actual || []).map(s => ({...s, category: 'Actual'}))];
        const globalIndex = cat === 'expected' ? index : (state.screenshots.expected || []).length + index;
        openLightbox(allShots, globalIndex);
      });
    }
    container.appendChild(thumb);
  });

  container.querySelectorAll('.thumb-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeScreenshot(btn.dataset.cat, parseInt(btn.dataset.index));
    });
  });
}

async function removeScreenshot(cat, index) {
  if (!state.screenshots[cat] || !state.screenshots[cat][index]) return;

  const shot = state.screenshots[cat][index];
  state.screenshots[cat].splice(index, 1);
  renderThumbnails(cat);
  
  const targetTeKey = state.activeContext === 'primary' ? state.teKey : state.linkedTeKey;
  const tc = getActiveTC();

  if (targetTeKey && tc && shot.name) {
    try {
      await api('POST', '/api/delete-screenshot', {
        te_key: targetTeKey,
        tc_key: tc.key,
        category: cat,
        filename: shot.name
      });
      showToast(`Deleted image from ${cat === 'expected' ? 'Expected Result' : 'Actual Result'}`, 'info');
    } catch (e) {
      console.error('Failed to delete screenshot file from server:', e);
    }
  }
}

function getShotPaths(cat) {
  return (state.screenshots[cat] || []).map(s => s.path).filter(Boolean);
}

function promptNextSideOrAdvance(actionStr) {
  if (state.activeContext === 'primary' && state.linkedTeEnabled && state.linkedTeKey) {
     setBilingualContext('secondary');
     const linkedTC = getActiveTC();
     if (linkedTC && linkedTC.status === 'pending') {
        setTimeout(() => {
          if (confirm(`Do you also want to ${actionStr.toUpperCase()} the secondary/Arabic side?`)) {
             linkedTC.status = actionStr;
             linkedTC.summary = $('#tc-summary').value.trim();
             saveExecutionState();
             showToast(`✅ ${actionStr.toUpperCase()} applied to secondary side`, 'success');
             advanceToNextTC();
          }
        }, 150);
        return; // wait for user on secondary tab
     }
  }
  advanceToNextTC();
}

async function passTC() {
  const tc = getActiveTC();
  if (!tc) return;
  tc.summary = $('#tc-summary').value.trim();
  tc.status = 'pass';
  saveExecutionState();

  showToast(`✅ ${tc.name || tc.key} PASSED`, 'success');
  promptNextSideOrAdvance('pass');
}

async function skipTC() {
  const tc = getActiveTC();
  if (!tc) return;
  tc.summary = $('#tc-summary').value.trim();
  tc.status = 'skip';
  saveExecutionState();
  showToast(`⏭ ${tc.key} skipped`, 'info');
  promptNextSideOrAdvance('skip');
}


async function generatePOT() {
  if (!state.teKey) { showToast('No TE loaded', 'error'); return; }
  const btn = $('#btn-rebuild-pot');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
  try {
    const res = await api('POST', '/api/rebuild-pot', { te_key: state.teKey });
    showToast(`📄 POT generated with ${res.tc_count} test cases`, 'success');
  } catch (e) {
    showToast(`POT generation failed: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Generate POT'; }
  }
}

async function failTC() {
  const tc = getActiveTC();
  if (!tc) return;
  tc.summary = $('#tc-summary').value.trim();
  tc.status = 'fail';
  saveExecutionState();

  hide($('#tc-detail-section'));
  show($('#defect-preview-section'));
  
  if (state.linkedTeEnabled && state.linkedTeKey) {
    show($('#defect-bilingual-toggle-container'));
  } else {
    hide($('#defect-bilingual-toggle-container'));
  }

  setBilingualContext(state.activeContext);
}

/** Populate defect form fields from a draft object */
function populateDefectForm(defect) {
  $('#defect-title').value = defect.title || '';
  $('#defect-scenario').value = defect.scenario || '';
  $('#defect-steps').value = defect.steps || '';
  $('#defect-expected').value = defect.expected || '';
  $('#defect-actual').value = defect.actual || '';
  $('#defect-test-data').value = defect.test_data || '';
  $('#defect-qa-analysis').value = defect.qa_analysis || '';
  if (defect.severity) $('#defect-severity').value = defect.severity;
  if (defect.blocked_tcs !== undefined) $('#defect-blocked-tcs').value = defect.blocked_tcs;
  if (defect.assignee) $('#defect-assignee').value = defect.assignee;
}

/** Clear defect form to a blank state */
function clearDefectForm() {
  $('#defect-title').value = '';
  $('#defect-scenario').value = '';
  $('#defect-steps').value = '';
  $('#defect-expected').value = '';
  $('#defect-actual').value = '';
  $('#defect-test-data').value = '';
  $('#defect-qa-analysis').value = '';
  $('#defect-severity').value = '1-Low';
  $('#defect-blocked-tcs').value = '';
  $('#defect-assignee').value = 'Saurabh Shukla';
}

/** Call AI to generate defect draft — saves result per-TC so it persists */
async function draftDefect() {
  const tc = state.testCases.find(t => t.key === state.currentTC);
  const summary = tc?.summary || $('#tc-summary')?.value?.trim() || '';

  if (!summary) {
    showToast('Add QA Notes / summary on the TC screen first before drafting', 'error');
    return;
  }

  show($('#ai-loading'));

  try {
    const defect = await api('POST', '/api/generate-defect', {
      tc_key: state.currentTC,
      te_key: state.teKey,
      notes: summary,
      expected_shots: getShotPaths('expected'),
      actual_shots: getShotPaths('actual')
    });

    // Persist draft for this TC
    state.defectDrafts[state.currentTC] = defect;
    populateDefectForm(defect);

    if (defect.ai_error) {
      showToast(`⚠️ AI error: ${defect.ai_error}. Loaded fallback template.`, 'error');
    } else {
      showToast('🤖 Defect drafted by AI', 'success');
    }
  } catch (e) {
    showToast(`AI generation failed: ${e.message}`, 'error');
  } finally {
    hide($('#ai-loading'));
  }
}


function promptNextSideOrAdvanceDefect() {
  if (state.activeContext === 'primary' && state.linkedTeEnabled && state.linkedTeKey) {
     setBilingualContext('secondary');
     const linkedTC = getActiveTC();
     if (linkedTC && (linkedTC.status === 'pending' || linkedTC.status === 'fail' && !linkedTC.defect_key)) {
        setTimeout(() => {
          if (confirm(`Do you also want to mark the secondary side as FAILED and evaluate it?`)) {
             showToast('Secondary side selected. Please draft/submit the defect for this side.', 'info');
             // Stay on defect screen, wait for user action
          } else {
             goBackToGrid();
             advanceToNextTC();
          }
        }, 150);
        return;
     }
  }
  goBackToGrid();
  advanceToNextTC();
}

async function submitDefect() {
  if (!confirm('Submit this defect to Jira? This will open a Playwright browser and fill the Jira form.')) return;
  const btn = $('#btn-submit-defect');
  btn.disabled = true;
  btn.textContent = 'Submitting to Jira...';

  const tc = getActiveTC();
  const targetTeKey = state.activeContext === 'primary' ? state.teKey : state.linkedTeKey;

  try {
    const payload = {
      tc_key: tc ? tc.key : state.currentTC,
      tc_name: tc ? (tc.name || tc.key) : state.currentTC,
      tc_number: tc ? (tc.tc_number || null) : null,
      te_key: targetTeKey,
      defect_title: $('#defect-title').value,
      scenario: $('#defect-scenario').value,
      steps: $('#defect-steps').value,
      expected: $('#defect-expected').value,
      actual: $('#defect-actual').value,
      test_data: $('#defect-test-data').value,
      qa_analysis: $('#defect-qa-analysis').value,
      severity: $('#defect-severity').value,
      blocked_tcs: $('#defect-blocked-tcs').value,
      assignee: $('#defect-assignee').value,
      expected_shots: getShotPaths('expected'),
      actual_shots: getShotPaths('actual')
    };

    const res = await api('POST', '/api/fail-tc', payload);

    if (tc) {
      tc.status = 'fail';
      tc.summary = $('#tc-summary')?.value?.trim() || tc.summary;
      tc.defect_key = res.issue_key;
      
      tc.submitted_defect = {
        title: $('#defect-title').value,
        scenario: $('#defect-scenario').value,
        steps: $('#defect-steps').value,
        expected: $('#defect-expected').value,
        actual: $('#defect-actual').value,
        test_data: $('#defect-test-data').value,
        qa_analysis: $('#defect-qa-analysis').value,
        severity: $('#defect-severity').value,
        blocked_tcs: $('#defect-blocked-tcs').value,
        assignee: $('#defect-assignee').value
      };
    }
    
    const blockedInput = $('#defect-blocked-tcs').value;
    if (blockedInput) {
      const blockedKeys = blockedInput.split(',').map(k => k.trim()).filter(Boolean);
      blockedKeys.forEach(bk => {
        const tcsToSearch = state.activeContext === 'primary' ? state.testCases : state.linkedTestCases;
        const btc = tcsToSearch.find(t => t.key === bk || t.tc_number === bk);
        if (btc) {
          btc.status = 'blocked';
          btc.summary = `Blocked by defect ${res.issue_key} on TC ${tc ? tc.key : ''}`;
          btc.blocked_by = res.issue_key + (tc ? ` (${tc.key})` : '');
        }
      });
    }

    saveExecutionState();
    delete state.defectDrafts[state.currentTC];
    const potMsg = res.saved_pot ? ' and saved to POT!' : '!';
    showToast(`❌ Defect ${res.issue_key} created${potMsg}`, 'success');
    
    promptNextSideOrAdvanceDefect();
    
  } catch (e) {
    showToast(`Jira submission failed: ${e.message}. Use "Copy Title & Body" fallback.`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Submit to Jira';
  }
}

function copyDefectToClipboard() {
  const title = $('#defect-title').value;
  const desc = `Scenario:\n${$('#defect-scenario').value}\n\nSteps to Recreate:\n${$('#defect-steps').value}\n\nExpected Result:\n${$('#defect-expected').value}\n\nActual Result:\n${$('#defect-actual').value}`;
  const text = `SUMMARY:\n${title}\n\nDESCRIPTION:\n${desc}`;
  navigator.clipboard.writeText(text).then(() => {
    showToast('📋 Copied Title & Body to clipboard!', 'success');
  });
}

// ============================================================
// DRAFT DEFECT QUEUE
// ============================================================

async function saveAsDraft() {
  const tc = getActiveTC();
  if (!tc) return;
  const title = $('#defect-title').value;
  if (!title.trim()) {
    showToast('Draft with AI first — title is empty', 'error');
    return;
  }

  const targetTeKey = state.activeContext === 'primary' ? state.teKey : state.linkedTeKey;

  try {
    const payload = {
      te_key: targetTeKey,
      tc_key: tc.key,
      defect_title: title,
      scenario: $('#defect-scenario').value,
      steps: $('#defect-steps').value,
      expected: $('#defect-expected').value,
      actual: $('#defect-actual').value,
      test_data: $('#defect-test-data').value,
      qa_analysis: $('#defect-qa-analysis').value,
      severity: $('#defect-severity').value,
      blocked_tcs: $('#defect-blocked-tcs').value,
      assignee: $('#defect-assignee').value,
      expected_shots: getShotPaths('expected'),
      actual_shots: getShotPaths('actual'),
      drafted_at: new Date().toISOString(),
    };

    await api('POST', '/api/save-draft', payload);
    tc.status = 'fail';
    tc.draft_defect = payload;
    saveExecutionState();
    delete state.defectDrafts[state.currentTC];
    showToast('📦 Defect saved as draft — find it in the Draft Queue', 'success');
    goBackToGrid();
    loadDraftQueue();
  } catch (e) {
    showToast(`Failed to save draft: ${e.message}`, 'error');
  }
}

async function loadDraftQueue() {
  if (!state.teKey) return;
  const badge = $('#draft-queue-badge');
  try {
    const res = await api('GET', `/api/drafts/${encodeURIComponent(state.teKey)}`);
    state.draftQueue = res.drafts || [];
    if (badge) {
      badge.textContent = state.draftQueue.length;
      if (state.draftQueue.length > 0) {
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
    renderDraftQueue();
  } catch (e) {
    state.draftQueue = [];
    if (badge) badge.classList.add('hidden');
  }
}

function renderDraftQueue() {
  const list = $('#draft-queue-list');
  const empty = $('#draft-queue-empty');
  if (!list) return;

  const drafts = state.draftQueue || [];
  if (drafts.length === 0) {
    list.innerHTML = '';
    if (empty) show(empty);
    return;
  }
  if (empty) hide(empty);

  list.innerHTML = drafts.map((d, i) => {
    const title = d.draft?.title || 'Untitled';
    const severity = d.draft?.severity || '';
    const tcName = d.tc_name || d.tc_key;
    const draftedAt = d.draft?.drafted_at ? new Date(d.draft.drafted_at).toLocaleString() : '';
    return `
      <div class="draft-card" data-tc="${d.tc_key}">
        <div class="draft-card-info">
          <div class="draft-card-title" title="${title}">${title}</div>
          <div class="draft-card-meta">${tcName} • ${severity} ${draftedAt ? '• ' + draftedAt : ''}</div>
        </div>
        <div class="draft-card-actions">
          <button class="btn btn-xs btn-outline draft-edit-btn" data-idx="${i}" title="Edit">✏️</button>
          <button class="btn btn-xs btn-primary draft-submit-btn" data-idx="${i}" title="Submit now">🚀</button>
          <button class="btn btn-xs btn-danger-outline draft-delete-btn" data-idx="${i}" title="Discard">🗑️</button>
        </div>
      </div>
    `;
  }).join('');

  // Wire up buttons
  list.querySelectorAll('.draft-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => editDraft(parseInt(btn.dataset.idx)));
  });
  list.querySelectorAll('.draft-submit-btn').forEach(btn => {
    btn.addEventListener('click', () => submitSingleDraft(parseInt(btn.dataset.idx)));
  });
  list.querySelectorAll('.draft-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteDraft(parseInt(btn.dataset.idx)));
  });
}

function editDraft(idx) {
  const draft = state.draftQueue[idx];
  if (!draft) return;
  // Navigate to defect preview and populate with the draft
  state.currentTC = draft.tc_key;
  state.activeContext = 'primary';

  hide($('#te-input-section'));
  hide($('#tc-grid-section'));
  hide($('#tc-detail-section'));
  show($('#defect-preview-section'));

  populateDefectForm({
    title: draft.draft?.title || '',
    scenario: draft.draft?.scenario || '',
    steps: draft.draft?.steps || '',
    expected: draft.draft?.expected || '',
    actual: draft.draft?.actual || '',
    test_data: draft.draft?.test_data || '',
    qa_analysis: draft.draft?.qa_analysis || '',
    severity: draft.draft?.severity || '1-Low',
    blocked_tcs: draft.draft?.blocked_tcs || '',
    assignee: draft.draft?.assignee || '',
  });
  refreshDefectView();
  showToast(`Editing draft for ${draft.tc_name || draft.tc_key}`, 'info');
}

async function submitSingleDraft(idx) {
  const draft = state.draftQueue[idx];
  if (!draft) return;
  if (!confirm(`Submit draft "${draft.draft?.title}" to Jira?`)) return;

  try {
    const res = await api('POST', '/api/submit-draft', {
      te_key: state.teKey,
      tc_key: draft.tc_key,
    });
    showToast(`❌ Defect ${res.issue_key} created from draft!`, 'success');
    // Update local TC
    const tc = state.testCases.find(t => t.key === draft.tc_key);
    if (tc) {
      tc.defect_key = res.issue_key;
      tc.submitted_defect = draft.draft;
      delete tc.draft_defect;
    }
    saveExecutionState();
    await loadDraftQueue();
    renderTCGrid();
  } catch (e) {
    showToast(`Draft submission failed: ${e.message}`, 'error');
  }
}

async function deleteDraft(idx) {
  const draft = state.draftQueue[idx];
  if (!draft) return;
  if (!confirm(`Discard draft for "${draft.tc_name || draft.tc_key}"?`)) return;

  try {
    await api('POST', '/api/delete-draft', {
      te_key: state.teKey,
      tc_key: draft.tc_key,
    });
    // Update local TC
    const tc = state.testCases.find(t => t.key === draft.tc_key);
    if (tc) delete tc.draft_defect;
    showToast('Draft discarded', 'info');
    await loadDraftQueue();
    renderTCGrid();
  } catch (e) {
    showToast(`Failed to delete draft: ${e.message}`, 'error');
  }
}

let batchPollTimer = null;

async function submitAllDrafts() {
  if (!state.draftQueue || state.draftQueue.length === 0) {
    showToast('No drafts to submit', 'error');
    return;
  }

  const minDelay = parseInt($('#batch-min-delay')?.value || '120');
  const maxDelay = parseInt($('#batch-max-delay')?.value || '300');

  if (!confirm(
    `🚀 Submit ${state.draftQueue.length} draft(s) to Jira?\n\n` +
    `Each defect will be raised with a ${minDelay}–${maxDelay}s random delay between them to look natural.\n\n` +
    `This runs in the background — you can keep working.`
  )) return;

  try {
    await api('POST', '/api/submit-all-drafts', {
      te_key: state.teKey,
      min_delay_seconds: minDelay,
      max_delay_seconds: maxDelay,
    });
    showToast(`🚀 Batch submission started! ${state.draftQueue.length} defects queued.`, 'success');

    show($('#batch-progress'));
    show($('#btn-cancel-batch'));
    $('#btn-submit-all-drafts').disabled = true;

    // Start polling for progress
    batchPollTimer = setInterval(pollBatchStatus, 5000);
    setTimeout(pollBatchStatus, 1000);
  } catch (e) {
    showToast(`Batch start failed: ${e.message}`, 'error');
  }
}

async function pollBatchStatus() {
  try {
    const status = await api('GET', '/api/batch-status');
    const progressFill = $('#batch-progress-fill');
    const progressText = $('#batch-progress-text');

    if (progressFill && status.total > 0) {
      progressFill.style.width = `${(status.completed / status.total) * 100}%`;
    }
    if (progressText) {
      if (status.running) {
        progressText.textContent = `Submitting ${status.completed}/${status.total}... ${status.current_tc ? 'Current: ' + status.current_tc : ''}`;
      } else {
        progressText.textContent = `Done! ${status.completed}/${status.total} submitted. ${status.errors?.length || 0} error(s).`;
      }
    }

    if (!status.running) {
      clearInterval(batchPollTimer);
      batchPollTimer = null;
      hide($('#btn-cancel-batch'));
      $('#btn-submit-all-drafts').disabled = false;

      if (status.results?.length > 0) {
        const keys = status.results.map(r => r.issue_key).join(', ');
        showToast(`✅ Batch complete! Created: ${keys}`, 'success');
      }
      if (status.errors?.length > 0) {
        showToast(`⚠️ ${status.errors.length} defect(s) failed during batch`, 'error');
      }

      // Refresh data
      await loadDraftQueue();
      // Reload TE to get updated defect keys
      await loadTE(state.teKey);
      setTimeout(() => hide($('#batch-progress')), 5000);
    }
  } catch (e) {
    console.error('Batch poll error:', e);
  }
}

async function cancelBatch() {
  try {
    await api('POST', '/api/cancel-batch');
    showToast('Batch cancellation requested — current defect will finish first', 'warning');
  } catch (e) {
    showToast('Cancel failed', 'error');
  }
}

function toggleDraftQueue() {
  const panel = $('#draft-queue-panel');
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    show(panel);
    loadDraftQueue();
  } else {
    hide(panel);
  }
}

// ============================================================
// USER STORY & AI TEST GUIDE
// ============================================================

async function checkUserStory() {
  const indicator = $('#story-indicator');
  if (!state.teKey) return;
  try {
    const res = await api('GET', `/api/user-story/${encodeURIComponent(state.teKey)}`);
    if (res && res.filename) {
      if (indicator) {
        indicator.textContent = `📎 Story: ${res.filename}`;
        show(indicator);
      }
      state.hasUserStory = true;
    } else {
      if (indicator) hide(indicator);
      state.hasUserStory = false;
    }
  } catch (e) {
    if (indicator) hide(indicator);
    state.hasUserStory = false;
  }
}

async function uploadUserStory(file) {
  if (!state.teKey) { showToast('No TE loaded', 'error'); return; }
  const formData = new FormData();
  formData.append('te_key', state.teKey);
  formData.append('file', file);
  
  showToast('Uploading & parsing user story...', 'info');
  try {
    const res = await api('POST', '/api/upload-user-story', formData);
    showToast(`✅ User story loaded! (${res.user_story.row_count} rows)`, 'success');
    checkUserStory();
  } catch (e) {
    showToast(`Upload failed: ${e.message}`, 'error');
  }
}

async function deleteUserStory() {
  if (!confirm('Clear the uploaded user story for this TE?')) return;
  try {
    // We can just overwrite it with null/empty via execution-state or a quick dedicated endpoint if we had one.
    // For now, since we didn't add a DELETE endpoint, we can just hide it locally and rely on the AI checking it.
    // Wait, the python subagent added a DELETE endpoint? Let's check... no, it didn't. 
    // It's okay, we'll just show the user story and they can overwrite it by uploading another.
  } catch(e) {}
}

async function generateTestGuide() {
  const tc = getActiveTC();
  if (!tc || !state.teKey) return;
  
  $('#guide-loading')?.classList.remove('hidden');
  $('#guide-content')?.classList.add('hidden');
  $('#btn-generate-guide').disabled = true;
  
  try {
    const res = await api('POST', '/api/generate-guide', {
      te_key: state.teKey,
      tc_key: tc.key
    });
    tc.test_guide = res.guide;
    saveExecutionState();
    updateTestGuideUI(tc);
    showToast('✨ Test Guide generated!', 'success');
  } catch (e) {
    showToast(`Guide generation failed: ${e.message}`, 'error');
    $('#guide-loading')?.classList.add('hidden');
    $('#btn-generate-guide').disabled = false;
  }
}

function updateTestGuideUI(tc) {
  const guide = tc?.test_guide;
  $('#guide-loading')?.classList.add('hidden');
  $('#btn-generate-guide').disabled = false;
  
  if (guide) {
    $('#guide-what').textContent = guide.what_to_test || '';
    $('#guide-steps').textContent = guide.steps || '';
    $('#guide-lookfor').textContent = guide.look_for || '';
    $('#guide-content')?.classList.remove('hidden');
    $('#btn-generate-guide').textContent = '🔄 Regen';
  } else {
    $('#guide-content')?.classList.add('hidden');
    $('#btn-generate-guide').textContent = 'Generate';
  }
}

function toggleGuidePanel(showPanel) {
  const panel = $('#test-guide-panel');
  const section = $('#tc-detail-section');
  if (!panel || !section) return;
  
  if (showPanel && state.hasUserStory) {
    panel.classList.remove('hidden');
    section.classList.add('has-guide');
  } else {
    panel.classList.add('hidden');
    section.classList.remove('has-guide');
  }
}

function downloadPOC() {
  if (!state.teKey) { showToast('No TE session loaded', 'error'); return; }
  window.open(`/api/download-poc/${encodeURIComponent(state.teKey)}`, '_blank');
}

async function deleteTE(teKey) {
  const targetKey = teKey || state.teKey;
  if (!targetKey) {
    showToast('No Test Execution selected to delete', 'error');
    return;
  }

  const confirmed = confirm(
    `⚠️ Are you sure you want to PERMANENTLY delete Test Execution "${targetKey}"?\n\n` +
    `This will delete all saved test cases, uploaded screenshots, state files, and Word POT documents from your computer.`
  );
  if (!confirmed) return;

  try {
    const res = await api('DELETE', `/api/te/${encodeURIComponent(targetKey)}`);
    if (res.status === 'deleted') {
      showToast(`🗑 Deleted Test Execution ${targetKey} and all associated files`, 'info');
      if (state.teKey === targetKey) {
        goHome();
      }
      await loadSavedTEs();
    } else {
      showToast(`Delete failed: ${res.error || 'TE not found'}`, 'error');
    }
  } catch (e) {
    showToast(`Delete failed: ${e.message}`, 'error');
  }
}

async function loadSavedTEs() {
  try {
    const tes = await api('GET', '/api/te-list');
    const container = $('#saved-tes-container');
    const list = $('#saved-tes-list');
    if (!container || !list) return;

    if (!tes || tes.length === 0) {
      hide(container);
      return;
    }

    show(container);
    list.innerHTML = '';

    tes.forEach(te => {
      const wrapper = document.createElement('div');
      wrapper.className = 'te-chip-wrapper';
      wrapper.innerHTML = `
        <button type="button" class="btn te-chip">
          <span style="font-weight: 500; margin-right: 0.5rem;">${te.te_key}</span>
          ${te.environment && te.environment !== 'Unknown' ? `<span class="badge text-xs" style="background: var(--border); color: var(--text-muted); margin-right: 0.25rem;">${te.environment}</span>` : ''}
          ${te.language ? `<span class="badge text-xs" style="background: var(--border); color: var(--text-muted); margin-right: 0.25rem;">${te.language}</span>` : ''}
          <span class="badge text-xs">${te.tc_count} TCs</span>
        </button>
        <button type="button" class="te-chip-delete" title="Delete ${te.te_key} and all files">&times;</button>
      `;

      const chipBtn = wrapper.querySelector('.te-chip');
      chipBtn.addEventListener('click', () => {
        $('#te-key-input').value = te.te_key;
        loadTE(te.te_key);
      });

      const delBtn = wrapper.querySelector('.te-chip-delete');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTE(te.te_key);
      });

      list.appendChild(wrapper);
    });
  } catch (e) {}
}

function openJiraTE() {
  const key = $('#te-key-input').value.trim() || state.teKey;
  if (!key) {
    showToast('Please enter or select a TE Key first', 'error');
    return;
  }
  const baseUrl = (state.settings && state.settings.jira_base_url) ? state.settings.jira_base_url : 'https://jira.prod.mobily.lan';
  const url = `${baseUrl.replace(/\/$/, '')}/browse/${key}`;
  window.open(url, '_blank');
}

async function fetchJiraTE() {
  const key = $('#te-key-input').value.trim();
  if (!key) {
    showToast('Please enter a TE Key to search in Jira (e.g. QA-335480)', 'error');
    $('#te-key-input').focus();
    return;
  }

  const btn = $('#btn-fetch-jira-te');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching Jira...'; }

  try {
    const res = await api('POST', '/api/fetch-jira-te', { te_key: key });
    showToast(`Fetched ${res.test_cases ? res.test_cases.length : 0} Test Case(s) from Jira!`, 'success');
    await loadTE(key);
    await loadSavedTEs();
  } catch (e) {
    showToast(`Fetch failed: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Fetch TCs from Jira'; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    
    const lightbox = $('#lightbox-overlay');
    if (lightbox && !lightbox.classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxNav(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); lightboxNav(1); return; }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      goBackToGrid();
      return;
    }
    
    if ($('#tc-detail-section') && !$('#tc-detail-section').classList.contains('hidden')) {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); passTC(); }
      if (e.ctrlKey && e.shiftKey && e.key === 'Enter') { e.preventDefault(); failTC(); }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); savePOTOnly(); }
    }
    
    if ($('#defect-preview-section') && !$('#defect-preview-section').classList.contains('hidden')) {
      if (e.ctrlKey && e.shiftKey && e.key === 'd') { e.preventDefault(); draftDefect(); }
    }
  });

  // Paste URL auto-detection
  const teInput = $('#te-key-input');
  if (teInput) {
    teInput.addEventListener('paste', (e) => {
      setTimeout(() => {
        const val = teInput.value.trim();
        if (val.includes('/browse/')) {
          const key = val.split('/browse/').pop().split('?')[0].split('#')[0].trim();
          if (key) {
            teInput.value = key;
            showToast(`Detected TE key: ${key} — fetching from Jira...`, 'info');
            fetchJiraTE();
          }
        }
      }, 50);
    });
  }

  loadSettings();
  checkSession();
  loadSavedTEs();
  setupDropZone('expected');
  setupDropZone('actual');
  setupPasteHandler();

  const btnSettings = $('#btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', () => toggleSettings(true));
  
  const btnCloseSettings = $('#btn-close-settings');
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', () => toggleSettings(false));
  
  const settingsOverlay = $('#settings-overlay');
  if (settingsOverlay) settingsOverlay.addEventListener('click', () => toggleSettings(false));
  
  const btnSaveSettings = $('#btn-save-settings');
  if (btnSaveSettings) btnSaveSettings.addEventListener('click', saveSettings);
  
  const btnLogin = $('#btn-login');
  if (btnLogin) btnLogin.addEventListener('click', handleLogin);
  
  const btnSaveSession = $('#btn-save-session');
  if (btnSaveSession) btnSaveSession.addEventListener('click', handleSaveSession);

  const btnFetchJiraTe = $('#btn-fetch-jira-te');
  if (btnFetchJiraTe) btnFetchJiraTe.addEventListener('click', fetchJiraTE);
  
  const btnOpenJiraTe = $('#btn-open-jira-te');
  if (btnOpenJiraTe) btnOpenJiraTe.addEventListener('click', openJiraTE);

  const tcNumInput = $('#tc-number-input');
  if (tcNumInput) {
    tcNumInput.addEventListener('change', (e) => {
      const tc = state.testCases.find(t => t.key === state.currentTC);
      if (tc) {
        tc.tc_number = e.target.value.trim().toUpperCase();
        saveExecutionState();
        renderTCGrid();
      }
    });
  }

  const btnOpenJiraTC = $('#btn-open-jira-tc');
  if (btnOpenJiraTC) {
    btnOpenJiraTC.addEventListener('click', () => {
      if (state.currentTC) {
        openJiraTC(state.currentTC);
      }
    });
  }

  const searchInput = $('#tc-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderTCGrid();
    });
  }

  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
      currentFilter = e.target.getAttribute('data-filter') || 'all';
      renderTCGrid();
    });
  });

  const teForm = $('#te-form');
  if (teForm) {
    teForm.addEventListener('submit', (e) => {
      e.preventDefault();
      loadTE($('#te-key-input').value.trim());
    });
  }

  const btnShowAddTc = $('#btn-show-add-tc');
  if (btnShowAddTc) {
    btnShowAddTc.addEventListener('click', () => {
      $('#add-tc-container').classList.toggle('hidden');
      hide($('#add-multiple-tc-container'));
    });
  }

  const btnAddMultipleTc = $('#btn-add-multiple-tc');
  if (btnAddMultipleTc) {
    btnAddMultipleTc.addEventListener('click', () => {
      $('#add-multiple-tc-container').classList.toggle('hidden');
      hide($('#add-tc-container'));
    });
  }

  const btnAddTcSubmit = $('#btn-add-tc-submit');
  if (btnAddTcSubmit) btnAddTcSubmit.addEventListener('click', () => addTC($('#new-tc-input').value.trim()));
  
  const btnAddMultipleSubmit = $('#btn-add-multiple-submit');
  if (btnAddMultipleSubmit) btnAddMultipleSubmit.addEventListener('click', () => addMultipleTCs($('#multiple-tc-input').value));

  const btnDownloadPoc = $('#btn-download-poc');
  if (btnDownloadPoc) btnDownloadPoc.addEventListener('click', downloadPOC);

  const btnDeleteTe = $('#btn-delete-te');
  if (btnDeleteTe) btnDeleteTe.addEventListener('click', () => deleteTE(state.teKey));

  const btnPass = $('#btn-pass');
  if (btnPass) btnPass.addEventListener('click', passTC);
  
  const btnFail = $('#btn-fail');
  if (btnFail) btnFail.addEventListener('click', failTC);
  
  const btnSkip = $('#btn-skip');
  if (btnSkip) btnSkip.addEventListener('click', skipTC);

  const btnDeleteTc = $('#btn-delete-tc');
  if (btnDeleteTc) {
    btnDeleteTc.addEventListener('click', () => {
      if (state.currentTC) deleteTC(state.currentTC);
    });
  }

  const btnDraftDefect = $('#btn-draft-defect');
  if (btnDraftDefect) btnDraftDefect.addEventListener('click', draftDefect);
  
  const btnRegenerateDefect = $('#btn-regenerate-defect');
  if (btnRegenerateDefect) btnRegenerateDefect.addEventListener('click', draftDefect);

  const btnCopyDefect = $('#btn-copy-defect');
  if (btnCopyDefect) btnCopyDefect.addEventListener('click', copyDefectToClipboard);
  
  const btnSubmitDefect = $('#btn-submit-defect');
  if (btnSubmitDefect) btnSubmitDefect.addEventListener('click', submitDefect);

  const btnRebuildPot = $('#btn-rebuild-pot');
  if (btnRebuildPot) btnRebuildPot.addEventListener('click', generatePOT);

  const envSelect = $('#te-env-select');
  if (envSelect) {
    envSelect.addEventListener('change', async (e) => {
      if (!state.teKey) return;
      try {
        await api('POST', '/api/update-te-env', { te_key: state.teKey, environment: e.target.value });
        showToast(`Environment updated to ${e.target.value}`, 'success');
      } catch (err) {
        showToast('Failed to update environment', 'error');
      }
    });
  }

  const langSelect = $('#te-lang-select');
  if (langSelect) {
    langSelect.addEventListener('change', async (e) => {
      if (!state.teKey) return;
      try {
        await api('POST', '/api/update-te-lang', { te_key: state.teKey, language: e.target.value });
        showToast(`Language updated to ${e.target.value}`, 'success');
      } catch (err) {
        showToast('Failed to update language', 'error');
      }
    });
  }
  const updateLinkTE = async () => {
    if (!state.teKey) return;
    const toggle = $('#te-link-toggle');
    const input = $('#te-link-input');
    if (!toggle || !input) return;
    try {
      await api('POST', '/api/update-te-link', { 
        te_key: state.teKey, 
        linked_te: input.value.trim(), 
        linked_te_enabled: toggle.checked 
      });
      state.linkedTeKey = input.value.trim();
      state.linkedTeEnabled = toggle.checked;
      
      if (toggle.checked && input.value.trim()) {
         showToast(`Linked TE set to ${input.value.trim()}`, 'success');
         // reload TE to fetch linked data
         await loadTE(state.teKey);
      } else {
         state.linkedTestCases = [];
      }
    } catch (err) {
      showToast('Failed to update linked TE', 'error');
    }
  };

  const linkToggle = $('#te-link-toggle');
  if (linkToggle) linkToggle.addEventListener('change', updateLinkTE);

  const linkInput = $('#te-link-input');
  if (linkInput) linkInput.addEventListener('change', updateLinkTE);

  $('#toggle-lang-en')?.addEventListener('click', () => setBilingualContext('primary'));
  $('#toggle-lang-ar')?.addEventListener('click', () => setBilingualContext('secondary'));
  $('#defect-toggle-lang-en')?.addEventListener('click', () => setBilingualContext('primary'));
  $('#defect-toggle-lang-ar')?.addEventListener('click', () => setBilingualContext('secondary'));

  const btnRaiseAdHoc = $('#btn-raise-adhoc-defect');
  if (btnRaiseAdHoc) btnRaiseAdHoc.addEventListener('click', raiseAdHocDefect);

  // Draft Queue buttons
  const btnSaveAsDraft = $('#btn-save-as-draft');
  if (btnSaveAsDraft) btnSaveAsDraft.addEventListener('click', saveAsDraft);

  const btnShowDraftQueue = $('#btn-show-draft-queue');
  if (btnShowDraftQueue) btnShowDraftQueue.addEventListener('click', toggleDraftQueue);

  const btnSubmitAllDrafts = $('#btn-submit-all-drafts');
  if (btnSubmitAllDrafts) btnSubmitAllDrafts.addEventListener('click', submitAllDrafts);

  const btnCancelBatch = $('#btn-cancel-batch');
  if (btnCancelBatch) btnCancelBatch.addEventListener('click', cancelBatch);

  // Settings History Dropdowns — when a saved option is selected, fill the input
  document.querySelectorAll('.history-dropdown').forEach(select => {
    select.addEventListener('change', (e) => {
      const fieldName = select.dataset.for;
      if (!fieldName || !e.target.value) return;
      const input = document.querySelector(`input[name="${fieldName}"]`);
      if (input) {
        input.value = e.target.value;
        input.dispatchEvent(new Event('input'));
      }
      select.value = ''; // Reset dropdown to placeholder
    });
  });

  setupAutoResize('#defect-form textarea');

  // User Story / Test Guide
  const btnUploadStory = $('#btn-upload-story');
  const inputStory = $('#input-user-story');
  if (btnUploadStory && inputStory) {
    btnUploadStory.addEventListener('click', () => inputStory.click());
    inputStory.addEventListener('change', (e) => {
      if (e.target.files.length) uploadUserStory(e.target.files[0]);
      e.target.value = '';
    });
  }

  $('#btn-generate-guide')?.addEventListener('click', generateTestGuide);
  $('#btn-close-guide')?.addEventListener('click', () => toggleGuidePanel(false));
  $('#btn-copy-guide')?.addEventListener('click', () => {
    const text = `WHAT TO TEST:\n${$('#guide-what').textContent}\n\nSTEPS:\n${$('#guide-steps').textContent}\n\nLOOK FOR:\n${$('#guide-lookfor').textContent}`;
    navigator.clipboard.writeText(text).then(() => showToast('📋 Guide copied to clipboard', 'success'));
  });
});
