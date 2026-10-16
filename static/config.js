/* Config page: the form is generated from /api/config-schema (config.SECTIONS). */
const $ = (sel) => document.querySelector(sel);

async function api(method, url, data = null) {
  const opts = { method, headers: {} };
  if (data) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.addEventListener('click', () => toast.remove());
  $('#toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), Math.max(3000, message.length * 60));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function buildField(field, settings, history, missing) {
  const { key, label, type, help, default: def } = field;
  const id = `cfg-${key}`;
  const group = el('div', { class: 'form-group' });
  const required = missing.includes(key) ? ' *' : '';

  if (type === 'bool') {
    const input = el('input', { type: 'checkbox', name: key, id });
    input.checked = Boolean(settings[key]);
    group.classList.add('checkbox-group');
    group.append(el('label', { class: 'checkbox-label', for: id }, input, el('span', {}, label)));
  } else {
    let input;
    if (type.startsWith('select:')) {
      input = el('select', { name: key, id });
      for (const opt of type.slice(7).split('|')) input.append(el('option', { value: opt }, opt));
      input.value = settings[key] ?? def;
    } else if (type === 'secret') {
      const isSet = settings[`${key}_set`];
      input = el('input', { type: 'password', name: key, id, autocomplete: 'off',
                            placeholder: isSet ? 'Saved (type to replace)' : 'Not set' });
    } else {
      input = el('input', { type: type === 'number' ? 'number' : 'text', name: key, id });
      input.value = settings[key] ?? '';
      if (def !== '' && def !== null) input.placeholder = String(def);
    }
    group.append(el('label', { for: id }, label + required));

    const options = history[key] || [];
    if (type === 'text' && options.length) {
      const pick = el('select', { class: 'history-dropdown', 'aria-label': `Saved values for ${label}` },
        el('option', { value: '' }, '— saved —'),
        ...options.map(o => el('option', { value: o, title: o }, o.length > 30 ? o.slice(0, 30) + '…' : o)));
      pick.addEventListener('change', () => { if (pick.value) input.value = pick.value; pick.value = ''; });
      group.append(el('div', { class: 'setting-with-history' }, input, pick));
    } else {
      group.append(input);
    }
  }
  if (help) group.append(el('small', { class: 'help-text text-muted' }, help));
  return group;
}

async function render() {
  const [schema, settings, history] = await Promise.all([
    api('GET', '/api/config-schema'),
    api('GET', '/api/settings'),
    api('GET', '/api/settings-history').catch(() => ({})),
  ]);
  $('#missing-banner').classList.toggle('hidden', !schema.missing.length);

  const form = $('#config-form');
  form.replaceChildren();
  for (const section of schema.sections) {
    // "Advanced: ..." sections start collapsed
    const advanced = section.title.startsWith('Advanced');
    const card = advanced
      ? el('details', { class: 'card config-section' }, el('summary', {}, el('h2', {}, section.title)))
      : el('section', { class: 'card config-section' }, el('h2', {}, section.title));
    if (section.fields.some(f => f.key.startsWith('field_'))) {
      const btn = el('button', { type: 'button', class: 'btn btn-sm btn-outline' }, '🔍 Detect from Jira');
      btn.addEventListener('click', () => detectFields(btn));
      card.append(el('p', { class: 'help-text text-muted' },
        'Reads your Defect create screen in Jira and fills the empty boxes below by field name. ',
        'Needs the Jira base URL saved, and a token or a saved Jira login.'), btn);
    }
    for (const field of section.fields) card.append(buildField(field, settings, history, schema.missing));
    form.append(card);
  }
}

async function detectFields(btn) {
  const form = $('#config-form');
  btn.disabled = true;
  try {
    const res = await api('POST', '/api/detect-fields', {
      jira_project: form.elements['jira_project']?.value.trim(),
      defect_issue_type: form.elements['defect_issue_type']?.value.trim(),
    });
    let filled = 0, differ = 0;
    for (const [key, id] of Object.entries(res.found)) {
      const input = form.elements[key];
      if (!input) continue;
      if (!input.value.trim()) { input.value = id; filled++; }
      else if (input.value.trim() !== id) differ++;
    }
    const missing = res.unmatched.length ? ` Not found: ${res.unmatched.map(k => k.replace('field_', '')).join(', ')}.` : '';
    const kept = differ ? ` Kept ${differ} value(s) you had already set.` : '';
    showToast(`Filled ${filled} field ID(s). Review, then Save.${kept}${missing}`, filled ? 'success' : 'info');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function save() {
  const data = {};
  const historyData = {};
  for (const input of $('#config-form').elements) {
    if (!input.name) continue;
    if (input.type === 'checkbox') data[input.name] = input.checked;
    else if (input.type === 'password') { if (input.value.trim()) data[input.name] = input.value.trim(); }
    else {
      data[input.name] = input.value.trim();
      if (input.type === 'text' && data[input.name]) historyData[input.name] = data[input.name];
    }
  }
  try {
    await api('POST', '/api/settings', data);
    await api('POST', '/api/settings-history', historyData);
    showToast('✅ Settings saved', 'success');
    await render();
  } catch (e) {
    showToast(e.message || 'Failed to save settings', 'error');
  }
}

$('#btn-save-config').addEventListener('click', save);
render().catch(e => showToast(`Failed to load settings: ${e.message}`, 'error'));
