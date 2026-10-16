import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTitlePattern, buildDefectFields, buildDescription, detectCustomFields, formatValue } from "../lib/defect.js";
import { draftDefect } from "../lib/ai.js";

const SELECT = { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" };
const meta = {
  typeId: "42",
  fields: {
    summary: { schema: { type: "string" } },
    description: { schema: { type: "string" } },
    components: { schema: { type: "array", items: "component" }, allowedValues: [{ id: "10", name: "Android" }, { id: "11", name: "iOS" }] },
    labels: { schema: { type: "array", items: "string" } },
    assignee: { schema: { type: "user" } },
    customfield_1: { name: "Defect Severity", schema: SELECT, allowedValues: [{ id: "1", value: "1-Low" }, { id: "2", value: "2-Medium" }] },
    customfield_2: { name: "Scenario", schema: { type: "string" } },
    customfield_3: { name: "Test Cases Blocked", schema: { type: "number" } },
    customfield_4: { name: "Defect type", schema: { type: "option-with-child", custom: "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect" },
      allowedValues: [{ id: "41119", value: "B2B Digital Revamp", children: [{ id: "41813", value: "BDR-ANDROID" }] }] },
    customfield_5: { name: "Defect Environment", schema: SELECT, allowedValues: [{ id: "5", value: "Integration" }] },
  },
};

test("detects custom field IDs by name", () => {
  const { found, unmatched } = detectCustomFields(meta.fields);
  assert.equal(found.field_severity, "customfield_1");
  assert.equal(found.field_scenario, "customfield_2");
  assert.equal(found.field_tcs_blocked, "customfield_3");
  assert.equal(found.field_defect_type, "customfield_4");
  assert.equal(found.field_environment, "customfield_5");
  assert.ok(unmatched.includes("field_demo"));
});

test("formats values by field type", () => {
  assert.deepEqual(formatValue(meta.fields.customfield_1, "2-medium"), { id: "2" });
  assert.equal(formatValue(meta.fields.customfield_1, "9-Nope"), null);
  assert.deepEqual(formatValue(meta.fields.components, "iOS, Android"), [{ id: "11" }, { id: "10" }]);
  assert.deepEqual(formatValue(meta.fields.labels, "ui bug, sit"), ["ui_bug", "sit"]);
  assert.equal(formatValue(meta.fields.customfield_3, "2"), 2);
  assert.deepEqual(formatValue(meta.fields.customfield_4, ["B2B Digital Revamp", "BDR-ANDROID"]), { id: "41119", child: { id: "41813" } });
});

test("builds the create payload from settings and the draft, reporting what it skipped", () => {
  const settings = {
    jira_project: "BDR", components: "Android", labels: "auto ttb", priority: "1-Low",
    defect_type: "B2B Digital Revamp", filed_against: "BDR-ANDROID", defect_environment: "Production",
    field_severity: "customfield_1", field_scenario: "customfield_2", field_tcs_blocked: "customfield_3",
    field_defect_type: "customfield_4", field_environment: "customfield_5", field_demo: "customfield_99", demo: "Demo 1",
  };
  const draft = { title: "Login button does nothing", scenario: "Login", steps: "1. Tap login", expected: "Home", actual: "Nothing", severity: "2-Medium", blocked_tcs: "3" };
  const { fields, skipped } = buildDefectFields(settings, meta, draft);
  assert.deepEqual(fields.project, { key: "BDR" });
  assert.deepEqual(fields.issuetype, { id: "42" });
  assert.equal(fields.summary, "Login button does nothing");
  assert.match(fields.description, /^Scenario:\nLogin\n\nSteps to Recreate:\n1\. Tap login/);
  assert.deepEqual(fields.customfield_1, { id: "2" });
  assert.equal(fields.customfield_3, 3);
  assert.deepEqual(fields.customfield_4, { id: "41119", child: { id: "41813" } });
  assert.deepEqual(fields.components, [{ id: "10" }]);
  assert.deepEqual(fields.labels, ["auto_ttb"]);
  assert.ok(!("customfield_5" in fields));
  assert.ok(skipped.some((x) => x.includes("Production")));
  assert.ok(skipped.some((x) => x.includes("customfield_99")));
});

test("title pattern and description", () => {
  const s = { defect_title_prefix: "[BDR] ", defect_title_pattern: "{PREFIX}{TC_KEY} - {AI_TITLE}" };
  assert.equal(applyTitlePattern(s, { aiTitle: "Crash on login", tcKey: "BDR-2", teKey: "BDR-1" }), "[BDR] BDR-2 - Crash on login");
  assert.equal(applyTitlePattern({ defect_title_prefix: "X: " }, { aiTitle: "Crash" }), "X: Crash");
  assert.equal(applyTitlePattern({ defect_title_prefix: "[SIT]", defect_title_pattern: "{PREFIX}{AI_TITLE}" }, { aiTitle: "Crash" }), "[SIT] Crash");
  assert.equal(buildDescription({ scenario: "S", actual: " A " }), "Scenario:\nS\n\nActual Result:\nA");
});

test("Gemini draft: sends notes and images, parses the JSON answer", async () => {
  let sent;
  const fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "\"Login fails.\"", scenario: "S", steps: "1. a", expected: "E", actual: "A" }) }] } }] }) };
  };
  const out = await draftDefect({ apiKey: "k", model: "gemini-x", notes: "login broken", environment: "SIT", testCase: "BDR-2 Login",
    images: [{ category: "actual", mime: "image/jpeg", base64: "AAA" }] }, fetch);
  assert.deepEqual(out, { title: "Login fails", scenario: "S", steps: "1. a", expected: "E", actual: "A" });
  assert.match(sent.url, /models\/gemini-x:generateContent$/);
  assert.equal(sent.init.headers["x-goog-api-key"], "k");
  const parts = sent.body.contents[0].parts;
  assert.equal(parts[1].inline_data.data, "AAA");
  assert.match(parts.at(-1).text, /login broken/);
  assert.equal(sent.body.generationConfig.responseMimeType, "application/json");
});

test("Gemini errors are readable", async () => {
  await assert.rejects(draftDefect({ apiKey: "" }), /Gemini API key/);
  const fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "API key not valid" } }) });
  await assert.rejects(draftDefect({ apiKey: "k", notes: "x" }, fetch), /API key not valid/);
});

test("project key from the name Jira displays", async () => {
  const { projectKey } = await import("../lib/settings.js");
  assert.equal(projectKey("B2B Digital Revamp (BDR)"), "BDR");
  assert.equal(projectKey(" bdr "), "BDR");
  assert.equal(projectKey(""), "");
});

test("cascading field: loose child match, lone child, clear errors", () => {
  const f = meta.fields.customfield_4;
  assert.deepEqual(formatValue(f, ["B2B Digital Revamp", "bdr android"]), { id: "41119", child: { id: "41813" } });
  assert.deepEqual(formatValue(f, ["B2B Digital Revamp", ""]), { id: "41119", child: { id: "41813" } });
  const two = { ...f, allowedValues: [{ id: "1", value: "P", children: [{ id: "a", value: "A" }, { id: "b", value: "B" }] }] };
  assert.throws(() => formatValue(two, ["P", ""]), /Filed against\) is empty\. Pick one of: A, B/);
  assert.throws(() => formatValue(two, ["P", "C"]), /"C" is not one of: A, B/);
  assert.throws(() => formatValue(two, ["Q", "A"]), /"Q" .* is not one of: P/);
});

test("names required fields that have no value", () => {
  const m = { typeId: "1", fields: { summary: { required: true }, customfield_9: { name: "Defect Phase", required: true } } };
  assert.throws(() => buildDefectFields({ jira_project: "BDR", field_phase: "customfield_9" }, m, { title: "x" }), /no value in Settings → Defects: Defect Phase\./);
});

test("cascading field without listed options is sent by name", () => {
  const f = { name: "Defect Type", schema: { custom: "x:cascadingselect" }, allowedValues: [{ id: "1", value: "P" }] };
  assert.deepEqual(formatValue(f, ["P", "BDR-ANDROID"]), { id: "1", child: { value: "BDR-ANDROID" } });
  assert.throws(() => formatValue(f, ["P", ""]), /Filed against\) is empty\./);
  assert.deepEqual(formatValue({ ...f, allowedValues: undefined }, ["P", "C"]), { value: "P", child: { value: "C" } });
});

test("defect type field found by name even without its ID in Settings", () => {
  const { fields } = buildDefectFields({ jira_project: "BDR", defect_type: "B2B Digital Revamp", filed_against: "BDR-ANDROID" }, meta, { title: "x" });
  assert.deepEqual(fields.customfield_4, { id: "41119", child: { id: "41813" } });
  assert.throws(() => buildDefectFields({ jira_project: "BDR" }, meta, { title: "x" }), /needs both values/);
});

test("Mobily field names and option labels", () => {
  const m = { typeId: "1", fields: {
    customfield_7: { name: "Defect Type & Filed Against", schema: { custom: "x:cascadingselect" }, allowedValues: [{ id: "9", value: "B2B Digital Revamp", children: [{ id: "10", value: "BDR-ANDROID" }, { id: "11", value: "BDR-IOS" }] }] },
    customfield_8: { name: "Defect Severity", schema: { type: "option" }, allowedValues: [{ id: "2", value: "2-Medium" }] },
    customfield_9: { name: "BDR_EPIC", schema: { type: "option" }, allowedValues: [{ id: "3", value: "Font & Family Light Mode" }] },
  } };
  const s = { jira_project: "BDR", defect_type: "B2B Digital Revamp", filed_against: "BDR-IOS", epic: "font & family light mode", field_defect_type: "customfield_999" };
  const { fields } = buildDefectFields(s, m, { title: "x", severity: "Medium" });
  assert.deepEqual(fields.customfield_7, { id: "9", child: { id: "11" } });
  assert.deepEqual(fields.customfield_8, { id: "2" });
  assert.deepEqual(fields.customfield_9, { id: "3" });
});
