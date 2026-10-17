import { getSettings, splitList } from "./lib/settings.js";
import { Jira, parseIssueKey } from "./lib/jira.js";
import * as store from "./lib/store.js";
import { buildPotBlob } from "./lib/pot.js";
import { draftDefect } from "./lib/ai.js";
import { applyTitlePattern, buildDefectFields, metaFieldFor, optionsFor } from "./lib/defect.js";
import { addStep, describeStep, keyEventParams, keysSeen, playStep, recorderMain, recorderStop } from "./lib/recorder.js";

const $ = (id) => document.getElementById(id);
const STATUSES = { pending: "Pending", executing: "Executing", pass: "Passed", fail: "Failed", blocked: "Blocked" };
const CATEGORIES = { expected: "Expected", actual: "Actual" };
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const TO_XRAY = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", executing: "EXECUTING", pending: "TODO" };
const FROM_XRAY = { PASS: "pass", FAIL: "fail", BLOCKED: "blocked", EXECUTING: "executing" };

const state = {
  settings: null,
  te: null, // the loaded TE record
  shots: [], // screenshots of the loaded TE
  openTc: null, // key of the expanded test case
  pasteTarget: "actual", // screenshot category Ctrl+V pastes into
  urls: [], // object URLs to revoke on re-render
  busy: false,
  defectOpen: null, // key of the test case whose defect editor is open
  meta: null, // Defect create screen from Jira, loaded on first use
  duplicates: {}, // tc key -> [{ key, summary, status }]
  filter: "", // status the test case list is narrowed to ("" = all)
  rec: null, // { tabId, actionId } while recording
  playing: null, // { actionId, step } while an action runs
  actions: [], // saved recordings
  openAction: null, // id of the action whose steps are shown
  actionsOpen: false, // Actions box expanded
};

// --- Small DOM helper ------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  t.title = kind === "error" ? "Click to close" : "";
  // Errors stay until clicked so they can be read and copied
  if (kind !== "error") toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

async function busy(label, fn) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add("busy");
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), "error");
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
  }
}

function jira() {
  return new Jira(state.settings.jira_base_url);
}

// --- Jira connection -------------------------------------------------------

async function checkJira() {
  const pill = $("jira-status");
  if (!state.settings.jira_base_url) {
    pill.textContent = "Set up Jira";
    pill.className = "pill warn";
    pill.onclick = () => chrome.runtime.openOptionsPage();
    return;
  }
  pill.onclick = null;
  try {
    const me = await jira().myself();
    pill.textContent = `✓ ${me.displayName || me.name}`;
    pill.className = "pill ok";
    pill.title = `Connected to ${state.settings.jira_base_url}`;
  } catch (e) {
    pill.textContent = e.status === 401 ? "⚠ Log in to Jira" : "⚠ Jira unreachable";
    pill.className = "pill warn";
    pill.title = e.message;
    pill.onclick = () => chrome.tabs.create({ url: state.settings.jira_base_url });
  }
}

// --- Test executions -------------------------------------------------------

async function refreshTeList() {
  const tes = await store.listTes();
  const sel = $("te-select");
  sel.replaceChildren(
    h("option", { value: "" }, tes.length ? "Saved test executions…" : ""),
    ...tes.map((te) => h("option", { value: te.te_key, selected: te.te_key === state.te?.te_key }, `${te.te_key} ${te.summary || ""}`.trim())),
  );
  sel.hidden = !tes.length;
}

async function openTe(teKey) {
  state.te = await store.getTe(teKey);
  // Recordings made on a test case (version 0.5) become named actions
  const recorded = (state.te?.test_cases || []).filter((tc) => tc.recording);
  for (const tc of recorded) {
    if (tc.recording.steps?.length > 1) {
      state.actions.push({ id: crypto.randomUUID(), name: `${tc.key} ${tc.summary || ""}`.trim().slice(0, 60), steps: tc.recording.steps, created_at: tc.recording.recorded_at });
    }
    delete tc.recording;
  }
  if (recorded.length) {
    await saveActions();
    await store.saveTe(state.te);
  }
  state.shots = state.te ? await store.shotsForTe(teKey) : [];
  state.openTc = null;
  state.defectOpen = null;
  state.duplicates = {};
  state.filter = "";
  await chrome.storage.local.set({ lastTe: teKey });
  render();
  refreshTeList();
}

// Pulls the test case list from Jira and merges it into the saved TE, keeping
// statuses, notes and screenshots of test cases already there.
async function loadFromJira(teKey) {
  const fetched = await jira().fetchTestExecution(teKey);
  const existing = (await store.getTe(fetched.te_key)) || {
    te_key: fetched.te_key,
    environment: splitList(state.settings.environments)[0] || "",
    language: splitList(state.settings.languages)[0] || "",
    test_cases: [],
  };
  const byKey = new Map(existing.test_cases.map((tc) => [tc.key, tc]));
  for (const tc of fetched.test_cases) {
    let item = byKey.get(tc.key);
    if (!item) byKey.set(tc.key, (item = { key: tc.key, status: "pending" }));
    item.summary = tc.summary || item.summary || "";
    if (tc.run_id) item.run_id = tc.run_id;
    // A result already recorded in Xray shows up here unless set locally
    const xrayStatus = FROM_XRAY[tc.xray_status];
    if (xrayStatus && item.status === "pending") item.status = xrayStatus;
  }
  Object.assign(existing, { summary: fetched.summary, url: fetched.url, xray: fetched.xray, xray_error: fetched.xray_error, test_cases: [...byKey.values()] });
  await store.saveTe(existing);
  if (!fetched.test_cases.length) toast(`${fetched.te_key} has no linked test cases in Jira. Add them below.`, "error");
  else toast(`Loaded ${fetched.test_cases.length} test cases from ${fetched.te_key}.`);
  await openTe(existing.te_key);
}

async function saveTe() {
  await store.saveTe(state.te);
}

function tcByKey(key) {
  return state.te.test_cases.find((tc) => tc.key === key);
}

// --- Screenshots -----------------------------------------------------------

async function addShots(tcKey, category, blobs) {
  for (const blob of blobs) {
    if (!blob.type.startsWith("image/")) continue;
    const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const name = `${tcKey}_${category}_${Date.now()}.${ext}`;
    state.shots.push(await store.addShot({ te_key: state.te.te_key, tc_key: tcKey, category, name, blob }));
  }
  state.openTc = tcKey;
  render();
}

async function deleteShot(id) {
  await store.deleteShot(id);
  state.shots = state.shots.filter((s) => s.id !== id);
  render();
}

// --- Pass / fail -----------------------------------------------------------

async function setStatus(tcKey, status) {
  const tc = tcByKey(tcKey);
  if (status === "fail" && !tc.defect_key) state.defectOpen = tcKey;
  tc.status = status;
  tc.updated_at = new Date().toISOString();
  await saveTe();
  render();

  const label = STATUSES[status].toLowerCase();
  if (!ISSUE_KEY.test(tcKey)) {
    toast(`${tcKey} marked ${label}.`);
    return;
  }
  const done = [];
  try {
    // Xray keeps the result on the test run inside the execution
    tc.run_id = await jira().setTestRunStatus(state.te.te_key, tcKey, TO_XRAY[status], tc.run_id);
    await saveTe();
    done.push(`Xray run set to ${TO_XRAY[status]}`);
    if (state.settings.comment_evidence && ["pass", "fail"].includes(status)) {
      const evidence = state.shots.filter((s) => s.tc_key === tcKey && s.category === "actual");
      const text = [`Test ${label}${state.te.environment ? ` on ${state.te.environment}` : ""}.`, tc.note].filter(Boolean).join("\n");
      await jira().comment(tcKey, text, evidence.map((s) => ({ name: s.name, blob: s.blob })));
      done.push("evidence commented");
    }
    toast(done.length ? `${tcKey} marked ${label}: ${done.join(", ")}.` : `${tcKey} marked ${label}.`);
  } catch (e) {
    const partial = done.length ? ` (${done.join(", ")})` : "";
    toast(`${tcKey} marked ${label} here, but Jira was not fully updated${partial}: ${e.message}`, "error");
  }
}


// --- Defects ---------------------------------------------------------------

const DRAFT_FIELDS = [
  ["title", "Title", "input"],
  ["scenario", "Scenario", 2],
  ["steps", "Steps to recreate", 4],
  ["expected", "Expected result", 2],
  ["actual", "Actual result", 2],
  ["test_data", "Test data", 1],
  ["qa_analysis", "QA analysis", 1],
];

function draftOf(tc) {
  tc.draft ??= { notes: tc.note || "", severity: state.settings.priority || "", assignee: state.settings.assignee || "", blocked_tcs: "1" };
  return tc.draft;
}

async function loadMeta() {
  if (state.meta) return state.meta;
  if (!state.settings.jira_project) throw new Error("Set the Jira project key under Defects in Settings.");
  state.meta = await jira().createMeta(state.settings.jira_project, state.settings.defect_issue_type || "Defect");
  return state.meta;
}

async function imagesForAi(tcKey) {
  if (!state.settings.share_screenshots_with_ai) return [];
  const out = [];
  for (const shot of state.shots.filter((s) => s.tc_key === tcKey)) {
    // Downscale big screenshots: smaller requests, same information for the model
    const bitmap = await createImageBitmap(shot.blob);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out.push({ category: shot.category, mime: "image/jpeg", base64: btoa(bin) });
  }
  return out;
}

async function draftWithAi(tc) {
  const d = draftOf(tc);
  const ai = await draftDefect({
    apiKey: state.settings.gemini_api_key,
    model: state.settings.gemini_model,
    notes: d.notes,
    environment: state.settings.defect_environment || state.te.environment,
    testCase: `${tc.key} ${tc.summary || ""}`.trim(),
    images: await imagesForAi(tc.key),
  });
  Object.assign(d, ai, { title: applyTitlePattern(state.settings, { aiTitle: ai.title, teKey: state.te.te_key, tcKey: tc.key }) });
  await saveTe();
  render();
  toast("Draft ready. Review it, then create it or add it to the queue.");
}

async function findDuplicates(tc) {
  const d = draftOf(tc);
  const words = [...new Set(`${d.title || ""} ${d.notes || ""}`.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [])].slice(0, 6);
  if (!words.length) throw new Error("Write a title or notes first.");
  const project = state.settings.jira_project;
  if (!project) throw new Error("Set the Jira project key under Defects in Settings.");
  const type = (state.settings.defect_issue_type || "Defect").replace(/"/g, "");
  const text = words.map((w) => `summary ~ "${w.replace(/"/g, "")}"`).join(" OR ");
  const jql = `project = "${project}" AND issuetype = "${type}" AND statusCategory != Done AND (${text}) ORDER BY updated DESC`;
  const issues = await jira().search(jql, "summary,status", 8);
  state.duplicates[tc.key] = issues.map((i) => ({ key: i.key, summary: i.fields?.summary || "", status: i.fields?.status?.name || "" }));
  render();
  if (!issues.length) toast("No open defects look similar.");
}

// Links the defect to the Xray run and marks the test failed there.
async function attachDefectToRun(tc, defectKey) {
  const j = jira();
  tc.run_id ||= await j.testRunId(state.te.te_key, tc.key);
  if (tc.status !== "fail") {
    await j.setTestRunStatus(state.te.te_key, tc.key, "FAIL", tc.run_id);
    tc.status = "fail";
  }
  await j.addDefectToTestRun(tc.run_id, defectKey);
}

async function useExistingDefect(tc, key) {
  tc.defect_key = key;
  const warnings = [];
  try {
    await attachDefectToRun(tc, key);
  } catch (e) {
    warnings.push(`not added to the Xray run: ${e.message}`);
  }
  delete tc.draft;
  delete state.duplicates[tc.key];
  state.defectOpen = null;
  await saveTe();
  render();
  toast(`${tc.key} linked to ${key}${warnings.length ? `, but ${warnings.join("; ")}` : "."}`, warnings.length ? "error" : "ok");
}

// Creates the defect in Jira from the reviewed draft. Returns the new key.
async function createDefect(tc) {
  const d = draftOf(tc);
  if (!d.title?.trim()) throw new Error(`${tc.key}: the defect needs a title.`);
  const j = jira();
  const meta = await loadMeta();
  const { fields, skipped } = buildDefectFields(state.settings, meta, d);
  const assignee = d.assignee || state.settings.assignee;
  if (assignee && meta.fields.assignee) {
    const name = await j.findUser(assignee);
    if (name) fields.assignee = { name };
    else skipped.push(`assignee ("${assignee}" not found)`);
  }
  const { key, dropped } = await j.createIssue(fields);
  const warnings = [...skipped, ...dropped.map((f) => `${f} rejected`)];

  tc.defect_key = key;
  delete tc.draft;
  delete state.duplicates[tc.key];
  await saveTe();

  try {
    await j.linkIssues(key, tc.key);
  } catch (e) {
    warnings.push(`not linked to ${tc.key}: ${e.message}`);
  }
  const shots = state.shots.filter((s) => s.tc_key === tc.key);
  try {
    await j.attach(key, shots.map((s) => ({ name: s.name, blob: s.blob })));
  } catch (e) {
    warnings.push(`screenshots not attached: ${e.message}`);
  }
  try {
    await attachDefectToRun(tc, key);
  } catch (e) {
    warnings.push(`not added to the Xray run: ${e.message}`);
  }
  await saveTe();
  if (state.defectOpen === tc.key) state.defectOpen = null;
  render();
  toast(`${key} created for ${tc.key}${warnings.length ? `. Check in Jira: ${warnings.join("; ")}` : "."}`, warnings.length ? "error" : "ok");
  return key;
}

async function submitQueue() {
  const queued = state.te.test_cases.filter((tc) => tc.draft?.queued);
  const created = [];
  for (const tc of queued) {
    toast(`Creating defect ${created.length + 1} of ${queued.length} (${tc.key})…`);
    try {
      created.push(await createDefect(tc));
    } catch (e) {
      toast(`Stopped at ${tc.key}: ${e.message}${created.length ? ` (created ${created.join(", ")})` : ""}`, "error");
      return;
    }
  }
  toast(`Created ${created.join(", ")}.`);
}

function defectEditor(tc) {
  const d = draftOf(tc);
  const save = async () => { d.updated_at = new Date().toISOString(); await saveTe(); };
  const bind = (key, el) => {
    el.addEventListener("change", async () => { d[key] = el.value; await save(); });
    return el;
  };
  const severityOptions = state.meta ? optionsFor(metaFieldFor(state.meta, "field_severity")) : [];
  const severity = severityOptions.length
    ? bind("severity", h("select", {}, h("option", { value: "" }, "—"), severityOptions.map((o) => h("option", { value: o, selected: o === d.severity }, o))))
    : bind("severity", h("input", { value: d.severity || "" }));
  const dups = state.duplicates[tc.key];

  return h("section", { class: "defect" },
    h("div", { class: "row between" }, h("strong", {}, "Defect"), h("button", { class: "link", onclick: () => { state.defectOpen = null; render(); } }, "Close")),
    h("label", {}, "What went wrong?", bind("notes", h("textarea", { rows: 2, value: d.notes || "", placeholder: "Short notes; the AI writes the rest from these and the screenshots" }))),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: () => busy("ai", () => draftWithAi(tc)) }, "Draft with AI"),
      h("small", { class: "muted" }, state.settings.share_screenshots_with_ai ? "Sends notes and this test case's screenshots to Gemini" : "Sends notes only"),
    ),
    DRAFT_FIELDS.map(([key, label, rows]) => h("label", {}, label,
      bind(key, rows === "input" ? h("input", { value: d[key] || "" }) : h("textarea", { rows, value: d[key] || "" })))),
    h("div", { class: "row grid3" },
      h("label", {}, "Severity", severity),
      h("label", {}, "Assignee", bind("assignee", h("input", { value: d.assignee || "" }))),
      h("label", {}, "TCs blocked", bind("blocked_tcs", h("input", { type: "number", min: 0, value: d.blocked_tcs ?? "1" }))),
    ),
    dups ? h("div", { class: "dups" },
      h("strong", {}, dups.length ? "Possible duplicates" : "No similar open defects"),
      dups.map((x) => h("div", { class: "row between" },
        h("span", {}, h("a", { href: jira().issueUrl(x.key), target: "_blank" }, x.key), ` ${x.summary} `, h("small", { class: "muted" }, x.status)),
        h("button", { class: "link", onclick: () => busy("link", () => useExistingDefect(tc, x.key)) }, "Use this"),
      )),
    ) : null,
    h("div", { class: "row actions" },
      h("button", { class: "fail", onclick: () => busy("create", () => createDefect(tc)) }, "Create in Jira"),
      h("button", { onclick: async () => { d.queued = !d.queued; await save(); render(); toast(d.queued ? `${tc.key} added to the queue.` : `${tc.key} removed from the queue.`); } }, d.queued ? "Remove from queue" : "Add to queue"),
      h("button", { onclick: () => busy("dups", () => findDuplicates(tc)) }, "Check duplicates"),
      h("button", { class: "link danger", onclick: async () => { if (!confirm("Discard this defect draft?")) return; delete tc.draft; state.defectOpen = null; await saveTe(); render(); } }, "Discard"),
    ),
  );
}

// --- Recorder --------------------------------------------------------------

const ALL_SITES = { origins: ["<all_urls>"] }; // screenshots without a toolbar click need <all_urls>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recording and replaying need access to the site under test. Must be called
// first thing in a click handler: Chrome only shows the prompt for a user gesture.
function askForSites() {
  return chrome.permissions.request(ALL_SITES).then((ok) => {
    if (!ok) throw new Error("Recording needs Chrome's permission to read and change the pages you test.");
  });
}

async function activeTab(needPage = true) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No browser tab to use.");
  if (needPage && !/^https?:/.test(tab.url || "")) throw new Error("Open the page you want to test in the current tab first (an http or https page).");
  return tab;
}

// Screenshot of a given tab: brings it to the front first, since Chrome captures what's visible.
async function shootTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(150);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return (await fetch(dataUrl)).blob();
}

async function inject(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

// Recordings are named actions, kept apart from test executions so any of them
// can be run on any page. Stored as [{ id, name, steps, here, created_at }].

async function saveActions() {
  await chrome.storage.local.set({ actions: state.actions });
}

const actionById = (id) => state.actions.find((a) => a.id === id);

async function startRecording(name, granted) {
  await granted;
  const tab = await activeTab();
  await inject(tab.id, recorderMain);
  const action = { id: crypto.randomUUID(), name, steps: [{ type: "open", url: tab.url }], created_at: new Date().toISOString() };
  state.actions.unshift(action);
  state.rec = { tabId: tab.id, actionId: action.id };
  state.openAction = action.id;
  await saveActions();
  render();
  toast(`Recording "${name}". Click and type in the page, add checkpoints for screenshots, then Stop.`);
}

async function stopRecording() {
  const { tabId } = state.rec;
  await inject(tabId, recorderStop).catch(() => {}); // the tab may be gone; flushes a field still being typed in
  await sleep(200);
  state.rec = null;
  await saveActions();
  render();
}

async function recordStep(step) {
  const action = actionById(state.rec?.actionId);
  if (!action) return;
  addStep(action.steps, step);
  await saveActions();
  render();
}

// Screenshots from a checkpoint or a run go to the open test case, if there is one.
const shotTarget = () => (state.te && state.openTc && tcByKey(state.openTc) ? state.openTc : null);

async function checkpoint() {
  await recordStep({ type: "shot", category: "actual" });
  const tcKey = shotTarget();
  if (!tcKey) return toast("Checkpoint added. Open a test case to keep the screenshots when the action runs.");
  await addShots(tcKey, "actual", [await shootTab(await chrome.tabs.get(state.rec.tabId))]);
  toast(`Checkpoint added; screenshot taken into ${tcKey} Actual.`);
}

async function waitForLoad(tabId, timeoutMs = 20000) {
  await sleep(300); // let a navigation start
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(200)) {
    if ((await chrome.tabs.get(tabId)).status === "complete") return;
  }
}

// Real input: Chrome's debugger protocol sends trusted mouse and key events, which
// apps (and BrowserStack's device stream) treat exactly like a person's.
function realInput(tabId) {
  const target = { tabId };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  return {
    attach: () => chrome.debugger.attach(target, "1.3"),
    detach: () => chrome.debugger.detach(target).catch(() => {}),
    async click(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    async key(step) {
      for (const params of keyEventParams(step)) await send("Input.dispatchKeyEvent", params);
    },
    async type(text, typingMs) {
      for (const ch of text) {
        if (ch === "\n") await this.key({ key: "Enter" });
        else {
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        }
        if (typingMs) await sleep(typingMs);
      }
    },
  };
}

const seconds = (v, fallback) => (v === "" || v === undefined || v === null || Number.isNaN(Number(v)) ? fallback : Number(v));

async function runAction(action, granted) {
  await granted;
  const steps = action.steps;
  const tab = await activeTab(!!action.here);
  const tcKey = shotTarget();
  const pause = seconds(state.settings.replay_pause, 0.5);
  const typingMs = seconds(state.settings.typing_ms, 60);
  let real = null;
  if (state.settings.real_input) {
    real = realInput(tab.id);
    try {
      await real.attach();
    } catch (e) {
      real = null;
      toast(`Real input isn't available (${e.message}); running with page events instead.`, "error");
    }
  }
  let shots = 0;
  let skipped = 0;
  try {
    for (const [i, step] of steps.entries()) {
      state.playing = { actionId: action.id, step: i };
      render();
      if (i > 0) await sleep(seconds(step.wait, pause) * 1000);
      if (step.type === "open") {
        if (action.here) continue; // run on whatever page is open
        await chrome.tabs.update(tab.id, { url: step.url, active: true });
        await waitForLoad(tab.id);
      } else if (step.type === "page") {
        await waitForLoad(tab.id);
      } else if (step.type === "shot") {
        await waitForLoad(tab.id);
        if (!tcKey) {
          skipped++;
          continue;
        }
        await sleep(300); // let animations settle
        await addShots(tcKey, step.category || "actual", [await shootTab(tab)]);
        shots++;
      } else {
        await waitForLoad(tab.id);
        const viaPage = !real || (step.type === "input" && step.tag === "select");
        const res = await inject(tab.id, playStep, [step, { timeoutMs: 8000, typingMs, locate: !viaPage }]);
        if (!res?.ok) throw new Error(`"${action.name}" stopped at step ${i + 1} (${describeStep(step)}): ${res?.why || "the page didn't respond"}.`);
        if (!viaPage) {
          if (step.type === "click") await real.click(res.x, res.y);
          else if (step.type === "key") await real.key(step);
          else {
            await real.type(String(step.type === "input" ? step.value : step.text), typingMs);
            // Some fields ignore the debugger's keys; if nothing changed, type with page events
            if (res.field && (await inject(tab.id, keysSeen)) === 0) {
              await inject(tab.id, playStep, [step, { timeoutMs: 2000, typingMs }]);
            }
          }
        }
      }
    }
  } finally {
    await real?.detach();
    state.playing = null;
    render();
  }
  const plural = (n) => `${n} screenshot${n > 1 ? "s" : ""}`;
  toast(`Ran "${action.name}"${shots ? `, ${plural(shots)} into ${tcKey} Actual` : ""}${skipped ? `; ${plural(skipped)} skipped, open a test case to keep them` : ""}.`);
}

function stepList(action) {
  const playing = state.playing?.actionId === action.id;
  const recording = state.rec?.actionId === action.id;
  return h("ol", { class: "steps" }, action.steps.map((step, i) => h("li", { class: playing && state.playing.step === i ? "now" : null },
    h("span", { class: "num" }, `${i + 1}.`),
    h("span", { class: "grow", title: describeStep(step) }, describeStep(step)),
    i === 0 ? null : h("input", {
      class: "wait", type: "number", min: 0, step: 0.5, value: step.wait ?? "", placeholder: `${seconds(state.settings.replay_pause, 0.5)}s`,
      title: "Seconds to wait before this step (blank: the default pause from Settings)",
      onchange: async (e) => { const v = e.target.value.trim(); if (v === "") delete step.wait; else step.wait = Math.max(0, Number(v)); await saveActions(); },
    }),
    recording || playing || i === 0 ? null : h("button", {
      class: "icon", title: "Remove step", onclick: async () => { action.steps.splice(i, 1); await saveActions(); render(); },
    }, "×"))));
}

function actionItem(action) {
  const open = state.openAction === action.id;
  const playing = state.playing?.actionId === action.id;
  const busyElsewhere = !!(state.rec || state.playing);
  return h("div", { class: `action${open ? " open" : ""}` },
    h("div", { class: "row" },
      h("button", { class: "link grow action-name", title: "Show steps", onclick: () => { state.openAction = open ? null : action.id; render(); } },
        `${open ? "▾" : "▸"} ${action.name}`, h("span", { class: "muted" }, ` · ${action.steps.length} steps`)),
      h("button", {
        class: "small primary", disabled: busyElsewhere,
        onclick: () => { const granted = askForSites(); busy("run", () => runAction(action, granted)); },
      }, playing ? "Running…" : "▶ Run")),
    open ? h("div", { class: "action-body" },
      stepList(action),
      h("label", { class: "check" },
        h("input", { type: "checkbox", checked: !!action.here, onchange: async (e) => { action.here = e.target.checked; await saveActions(); } }),
        "Run on the page that's open (don't go to the start page first)"),
      h("div", { class: "row" },
        h("button", {
          class: "link", onclick: async () => {
            const name = prompt("Action name", action.name)?.trim();
            if (!name) return;
            action.name = name;
            await saveActions();
            render();
          },
        }, "Rename"),
        h("span", { class: "grow" }),
        h("button", {
          class: "link danger", disabled: busyElsewhere, onclick: async () => {
            if (!confirm(`Delete the action "${action.name}"?`)) return;
            state.actions = state.actions.filter((a) => a.id !== action.id);
            await saveActions();
            render();
          },
        }, "Delete")),
    ) : null,
  );
}

function renderActions() {
  const box = $("actions");
  const recording = state.rec && actionById(state.rec.actionId);
  if (recording) {
    box.replaceChildren(h("section", { class: "recorder recording" },
      h("div", { class: "row" },
        h("strong", { class: "grow" }, h("span", { class: "rec-dot" }), ` Recording "${recording.name}" · ${recording.steps.length} steps`),
        h("button", { class: "small", onclick: () => busy("checkpoint", checkpoint) }, "📷 Checkpoint"),
        h("button", { class: "small primary", onclick: () => busy("stop", stopRecording) }, "Stop")),
      stepList(recording)));
    return;
  }
  const name = h("input", { placeholder: "New action name, e.g. Log in as AP user", class: "grow" });
  const record = (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) return toast("Give the action a name first.", "error");
    const granted = askForSites();
    busy("record", () => startRecording(n, granted));
  };
  box.replaceChildren(h("details", { class: "recorder actions-box", open: state.actionsOpen },
    h("summary", { onclick: (e) => { e.preventDefault(); state.actionsOpen = !state.actionsOpen; render(); } },
      h("strong", {}, "Actions"), h("span", { class: "muted" }, ` ${state.actions.length || ""}`)),
    h("form", { class: "row", onsubmit: record }, name, h("button", { class: "small", disabled: !!state.playing }, "● Record")),
    state.actions.length ? h("div", { class: "action-list" }, state.actions.map(actionItem))
      : h("small", { class: "muted" }, "Record clicks and typing once, then run them on any page. Checkpoint screenshots go to the open test case."),
  ));
}

// --- PoT export ------------------------------------------------------------

const DOCX_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp" };

async function shotForDoc(shot) {
  const bitmap = await createImageBitmap(shot.blob);
  let blob = shot.blob;
  let type = DOCX_TYPES[blob.type];
  if (!type) { // e.g. WebP: Word can't embed it, so convert to PNG
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    blob = await canvas.convertToBlob({ type: "image/png" });
    type = "png";
  }
  return { tc_key: shot.tc_key, category: shot.category, type, width: bitmap.width, height: bitmap.height, data: new Uint8Array(await blob.arrayBuffer()) };
}

async function exportPot() {
  const shots = await Promise.all(state.shots.map(shotForDoc));
  const blob = await buildPotBlob(state.te, shots);
  const url = URL.createObjectURL(blob);
  h("a", { href: url, download: `PoT_${state.te.te_key}.docx` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`PoT_${state.te.te_key}.docx downloaded.`);
}

// --- Rendering -------------------------------------------------------------

function thumb(shot) {
  const url = URL.createObjectURL(shot.blob);
  state.urls.push(url);
  return h("figure", { class: "thumb" },
    h("img", { src: url, alt: shot.name, title: "Open full size", onclick: () => window.open(url) }),
    h("button", { class: "icon remove", title: "Remove", onclick: () => deleteShot(shot.id) }, "×"),
  );
}

function shotSection(tc, category) {
  const shots = state.shots.filter((s) => s.tc_key === tc.key && s.category === category);
  const fileInput = h("input", {
    type: "file", accept: "image/*", multiple: true, hidden: true,
    onchange: (e) => busy("upload", () => addShots(tc.key, category, [...e.target.files])),
  });
  const active = state.pasteTarget === category;
  return h("section", { class: `shots${active ? " paste-target" : ""}`, onclick: () => { if (state.pasteTarget !== category) { state.pasteTarget = category; render(); } } },
    h("div", { class: "row between" },
      h("strong", {}, CATEGORIES[category], h("span", { class: "muted" }, ` ${shots.length}`)),
      h("span", { class: "row" },
        h("button", { class: "small", onclick: () => fileInput.click() }, "Upload"),
        fileInput,
      ),
    ),
    shots.length ? h("div", { class: "thumbs" }, shots.map(thumb)) : null,
    h("small", { class: "muted hint" }, active ? "Ctrl+V pastes here" : "Click to paste here"),
  );
}

function tcItem(tc) {
  const open = state.openTc === tc.key;
  const counts = state.shots.filter((s) => s.tc_key === tc.key).length;
  // One test case open at a time, switched synchronously so no other stays open
  const header = h("summary", { onclick: (e) => { e.preventDefault(); state.openTc = open ? null : tc.key; render(); } },
    h("span", { class: `dot ${tc.status}`, title: STATUSES[tc.status] }),
    h("span", { class: "tc-text" },
      h("span", { class: "key" }, tc.key),
      tc.summary ? h("span", { class: "summary", title: tc.summary }, tc.summary) : null),
    tc.defect_key ? h("span", { class: "badge fail", title: "Linked defect" }, tc.defect_key) : null,
    tc.draft?.queued ? h("span", { class: "badge", title: "Defect draft queued" }, "draft") : null,
    counts ? h("span", { class: "badge", title: "Screenshots" }, `📷 ${counts}`) : null,
  );
  const details = h("details", { class: "tc", open }, header);
  if (!open) return details;

  // append() would print null as text, so drop the empty slots
  const statusButton = (status, label) => h("button", {
    class: `seg seg-${status}${tc.status === status ? " current" : ""}`,
    onclick: () => busy(status, () => setStatus(tc.key, status)),
  }, label);
  details.append(...[
    h("div", { class: "segmented" },
      statusButton("pass", "Pass"), statusButton("fail", "Fail"), statusButton("blocked", "Blocked"), statusButton("executing", "Executing")),
    shotSection(tc, "expected"),
    shotSection(tc, "actual"),
    h("label", {}, "Note",
      h("textarea", { rows: 2, value: tc.note || "", onchange: async (e) => { tc.note = e.target.value.trim(); await saveTe(); } })),
    h("label", {}, "Linked defect",
      h("div", { class: "row" },
        h("input", { value: tc.defect_key || "", placeholder: "e.g. ABC-123", class: "grow", onchange: async (e) => { tc.defect_key = parseIssueKey(e.target.value) || e.target.value.trim(); await saveTe(); render(); } }),
        tc.defect_key && ISSUE_KEY.test(tc.defect_key) ? h("a", { href: jira().issueUrl(tc.defect_key), target: "_blank" }, "Open ↗") : null,
        !tc.defect_key && state.defectOpen !== tc.key
          ? h("button", { onclick: () => { state.defectOpen = tc.key; render(); } }, tc.draft ? "Edit draft" : "Report defect")
          : null)),
    h("div", { class: "row tc-foot" },
      ISSUE_KEY.test(tc.key) ? h("a", { href: jira().issueUrl(tc.key), target: "_blank" }, "Open in Jira ↗") : null,
      h("span", { class: "grow" }),
      tc.status !== "pending" ? h("button", { class: "link", onclick: () => busy("reset", () => setStatus(tc.key, "pending")) }, "Reset status") : null,
      h("button", {
        class: "link danger", onclick: async () => {
          if (!confirm(`Remove ${tc.key} and its screenshots from this execution?`)) return;
          for (const s of state.shots.filter((x) => x.tc_key === tc.key)) await store.deleteShot(s.id);
          state.shots = state.shots.filter((x) => x.tc_key !== tc.key);
          state.te.test_cases = state.te.test_cases.filter((x) => x.key !== tc.key);
          await saveTe();
          render();
        },
      }, "Remove"),
    ),
    state.defectOpen === tc.key ? defectEditor(tc) : null,
  ].filter(Boolean));
  return details;
}

function selectFor(field, options) {
  const values = [...new Set([...options, state.te[field]].filter(Boolean))];
  return h("select", { onchange: async (e) => { state.te[field] = e.target.value; await saveTe(); } },
    values.map((v) => h("option", { value: v, selected: v === state.te[field] }, v)));
}

function render() {
  state.urls.forEach(URL.revokeObjectURL);
  state.urls = [];
  renderActions();
  const main = $("te");
  const te = state.te;
  if (!te) {
    main.replaceChildren(h("p", { class: "muted empty" }, "Load a test execution from Jira to start."));
    return;
  }
  const count = (s) => te.test_cases.filter((tc) => tc.status === s).length;
  const queued = te.test_cases.filter((tc) => tc.draft?.queued);
  // The defect editor shows the create screen's severity options once they're loaded
  if (state.defectOpen && !state.meta && !state.metaLoading && state.settings.jira_project) {
    state.metaLoading = true;
    loadMeta().then(render, () => {}).finally(() => (state.metaLoading = false));
  }
  const addInput = h("input", { placeholder: "Add a test case key", autocomplete: "off" });

  const total = te.test_cases.length || 1;
  const chip = (status, label) => h("button", {
    class: `chip${state.filter === status ? " on" : ""}`,
    title: state.filter === status ? "Show all" : `Show only ${label.toLowerCase()}`,
    onclick: () => { state.filter = state.filter === status ? "" : status; render(); },
  }, h("span", { class: `dot ${status}` }), `${count(status)} ${label}`);
  const shown = state.filter ? te.test_cases.filter((tc) => tc.status === state.filter) : te.test_cases;

  main.replaceChildren(...[
    h("div", { class: "te-head card" },
      h("div", { class: "row between" },
        h("h2", {}, te.url ? h("a", { href: te.url, target: "_blank" }, te.te_key) : te.te_key),
        h("span", { class: "row" }, selectFor("environment", splitList(state.settings.environments)), selectFor("language", splitList(state.settings.languages)))),
      te.summary ? h("p", { class: "muted te-summary" }, te.summary) : null,
      te.xray === false ? h("p", { class: "warn small-text", title: te.xray_error || "" }, `Xray didn't list this execution's tests (${te.xray_error || "no details"}), so test cases came from its links.`) : null,
      h("div", { class: "progress", title: `${count("pass")} of ${te.test_cases.length} passed` },
        ["pass", "fail", "blocked", "executing"].map((st) => h("span", { class: st, style: `width:${(count(st) / total) * 100}%` }))),
      h("div", { class: "chips" },
        chip("pass", "passed"), chip("fail", "failed"), chip("blocked", "blocked"), chip("executing", "executing"), chip("pending", "pending")),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: () => busy("pot", exportPot) }, "Download PoT"),
        h("button", { onclick: () => busy("refresh", () => loadFromJira(te.te_key)) }, "Refresh from Jira"),
        h("span", { class: "grow" }),
        h("button", {
          class: "link danger", title: "Remove this execution and its screenshots from this browser", onclick: async () => {
            if (!confirm(`Remove ${te.te_key} and all its screenshots from this browser?`)) return;
            await store.deleteTe(te.te_key);
            state.te = null;
            await chrome.storage.local.remove("lastTe");
            render();
            refreshTeList();
          },
        }, "Remove"),
      ),
      queued.length ? h("div", { class: "queue row between" },
        h("span", {}, `${queued.length} defect draft${queued.length > 1 ? "s" : ""} queued: ${queued.map((tc) => tc.key).join(", ")}`),
        h("button", { class: "fail", onclick: () => busy("queue", submitQueue) }, "Create all in Jira"),
      ) : null,
    ),
    state.filter && !shown.length ? h("p", { class: "muted empty" }, "No test cases with this status.") : null,
    h("div", { class: "tcs" }, shown.map(tcItem)),
    h("form", {
      class: "row add-tc", onsubmit: async (e) => {
        e.preventDefault();
        const key = parseIssueKey(addInput.value) || addInput.value.trim();
        if (!key || tcByKey(key)) return;
        te.test_cases.push({ key, summary: "", status: "pending" });
        await saveTe();
        state.openTc = key;
        render();
      },
    }, addInput, h("button", {}, "Add")),
  ].filter(Boolean));
}

// --- Events ----------------------------------------------------------------

$("load-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = parseIssueKey($("te-input").value);
  if (!key) return toast("Enter a Jira issue key like ABC-123, or paste its link.", "error");
  busy("load", () => loadFromJira(key)).then(() => ($("te-input").value = ""));
});

$("te-select").addEventListener("change", (e) => e.target.value && openTe(e.target.value));
$("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("toast").addEventListener("click", () => { if (!getSelection().toString()) $("toast").hidden = true; });

document.addEventListener("paste", (e) => {
  if (!state.te || !state.openTc || e.target.closest?.("input, textarea")) return;
  const blobs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!blobs.length) return;
  e.preventDefault();
  busy("paste", async () => {
    await addShots(state.openTc, state.pasteTarget, blobs);
    toast(`Pasted into ${CATEGORIES[state.pasteTarget]}.`);
  });
});

// Alt+Shift+S (see manifest "commands") captures the visible tab in the background.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "rec-step") {
    if (state.rec && sender.tab?.id === state.rec.tabId && !sender.frameId) recordStep(msg.step);
    return;
  }
  if (msg?.type !== "captured") return;
  if (!state.te || !state.openTc) return toast("Open a test case first, then capture.", "error");
  if (msg.error) return toast(`Capture failed: ${msg.error}`, "error");
  busy("capture", async () => {
    await addShots(state.openTc, state.pasteTarget, [await (await fetch(msg.dataUrl)).blob()]);
    toast(`Captured into ${CATEGORIES[state.pasteTarget]}.`);
  });
});

// A page load ends the injected recorder; note the load and start it again.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!state.rec || tabId !== state.rec.tabId || info.status !== "complete") return;
  await recordStep({ type: "page", url: tab.url });
  try {
    await inject(tabId, recorderMain);
  } catch (e) {
    toast(`Recording paused on this page: ${e.message}`, "error");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.rec?.tabId === tabId) {
    state.rec = null;
    saveActions().then(render);
    toast("The recorded tab was closed, so recording stopped.");
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  state.settings = await getSettings();
  state.meta = null;
  checkJira();
  render();
});

window.addEventListener("focus", () => state.settings && checkJira());

async function init() {
  $("app-name").title = `Version ${chrome.runtime.getManifest().version}`;
  state.settings = await getSettings();
  state.actions = (await chrome.storage.local.get("actions")).actions || [];
  checkJira();
  await refreshTeList();
  const { lastTe } = await chrome.storage.local.get("lastTe");
  if (lastTe && (await store.getTe(lastTe))) await openTe(lastTe);
  else render();
}

init();
