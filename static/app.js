/* ============================================================
   Auto TTB v2.0 — Frontend Application Logic
   ============================================================ */

const state = {
  teKey: '',
  testCases: [],
  currentTC: null,
  screenshots: { expected: [], actual: [] },
  settings: {},
  defectDrafts: {},  // keyed by TC key, persists drafts without re-calling AI
};


const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const show = el => { if (el) el.classList.remove('hidden'); };
const hide = el => { if (el) el.classList.add('hidden'); };

function advanceToNextTC() {
  const nextPending = state.testCases.find(tc => tc.key !== state.currentTC && tc.status === 'pending');
  if (nextPending) {
    showToast(`Auto-advancing to ${nextPending.name || nextPending.key}`, 'info');
    selectTC(nextPending.key);
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
      if (el) {
        if (el.type === 'checkbox') {
          el.checked = Boolean(val);
        } else {
          el.value = Array.isArray(val) ? val.join(', ') : (val ?? '');
        }
      }
    }
    updateFixedFieldsDisplay();
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function saveSettings() {
  const form = $('#settings-form');
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      data[el.name] = el.checked;
    } else {
      data[el.name] = el.value;
    }
  }
  
  try {
    await api('POST', '/api/settings', data);
    state.settings = { ...state.settings, ...data };
    updateFixedFieldsDisplay();
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

    if (res.status === 'open' || res.status === 'opening') {
      if (dot) { dot.className = 'session-indicator warning'; dot.title = 'Browser open — log into Jira, then click Save Jira Session'; }
      if (loginBtn) hide(loginBtn);
      if (saveBtn) { show(saveBtn); saveBtn.textContent = '💾 Save Jira Session'; }
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

async function viewDefect(tcKey) {
  state.currentTC = tcKey;
  const tc = state.testCases.find(t => t.key === tcKey);
  if (!tc) return;

  hide($('#te-input-section'));
  hide($('#tc-grid-section'));
  hide($('#tc-detail-section'));
  show($('#defect-preview-section'));
  
  $('#defect-preview-title').textContent = `Jira Defect Ticket Preview — ${tcKey}`;

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
  const breadcrumb = $('#breadcrumb');
  const breadcrumbTE = $('#breadcrumb-te');
  if (breadcrumb) { show(breadcrumb); }
  if (breadcrumbTE) { breadcrumbTE.textContent = teKey; }
  renderTCGrid();
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

  $('#detail-tc-key').textContent = tc.name || tc.key;
  const numInput = $('#tc-number-input');
  if (numInput) {
    numInput.value = tc.tc_number || '';
  }

  const badge = $('#detail-tc-status');
  badge.textContent = (tc.status || 'pending').toUpperCase();
  badge.className = `status-badge ${tc.status || 'pending'}`;

  $('#tc-summary').value = tc.summary || '';

  setActiveCategory('actual');
  loadExistingScreenshots(tcKey);
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
  try {
    const res = await api('GET', `/api/screenshots/${state.teKey}/${tcKey}`);
    state.screenshots.expected = res.expected || [];
    state.screenshots.actual = res.actual || [];
  } catch (e) {}
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
  // Snapshot defect form back to drafts so manual edits persist
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
  tc.status = 'pass';
  saveExecutionState();

  showToast(`✅ ${tc.name || state.currentTC} PASSED`, 'success');
  advanceToNextTC();
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

async function skipTC() {
  const tc = state.testCases.find(t => t.key === state.currentTC);
  if (!tc) return;
  tc.summary = $('#tc-summary').value.trim();
  tc.status = 'skip';
  saveExecutionState();
  showToast(`⏭ ${state.currentTC} skipped`, 'info');
  advanceToNextTC();
}

async function failTC() {
  // Just mark as fail and open the defect preview page blank.
  // AI drafting is triggered separately via the "Draft Defect" button.
  const tc = state.testCases.find(t => t.key === state.currentTC);
  if (!tc) return;
  tc.summary = $('#tc-summary').value.trim();
  tc.status = 'fail';
  saveExecutionState();

  hide($('#tc-detail-section'));
  show($('#defect-preview-section'));
  $('#defect-preview-title').textContent = `Jira Defect Ticket Preview — ${state.currentTC}`;

  const existingDraft = state.defectDrafts[state.currentTC];
  if (existingDraft) {
    // Restore persisted draft without calling AI
    populateDefectForm(existingDraft);
    showToast('📋 Restored previous draft', 'info');
  } else if (tc.submitted_defect) {
    // Restore the previously submitted defect for review
    populateDefectForm(tc.submitted_defect);
    showToast('📋 Loaded submitted defect data', 'info');
  } else {
    // Open blank — user must click "Draft Defect" to trigger AI
    clearDefectForm();
  }
  updateFixedFieldsDisplay();
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


async function submitDefect() {
  if (!confirm('Submit this defect to Jira? This will open a Playwright browser and fill the Jira form.')) return;
  const btn = $('#btn-submit-defect');
  btn.disabled = true;
  btn.textContent = 'Submitting to Jira...';

  const tc = state.testCases.find(t => t.key === state.currentTC);

  try {
    const payload = {
      tc_key: state.currentTC,
      tc_name: tc ? (tc.name || tc.key) : state.currentTC,
      tc_number: tc ? (tc.tc_number || null) : null,
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
        const btc = state.testCases.find(t => t.key === bk || t.tc_number === bk);
        if (btc) {
          btc.status = 'blocked';
          btc.summary = `Blocked by defect ${res.issue_key} on TC ${tc ? tc.key : ''}`;
          btc.blocked_by = res.issue_key + (tc ? ` (${tc.key})` : '');
        }
      });
    }

    saveExecutionState();
    // Clear the persisted draft since it was successfully submitted
    delete state.defectDrafts[state.currentTC];
    const potMsg = res.saved_pot ? ' and saved to POT!' : '!';
    showToast(`❌ Defect ${res.issue_key} created${potMsg}`, 'success');
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
    const res = await api('DELETE', `/api/te/${targetKey}`);
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
          <span>${te.te_key}</span>
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

  setupAutoResize('#defect-form textarea');
});
