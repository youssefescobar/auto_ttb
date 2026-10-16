import { DEFAULTS, getSettings, originOf, saveSettings, normaliseBaseUrl } from "./lib/settings.js";
import { Jira } from "./lib/jira.js";
import { exportAll, importAll } from "./lib/store.js";

const form = document.getElementById("form");
const status = document.getElementById("status");

function show(msg, kind = "muted") {
  status.textContent = msg;
  status.className = kind;
}

async function load() {
  const s = await getSettings();
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const input = form.elements[k];
    if (!input) continue;
    if (typeof def === "boolean") input.checked = Boolean(s[k]);
    else input.value = s[k] ?? "";
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const input = form.elements[k];
    if (input) values[k] = typeof def === "boolean" ? input.checked : input.value.trim();
  }
  const origin = originOf(normaliseBaseUrl(values.jira_base_url));
  if (!origin) return show("Enter a full Jira URL, e.g. https://jira.example.com", "error");

  // Must run directly in the click handler: Chrome only shows the prompt for a user gesture.
  // Match patterns can't carry a port, so ask for the host.
  const { protocol, hostname } = new URL(origin);
  const granted = await chrome.permissions.request({ origins: [`${protocol}//${hostname}/*`] });
  if (!granted) return show(`Chrome access to ${origin} was not granted, so the extension can't reach Jira.`, "error");

  const saved = await saveSettings(values);
  show("Saved. Checking Jira…");
  try {
    const me = await new Jira(saved.jira_base_url).myself();
    show(`Saved. Connected to Jira as ${me.displayName || me.name}.`, "ok");
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

load();
