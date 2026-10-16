// Settings live in chrome.storage.local under one key and are edited on the options page.

export const DEFAULTS = {
  jira_base_url: "",
  comment_evidence: false,
  environments: "SIT, UAT, PP, Prod",
  languages: "English, Arabic",
};

const KEY = "settings";

export async function getSettings() {
  const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(stored)) {
    if (k in DEFAULTS && v !== "" && v !== undefined && v !== null) out[k] = v;
  }
  out.jira_base_url = normaliseBaseUrl(out.jira_base_url);
  return out;
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
