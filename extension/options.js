import { SECTIONS, getSettings, originOf, saveSettings, normaliseBaseUrl, projectKey } from "./lib/settings.js";
import { Jira } from "./lib/jira.js";
import { detectCustomFields } from "./lib/defect.js";
import { GEMINI_ORIGIN } from "./lib/ai.js";
import { addShot, exportAll, importAll, listTes, saveTe, shotsForTe } from "./lib/store.js";
import { matchOldShots, mergeOldDb } from "./lib/legacy.js";

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
    const advanced = title.startsWith("Advanced");
    const box = document.createElement(advanced ? "details" : "section");
    const head = document.createElement(advanced ? "summary" : "h2");
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

  const saved = await saveSettings(values);
  await load();
  show("Saved. Checking Jira…");
  try {
    const me = await new Jira(saved.jira_base_url).myself();
    show(`Saved. Connected to Jira as ${me.displayName || me.name}.`, "ok");
  } catch (err) {
    show(`Saved, but Jira said: ${err.message}`, "error");
  }
});

document.getElementById("detect").addEventListener("click", async () => {
  const values = readForm();
  if (!values.jira_project) return show("Enter the Jira project key under Defects first.", "error");
  show("Reading the create screen from Jira…");
  try {
    const meta = await new Jira(normaliseBaseUrl(values.jira_base_url)).createMeta(values.jira_project, values.defect_issue_type || "Defect");
    const { found, unmatched } = detectCustomFields(meta.fields);
    let filled = 0;
    for (const [key, id] of Object.entries(found)) {
      if (!form.elements[key].value) {
        form.elements[key].value = id;
        filled++;
      }
    }
    form.querySelector("details").open = true;
    show(`Found ${Object.keys(found).length} fields, filled ${filled} empty ones${unmatched.length ? `; not found: ${unmatched.map((k) => k.replace("field_", "")).join(", ")}` : ""}. Click Save to keep them.`, "ok");
  } catch (err) {
    show(err.message, "error");
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

// Keys saved by the Python app under older names
const OLD_ALIASES = { issue_type: "defect_issue_type", environment: "defect_environment", demo_name: "demo", issue_key: "for_project" };

document.getElementById("import-old").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const old = JSON.parse(await file.text());
    let n = 0;
    for (const [rawKey, value] of Object.entries(old)) {
      const key = OLD_ALIASES[rawKey] || rawKey;
      const input = form.elements[key];
      if (!input || value === "" || value === null || typeof value === "object") continue;
      if (input.type === "checkbox") input.checked = value === true || /^(1|true|yes|on)$/i.test(String(value));
      else input.value = String(value);
      n++;
    }
    show(`Filled ${n} settings from ${file.name}. Review them, then click Save.`, "ok");
  } catch (err) {
    show(`Couldn't read ${file.name}: ${err.message}`, "error");
  }
  e.target.value = "";
});

const legacyStatus = document.getElementById("legacy-status");
function legacy(msg, kind = "muted") {
  legacyStatus.textContent = msg;
  legacyStatus.className = kind;
}

document.getElementById("import-db").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const tes = mergeOldDb(JSON.parse(await file.text()), await listTes());
    for (const te of tes) await saveTe(te);
    const tcs = tes.reduce((n, te) => n + te.test_cases.length, 0);
    legacy(`Imported ${tes.length} test executions (${tcs} test cases). Now pick the old executions folder for the screenshots.`, "ok");
  } catch (err) {
    legacy(`Couldn't import ${file.name}: ${err.message}`, "error");
  }
  e.target.value = "";
});

document.getElementById("import-shots").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  try {
    const shots = matchOldShots(files, await listTes());
    if (!shots.length) throw new Error("no screenshots matched. Import db.json first, then pick the folder named executions.");
    const have = new Map();
    let added = 0;
    for (const [i, s] of shots.entries()) {
      if (!have.has(s.te_key)) have.set(s.te_key, new Set((await shotsForTe(s.te_key)).map((x) => `${x.tc_key}/${x.category}/${x.name}`)));
      const seen = have.get(s.te_key);
      const id = `${s.tc_key}/${s.category}/${s.name}`;
      if (seen.has(id)) continue; // already imported
      await addShot({ te_key: s.te_key, tc_key: s.tc_key, category: s.category, name: s.name, blob: new Blob([s.file], { type: s.file.type || "image/png" }) });
      seen.add(id);
      added++;
      if (i % 20 === 0) legacy(`Importing screenshots… ${i + 1} of ${shots.length}`);
    }
    legacy(`Imported ${added} screenshots${added < shots.length ? ` (${shots.length - added} were already there)` : ""}.`, "ok");
  } catch (err) {
    legacy(`Couldn't import screenshots: ${err.message}`, "error");
  }
  e.target.value = "";
});

build();
load();
