// Turns a reviewed defect draft into the Jira create payload, using the
// project's create screen (createmeta) to format each field. Port of
// jira_rest.create_defect / detect_custom_fields from the Python app.

// Names a field is commonly given on the Defect create screen, per settings key.
export const FIELD_NAMES = {
  field_for_project: ["For Project"],
  field_demo: ["Demo"],
  field_severity: ["Defect Severity", "Severity"],
  field_tcs_blocked: ["Test Cases Blocked", "TCs Blocked", "No. of Test Cases Blocked"],
  field_impacted_system: ["Impacted System", "Impacted Systems"],
  field_scenario: ["Scenario"],
  field_expected: ["Expected Result", "Expected Results", "Expected"],
  field_actual: ["Actual Result", "Actual Results", "Actual"],
  field_steps: ["Steps to Recreate", "Steps to Reproduce", "Steps"],
  field_qa_analysis: ["QA Analysis"],
  field_test_data: ["Test Data"],
  field_defect_type: ["Defect Type"],
  field_environment: ["Defect Environment", "Environment"],
  field_phase: ["Defect Phase", "Phase"],
  field_usability: ["Usability Issue", "Usability"],
  field_reoccurrence: ["Re-occurrence", "Reoccurrence", "Re-Occurrence"],
  field_newstack: ["NewStack Impact", "New Stack Impact"],
  field_category: ["Defect Category"],
  field_milestone: ["Milestone Type", "Milestone"],
  field_uat_priority: ["UAT Priority"],
};

const norm = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Matches the create screen's custom fields to field_* settings by name.
// Returns { found: { field_x: "customfield_123" }, unmatched: [field_x] }.
export function detectCustomFields(metaFields) {
  const byName = {};
  for (const [id, m] of Object.entries(metaFields)) {
    if (id.startsWith("customfield_")) byName[norm(m.name)] ??= id;
  }
  const found = {};
  const unmatched = [];
  for (const [key, names] of Object.entries(FIELD_NAMES)) {
    const id = names.map(norm).map((n) => byName[n]).find(Boolean);
    if (id) found[key] = id;
    else unmatched.push(key);
  }
  return { found, unmatched };
}

function matchOption(allowed, value) {
  const v = String(value).trim().toLowerCase();
  const opts = allowed || [];
  const label = (o, k) => String(o[k] ?? "");
  return opts.find((o) => ["value", "name", "key"].some((k) => label(o, k).trim().toLowerCase() === v))
    // "BDR Android" still finds "BDR-ANDROID"
    || opts.find((o) => ["value", "name"].some((k) => norm(label(o, k)) && norm(label(o, k)) === norm(value)))
    || null;
}

const optionLabels = (opts) => (opts || []).map((o) => o.value ?? o.name).filter(Boolean);

const splitComma = (v) => (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);

// Builds the REST value for one field from its schema and allowed values; null = can't be set.
export function formatValue(meta, value) {
  const schema = meta.schema || {};
  const type = schema.type;
  const custom = schema.custom || "";
  const allowed = meta.allowedValues;

  if (custom.includes("cascadingselect")) {
    const [parent, child] = value;
    const p = matchOption(allowed, parent);
    if (!p) throw new Error(`${meta.name || "Cascading field"}: "${parent}" (Settings → Defects → Defect type) is not one of: ${optionLabels(allowed).join(", ")}.`);
    const out = { id: p.id };
    // Jira needs both levels; a lone child option is unambiguous
    const c = child ? matchOption(p.children, child) : p.children?.length === 1 ? p.children[0] : null;
    if (c) out.child = { id: c.id };
    else if (p.children?.length) {
      const what = child ? `"${child}" is not one of` : "is empty. Pick one of";
      throw new Error(`${meta.name || "Cascading field"}: the second value (Settings → Defects → Filed against) ${what}: ${optionLabels(p.children).join(", ")}.`);
    }
    return out;
  }
  if (type === "array") {
    const items = splitComma(value);
    if (schema.items === "string") return items.map((i) => i.replace(/ /g, "_")); // labels
    if (allowed) return items.map((i) => matchOption(allowed, i)).filter(Boolean).map((m) => ({ id: m.id }));
    return items.map((name) => ({ name }));
  }
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "string" && !allowed) return String(value);
  if (type === "user") return { name: value };
  if (allowed) {
    const opt = matchOption(allowed, value);
    return opt ? { id: opt.id } : null;
  }
  if (type === "option") return { value };
  if (type === "priority") return { name: value };
  return value;
}

// Allowed values of a field (for pickers), or [] when it's free text.
export function optionsFor(metaFields, fieldId) {
  return optionLabels(metaFields?.[fieldId]?.allowedValues);
}

export function buildDescription(d) {
  return [
    ["Scenario", d.scenario],
    ["Steps to Recreate", d.steps],
    ["Expected Result", d.expected],
    ["Actual Result", d.actual],
    ["Test Data", d.test_data],
    ["QA Analysis", d.qa_analysis],
  ].filter(([, v]) => v && String(v).trim()).map(([h, v]) => `${h}:\n${String(v).trim()}`).join("\n\n");
}

export function applyTitlePattern(settings, { aiTitle, teKey, tcKey }) {
  let prefix = settings.defect_title_prefix || "";
  if (/[\w\])]$/.test(prefix)) prefix += " "; // "[SIT]" + "Crash" reads "[SIT] Crash"
  const pattern = settings.defect_title_pattern || "{AI_TITLE}";
  let title = pattern.includes("{AI_TITLE}")
    ? pattern.replaceAll("{PREFIX}", prefix).replaceAll("{TE_KEY}", teKey || "").replaceAll("{TC_KEY}", tcKey || "").replaceAll("{AI_TITLE}", aiTitle || "")
    : `${prefix}${aiTitle || ""}`;
  title = title.replace(/\s+/g, " ").trim();
  return prefix.trim() && !title.startsWith(prefix.trim()) ? `${prefix}${title}`.trim() : title;
}

// draft: { title, scenario, steps, expected, actual, test_data, qa_analysis, severity, assignee, blocked_tcs }
// Returns { fields, skipped: ["reason", ...] } ready for Jira.createIssue (assignee resolved separately).
export function buildDefectFields(settings, meta, draft) {
  const wanted = [
    ["field_for_project", settings.for_project],
    ["field_demo", settings.demo],
    ["components", settings.components],
    ["field_severity", draft.severity || settings.priority],
    ["field_tcs_blocked", draft.blocked_tcs ?? "1"],
    ["field_impacted_system", settings.impacted_system],
    ["field_scenario", draft.scenario],
    ["field_expected", draft.expected],
    ["field_actual", draft.actual],
    ["field_steps", draft.steps],
    ["field_test_data", draft.test_data],
    ["field_qa_analysis", draft.qa_analysis],
    ["field_defect_type", settings.defect_type ? [settings.defect_type, settings.filed_against] : ""],
    ["field_environment", settings.defect_environment],
    ["field_phase", settings.defect_phase],
    ["field_usability", settings.usability_issue],
    ["labels", settings.labels],
    ["field_reoccurrence", settings.re_occurrence],
    ["field_newstack", settings.newstack_impact],
    ["field_category", settings.defect_category],
    ["field_milestone", settings.milestone_type],
    ["field_uat_priority", settings.uat_priority],
  ];
  const fields = {
    project: { key: settings.jira_project },
    issuetype: { id: meta.typeId },
    summary: draft.title,
  };
  const description = buildDescription(draft);
  if (description && "description" in meta.fields) fields.description = description;

  const skipped = [];
  for (const [key, value] of wanted) {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    const id = key.startsWith("field_") ? settings[key] : key;
    if (!id) continue;
    if (!meta.fields[id]) {
      skipped.push(`${id} (not on the create screen)`);
      continue;
    }
    const formatted = formatValue(meta.fields[id], value);
    if (formatted === null || (Array.isArray(formatted) && !formatted.length)) {
      skipped.push(`${meta.fields[id].name || id} ("${Array.isArray(value) ? value.join(" / ") : value}" is not an allowed value)`);
      continue;
    }
    fields[id] = formatted;
  }
  const missing = Object.entries(meta.fields)
    .filter(([id, m]) => m.required && !m.hasDefaultValue && !(id in fields) && !["attachment", "issuelinks", "reporter", "assignee"].includes(id))
    .map(([id, m]) => {
      const key = Object.keys(FIELD_NAMES).find((k) => settings[k] === id);
      return `${m.name || id}${key ? "" : ` (${id}; set its ID in Settings → Advanced)`}`;
    });
  if (missing.length) throw new Error(`Jira requires these fields, but they have no value in Settings → Defects: ${missing.join(", ")}.`);
  return { fields, skipped };
}
