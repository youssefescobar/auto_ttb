import { SECTIONS, getSettings, originOf, saveSettings, normaliseBaseUrl, projectKey, splitList } from "./lib/settings.js";
import { Jira } from "./lib/jira.js";
import { SETTING_FIELDS, metaFieldFor, optionLabels } from "./lib/defect.js";
import { GEMINI_ORIGIN } from "./lib/ai.js";
import { exportAll, importAll } from "./lib/store.js";

const form = document.getElementById("form");
const status = document.getElementById("status");
let current = {};

function show(msg, kind = "muted") {
  status.textContent = msg;
  status.className = kind;
}

function field([key, label, , type, help]) {
  const input = document.createElement("input");
  input.name = key;
  if (type === "bool") {
    input.type = "checkbox";
    const l = document.createElement("label");
    l.className = "check";
    l.append(input, " ", label);
    return l;
  }
  if (type === "secret") {
    input.type = "password";
    input.autocomplete = "off";
  }
  const l = document.createElement("label");
  l.append(label, input);
  if (help) {
    const small = document.createElement("small");
    small.textContent = help;
    l.append(small);
  }
  return l;
}

function build() {
  const root = document.getElementById("fields");
  for (const [title, fields] of SECTIONS) {
    const box = document.createElement("section");
    const head = document.createElement("h2");
    head.textContent = title;
    box.append(head, ...fields.map(field));
    root.append(box);
  }
}

const allFields = () => SECTIONS.flatMap(([, f]) => f);

async function load() {
  current = await getSettings();
  for (const [key, , , type] of allFields()) {
    const input = form.elements[key];
    if (type === "bool") input.checked = Boolean(current[key]);
    else if (type === "secret") {
      input.value = "";
      input.placeholder = current[key] ? "Saved. Type a new one to replace it." : "";
    } else input.value = current[key] ?? "";
  }
}

function readForm() {
  const values = {};
  for (const [key, , , type] of allFields()) {
    const input = form.elements[key];
    if (type === "bool") values[key] = input.checked;
    else if (type === "secret") values[key] = input.value.trim() || current[key] || "";
    else values[key] = input.value.trim();
  }
  values.jira_project = projectKey(values.jira_project);
  return values;
}

// --- Dropdowns from the Defect create screen --------------------------------

function select(name, choices, value) {
  const el = document.createElement("select");
  el.name = name;
  const opts = ["", ...choices];
  if (value && !choices.includes(value)) opts.push(value); // keep a saved value Jira no longer offers
  for (const v of opts) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v === "" ? "—" : choices.includes(v) ? v : `${v} (not offered by Jira)`;
    o.selected = v === (value || "");
    el.append(o);
  }
  return el;
}

// Swaps the element named `name` for a new one, keeping its label.
function swap(name, el) {
  const old = form.elements[name];
  (old.closest(".checks") || old).replaceWith(el);
}

// Components can hold several values: checkboxes feeding a hidden comma-separated input.
function checkboxes(name, choices, value) {
  const chosen = new Set(splitList(value));
  const hidden = Object.assign(document.createElement("input"), { type: "hidden", name, value: value || "" });
  const box = document.createElement("div");
  box.className = "checks";
  for (const c of [...new Set([...choices, ...chosen])]) {
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: chosen.has(c) });
    cb.addEventListener("change", () => {
      hidden.value = [...box.querySelectorAll("input:checked")].map((x) => x.dataset.v).join(", ");
    });
    cb.dataset.v = c;
    const l = document.createElement("label");
    l.className = "check";
    l.append(cb, " ", c);
    box.append(l);
  }
  box.append(hidden);
  return box;
}

async function loadDropdowns() {
  const values = readForm();
  if (!values.jira_base_url || !values.jira_project) return;
  const note = document.getElementById("choices-status");
  note.textContent = "Loading choices from Jira…";
  note.className = "muted";
  let meta;
  try {
    meta = await new Jira(normaliseBaseUrl(values.jira_base_url)).createMeta(values.jira_project, values.defect_issue_type || "Defect");
  } catch (err) {
    note.textContent = `Couldn't load choices from Jira, so these are free text: ${err.message}`;
    note.className = "warn";
    return;
  }
  let n = 0;
  for (const key of Object.keys(SETTING_FIELDS)) {
    const choices = optionLabels(metaFieldFor(meta, key)?.allowedValues);
    if (!choices.length || !form.elements[key]) continue;
    swap(key, key === "components" ? checkboxes(key, choices, values[key]) : select(key, choices, values[key]));
    n++;
  }
  // Filed against lists the children of the chosen Defect type
  const typeField = metaFieldFor(meta, "defect_type");
  const fillFiledAgainst = () => {
    const parent = (typeField?.allowedValues || []).find((o) => (o.value ?? o.name) === form.elements.defect_type.value);
    const kids = optionLabels(parent?.children);
    swap("filed_against", kids.length ? select("filed_against", kids, form.elements.filed_against.value) : Object.assign(document.createElement("input"), { name: "filed_against", value: form.elements.filed_against.value }));
  };
  if (form.elements.defect_type.tagName === "SELECT") {
    form.elements.defect_type.addEventListener("change", () => {
      form.elements.filed_against.value = "";
      fillFiledAgainst();
    });
    fillFiledAgainst();
  }
  note.textContent = n ? `Choices loaded from the ${values.jira_project} ${values.defect_issue_type || "Defect"} create screen.` : "";
  note.className = "muted";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = readForm();
  const origin = originOf(normaliseBaseUrl(values.jira_base_url));
  if (!origin) return show("Enter a full Jira URL, e.g. https://jira.example.com", "error");

  // Must run directly in the click handler: Chrome only shows the prompt for a user gesture.
  // Match patterns can't carry a port, so ask for the host.
  const { protocol, hostname } = new URL(origin);
  const origins = [`${protocol}//${hostname}/*`];
  if (values.gemini_api_key) origins.push(`${GEMINI_ORIGIN}/*`);
  const granted = await chrome.permissions.request({ origins });
  if (!granted) return show("Chrome access was not granted, so the extension can't reach Jira (or Gemini).", "error");

  const projectChanged = values.jira_project !== current.jira_project || values.defect_issue_type !== current.defect_issue_type;
  const saved = await saveSettings(values);
  current = await getSettings();
  show("Saved. Checking Jira…");
  try {
    const me = await new Jira(saved.jira_base_url).myself();
    show(`Saved. Connected to Jira as ${me.displayName || me.name}.`, "ok");
    if (projectChanged) loadDropdowns();
  } catch (err) {
    show(`Saved, but Jira said: ${err.message}`, "error");
  }
});

document.getElementById("export").addEventListener("click", async () => {
  const data = await exportAll();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `auto_ttb-backup-${data.exported_at.slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

document.getElementById("import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await importAll(JSON.parse(await file.text()));
    show(`Imported ${file.name}.`, "ok");
  } catch (err) {
    show(`Import failed: ${err.message}`, "error");
  }
  e.target.value = "";
});

build();
// A line under the Defects heading for the dropdown status
const defectsHead = [...document.querySelectorAll("#fields h2")].find((x) => x.textContent === "Defects");
defectsHead.after(Object.assign(document.createElement("p"), { id: "choices-status", className: "muted" }));
load().then(loadDropdowns);
