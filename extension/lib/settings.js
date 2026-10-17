// Settings live in chrome.storage.local under one key and are edited on the options page.

// [key, label, default, type, help]. Types: text, secret, bool, textarea.
export const SECTIONS = [
  ["Jira", [
    ["jira_base_url", "Jira base URL", "", "text",
      "Saving asks Chrome for access to this site only. The extension uses your normal Jira login; no token or password is stored."],
    ["comment_evidence", "Also add a Jira comment with the Actual screenshots when passing or failing", false, "bool", ""],
  ]],
  ["Test execution", [
    ["environments", "Environments (comma separated)", "SIT, UAT, PP, Prod", "text", ""],
    ["languages", "Languages (comma separated)", "English, Arabic", "text", ""],
  ]],
  ["Record and replay", [
    ["replay_pause", "Pause between steps (seconds)", "0.5", "text", "Each step can also have its own wait, set in its Steps list"],
    ["typing_ms", "Typing speed (milliseconds per character)", "60", "text", ""],
    ["real_input", "Replay with real mouse and keyboard input (needed for BrowserStack and many web apps; Chrome shows a \"started debugging\" bar while it runs)", true, "bool", ""],
  ]],
  ["AI (Gemini)", [
    ["gemini_api_key", "Gemini API key", "", "secret", "Stored in this browser profile only. Saving asks Chrome for access to Google's Gemini API."],
    ["gemini_model", "Gemini model", "gemini-2.5-flash", "text", ""],
    ["share_screenshots_with_ai", "Send screenshots to Gemini (otherwise only your notes are sent)", true, "bool", ""],
  ]],
  ["Defects", [
    ["jira_project", "Jira project key", "", "text", "Key defects are created in, e.g. BDR (\"B2B Digital Revamp (BDR)\" also works)"],
    ["defect_issue_type", "Issue type", "Defect", "text", ""],
    ["for_project", "For Project", "", "text", "Project issue key for the For Project field, e.g. JK26-3835"],
    ["demo", "Demo", "", "text", ""],
    ["components", "Component/s", "", "text", "Comma separated"],
    ["impacted_system", "Impacted system", "", "text", ""],
    ["defect_type", "Defect type", "", "text", ""],
    ["filed_against", "Filed against", "", "text", "Second level of Defect type"],
    ["defect_environment", "Defect environment", "", "text", "Also tells the AI which environment you test"],
    ["defect_phase", "Defect phase", "", "text", ""],
    ["priority", "Default severity", "", "text", ""],
    ["assignee", "Default assignee", "", "text", "Jira username or name"],
    ["labels", "Labels", "", "text", "Comma separated"],
    ["usability_issue", "Usability issue", "", "text", ""],
    ["re_occurrence", "Re-occurrence", "", "text", ""],
    ["newstack_impact", "NewStack impact", "", "text", ""],
    ["defect_category", "Defect category", "", "text", ""],
    ["milestone_type", "Milestone type", "", "text", ""],
    ["uat_priority", "UAT priority", "", "text", ""],
    ["epic", "BDR_EPIC", "", "text", "e.g. Font & Family Light Mode"],
    ["defect_title_prefix", "Title prefix", "", "text", ""],
    ["defect_title_pattern", "Title pattern", "{AI_TITLE}", "text", "Placeholders: {PREFIX} {TE_KEY} {TC_KEY} {AI_TITLE}"],
  ]],
];

export const DEFAULTS = Object.fromEntries(SECTIONS.flatMap(([, fields]) => fields.map(([k, , def]) => [k, def])));

const KEY = "settings";

export async function getSettings() {
  const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(stored)) {
    if (k in DEFAULTS && v !== "" && v !== undefined && v !== null) out[k] = v;
  }
  out.jira_base_url = normaliseBaseUrl(out.jira_base_url);
  out.jira_project = projectKey(out.jira_project);
  return out;
}

// "B2B Digital Revamp (BDR)" (the project as Jira displays it) -> "BDR"
export function projectKey(value) {
  const v = String(value || "").trim();
  const m = v.match(/\(([A-Za-z][A-Za-z0-9_]*)\)\s*$/);
  return (m ? m[1] : v).toUpperCase();
}

export async function saveSettings(values) {
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) if (k in values) clean[k] = values[k];
  clean.jira_base_url = normaliseBaseUrl(clean.jira_base_url || "");
  await chrome.storage.local.set({ [KEY]: clean });
  return getSettings();
}

export function normaliseBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function splitList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Jira rejects cookie-authenticated writes whose Origin header is not its own
// ("XSRF check failed"). Requests from the extension carry chrome-extension://,
// so rewrite Origin to the Jira origin for the extension's own requests only.
export async function syncOriginRule(baseUrl) {
  const origin = originOf(baseUrl);
  const update = { removeRuleIds: [1] };
  if (origin) {
    update.addRules = [{
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Origin", operation: "set", value: origin }],
      },
      condition: {
        urlFilter: `|${origin}/`,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest"],
      },
    }];
  }
  await chrome.declarativeNetRequest.updateDynamicRules(update);
}
