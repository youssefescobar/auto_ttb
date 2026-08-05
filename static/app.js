/* ============================================================
   Auto TTB v2.0 — Frontend Application Logic
   ============================================================ */

const state = {
  teKey: '',
  testCases: [],
  currentTC: null,
  screenshots: { expected: [], actual: [] },
  settings: {},
  defectDraft: null,
};

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const show = el => { if (el) el.classList.remove('hidden'); };
const hide = el => { if (el) el.classList.add('hidden'); };

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
      if (el) {
        el.value = Array.isArray(val) ? val.join(', ') : (val || '');
      }
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function saveSettings() {
  const form = $('#settings-form');
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  
  try {
    await api('POST', '/api/settings', data);
    state.settings = { ...state.settings, ...data };
    showToast('Settings & Jira defaults saved', 'success');
    toggleSettings(false);
  } catch (e) {
    showToast('Failed to save settings', 'error');
  }
}

async function checkSession() {
  try {
    const res = await api('GET', '/api/session-status');
    const dot = $('#session-dot');
    const loginBtn = $('#btn-login');
    const saveBtn = $('#btn-save-session');

    if (res.status === 'open') {
      if (dot) { dot.className = 'session-indicator warning'; dot.title = 'Browser open — log into Jira, then click Save Jira Session'; }
      if (loginBtn) hide(loginBtn);
      if (saveBtn) { show(saveBtn); saveBtn.textContent = '💾 Save Jira Session'; }
    } else if (res.exists) {
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
    filtered = filtered.filter(tc => (tc.key && tc.key.toLowerCase().includes(q)) || (tc.summary && tc.summary.toLowerCase().includes(q)));
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
    card.style.animationDelay = `${idx * 0.03}s`;

    const statusUpper = (tc.status || 'pending').toUpperCase();

    card.innerHTML = `
      <div class="tc-card-header">
        <span class="tc-key">${tc.key}</span>
        <div class="tc-card-actions">
          <span class="status-badge ${tc.status}">${statusUpper}</span>
          <button class="tc-card-delete-btn" data-tc="${tc.key}" title="Delete ${tc.key}">&times;</button>
        </div>
      </div>
      <p class="text-sm">${tc.summary || 'No summary entered'}</p>
      ${tc.defect_key ? `<span class="badge text-xs mt-1" style="background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.4)">🐛 Defect: ${tc.defect_key}</span>` : ''}
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.tc-card-delete-btn')) return;
      selectTC(tc.key);
    });

    const delBtn = card.querySelector('.tc-card-delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTC(tc.key);
      });
    }

    grid.appendChild(card);
  });
  updateProgress();
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
    const saved = await api('GET', `/api/execution-state/${teKey}`);
    state.testCases = Array.isArray(saved.test_cases) ? saved.test_cases : [];
  } catch (e) {
    state.testCases = [];
  }

  $('#tc-grid-title').textContent = `Test Cases — ${teKey}`;
  hide($('#te-input-section'));
  show($('#tc-grid-section'));
  renderTCGrid();
  showToast(`TE ${teKey} loaded`, 'success');
}

function addTC(tcKey) {
  if (!tcKey) return;
  const cleaned = tcKey.trim().toUpperCase();
  if (state.testCases.find(tc => tc.key === cleaned)) {
    showToast('TC already exists', 'error');
    return;
  }
  state.testCases.push({ key: cleaned, summary: '', status: 'pending' });
  saveExecutionState();
  renderTCGrid();
  $('#new-tc-input').value = '';
  hide($('#add-tc-container'));
  showToast(`Added ${cleaned}`, 'success');
}

function addMultipleTCs(text) {
  const keys = text.split(/[\n,]+/).map(k => k.trim().toUpperCase()).filter(Boolean);
  let added = 0;
  for (const k of keys) {
    if (!state.testCases.find(tc => tc.key === k)) {
      state.testCases.push({ key: k, summary: '', status: 'pending' });
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
  if (!state.teKey) return;
  try {
    await api('POST', `/api/execution-state/${state.teKey}`, { test_cases: state.testCases });
  } catch (e) {}
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

function selectTC(tcKey) {
  state.currentTC = tcKey;
  const tc = state.testCases.find(t => t.key === tcKey);
  if (!tc) return;

  hide($('#tc-grid-section'));
  hide($('#defect-preview-section'));
  show($('#tc-detail-section'));

  $('#detail-tc-key').textContent = tcKey;
  const badge = $('#detail-tc-status');
  badge.textContent = (tc.status || 'pending').toUpperCase();
  badge.className = `status-badge ${tc.status || 'pending'}`;

  $('#tc-summary').value = tc.summary || '';

  setActiveCategory('actual');
  loadExistingScreenshots(tcKey);
}

async function loadExistingScreenshots(tcKey) {
  state.screenshots = { expected: [], actual: [] };
  try {
    const res = await api('GET', `/api/screenshots/${state.teKey}/${tcKey}`);
    state.screenshots.expected = res.expected || [];
    state.screenshots.actual = res.actual || [];
  } catch (e) {}
  renderThumbnails('expected');
  renderThumbnails('actual');
}

function goBackToGrid() {
  hide($('#tc-detail-section'));
  hide($('#defect-preview-section'));
  show($('#tc-grid-section'));
  state.currentTC = null;
  renderTCGrid();
}

// Screenshot Dropzones & Upload
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
  if (!state.currentTC || !state.teKey) return;
  if (isUploading) return;

  const files = Array.from(fileList).filter(f => f.type && f.type.startsWith('image/'));
  if (!files.length) return;

  isUploading = true;
  const catLabel = category === 'expected' ? 'Expected Result' : 'Actual Result';

  const formData = new FormData();
  formData.append('te_key', state.teKey);
  formData.append('tc_key', state.currentTC);
  formData.append('category', category);
  for (const f of files) formData.append('screenshots', f);

  try {
    const res = await api('POST', '/api/upload-screenshots', formData);
    await loadExistingScreenshots(state.currentTC);
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

  if (state.teKey && state.currentTC && shot.name) {
    try {
      await api('POST', '/api/delete-screenshot', {
        te_key: state.teKey,
        tc_key: state.currentTC,
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

// Pass / Fail / POT Actions
async function passTC() {
  const tc = state.testCases.find(t => t.key === state.currentTC);
  if (!tc) return;
  tc.summary = $('#tc-summary').value.trim();

  try {
    await api('POST', '/api/pass-tc', {
      tc_key: tc.key,
      te_key: state.teKey,
      summary: tc.summary,
      expected_shots: getShotPaths('expected'),
      actual_shots: getShotPaths('actual')
    });
    tc.status = 'pass';
    saveExecutionState();
    showToast(`✅ ${state.currentTC} PASSED & Saved to POT`, 'success');
    goBackToGrid();
  } catch (e) {
    showToast(`Pass failed: ${e.message}`, 'error');
  }
}

async function savePOTOnly() {
  const tc = state.testCases.find(t => t.key === state.currentTC);
  if (!tc) return;
  tc.summary = $('#tc-summary').value.trim();

  try {
    await api('POST', '/api/save-pot', {
      tc_key: tc.key,
      te_key: state.teKey,
      status: tc.status.toUpperCase() || 'PASS',
      summary: tc.summary,
      expected_shots: getShotPaths('expected'),
      actual_shots: getShotPaths('actual'),
      defect_key: tc.defect_key || null
    });
    showToast(`💾 Saved ${tc.key} to POT Word document`, 'success');
  } catch (e) {
    showToast(`Save to POT failed: ${e.message}`, 'error');
  }
}

async function skipTC() {
  const tc = state.testCases.find(t => t.key === state.currentTC);
  if (!tc) return;
  tc.summary = $('#tc-summary').value.trim();
  tc.status = 'skip';
  saveExecutionState();
  showToast(`⏭ ${state.currentTC} skipped`, 'info');
  goBackToGrid();
}

async function failTC() {
  const summary = $('#tc-summary').value.trim();
  if (!summary) {
    showToast('Please enter brief QA Notes / summary of the issue', 'error');
    $('#tc-summary').focus();
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

    state.defectDraft = defect;

    hide($('#tc-detail-section'));
    show($('#defect-preview-section'));

    $('#defect-preview-title').textContent = `Jira Defect Ticket Preview — ${state.currentTC}`;
    $('#defect-title').value = defect.title || '';
    $('#defect-scenario').value = defect.scenario || '';
    $('#defect-steps').value = defect.steps || '';
    $('#defect-expected').value = defect.expected || '';
    $('#defect-actual').value = defect.actual || '';
    $('#defect-severity').value = '1-Low';
    $('#defect-blocked-tcs').value = '1';
    $('#defect-assignee').value = 'Saurabh Shukla';

    if (defect.ai_error) {
      showToast(`⚠️ AI API Error: ${defect.ai_error}. Loaded default template fallback.`, 'error');
    }

  } catch (e) {
    showToast(`AI generation failed: ${e.message}`, 'error');
  } finally {
    hide($('#ai-loading'));
  }
}

async function submitDefect() {
  const btn = $('#btn-submit-defect');
  btn.disabled = true;
  btn.textContent = 'Submitting to Jira...';

  try {
    const payload = {
      tc_key: state.currentTC,
      te_key: state.teKey,
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

    const tc = state.testCases.find(t => t.key === state.currentTC);
    if (tc) {
      tc.status = 'fail';
      tc.summary = $('#tc-summary')?.value?.trim() || tc.summary;
      tc.defect_key = res.issue_key;
    }

    saveExecutionState();
    showToast(`❌ Defect ${res.issue_key} created and saved to POT!`, 'success');
    goBackToGrid();
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

function downloadPOC() {
  if (!state.teKey) { showToast('No TE session loaded', 'error'); return; }
  window.open(`/api/download-poc/${state.teKey}`, '_blank');
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
      const chip = document.createElement('button');
      chip.className = 'btn te-chip';
      chip.type = 'button';
      chip.innerHTML = `
        <span>${te.te_key}</span>
        <span class="badge text-xs">${te.tc_count} TCs</span>
      `;
      chip.addEventListener('click', () => {
        $('#te-key-input').value = te.te_key;
        loadTE(te.te_key);
      });
      list.appendChild(chip);
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
  loadSettings();
  checkSession();
  loadSavedTEs();
  setupDropZone('expected');
  setupDropZone('actual');
  setupPasteHandler();

  $('#btn-settings').addEventListener('click', () => toggleSettings(true));
  $('#btn-close-settings').addEventListener('click', () => toggleSettings(false));
  $('#settings-overlay').addEventListener('click', () => toggleSettings(false));
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-login').addEventListener('click', handleLogin);
  $('#btn-save-session').addEventListener('click', handleSaveSession);

  $('#btn-fetch-jira-te').addEventListener('click', fetchJiraTE);
  $('#btn-open-jira-te').addEventListener('click', openJiraTE);

  // Search & Filter event listeners
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

  $('#te-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadTE($('#te-key-input').value.trim());
  });

  $('#btn-show-add-tc').addEventListener('click', () => {
    $('#add-tc-container').classList.toggle('hidden');
    hide($('#add-multiple-tc-container'));
  });
  $('#btn-add-multiple-tc').addEventListener('click', () => {
    $('#add-multiple-tc-container').classList.toggle('hidden');
    hide($('#add-tc-container'));
  });
  $('#btn-add-tc-submit').addEventListener('click', () => addTC($('#new-tc-input').value.trim()));
  $('#btn-add-multiple-submit').addEventListener('click', () => addMultipleTCs($('#multiple-tc-input').value));

  $('#btn-download-poc').addEventListener('click', downloadPOC);

  $('#btn-pass').addEventListener('click', passTC);
  $('#btn-fail').addEventListener('click', failTC);
  $('#btn-save-pot-tc').addEventListener('click', savePOTOnly);
  $('#btn-skip').addEventListener('click', skipTC);

  $('#btn-delete-tc').addEventListener('click', () => {
    if (state.currentTC) deleteTC(state.currentTC);
  });

  $('#btn-regenerate-defect').addEventListener('click', failTC);
  $('#btn-copy-defect').addEventListener('click', copyDefectToClipboard);
  $('#btn-save-pot-defect').addEventListener('click', savePOTOnly);
  $('#btn-submit-defect').addEventListener('click', submitDefect);
});
