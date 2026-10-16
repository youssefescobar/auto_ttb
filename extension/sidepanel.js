import { getSettings, splitList } from "./lib/settings.js";
import { Jira, parseIssueKey } from "./lib/jira.js";
import * as store from "./lib/store.js";
import { buildPotBlob } from "./lib/pot.js";

const $ = (id) => document.getElementById(id);
const STATUSES = { pending: "Pending", pass: "Passed", fail: "Failed", blocked: "Blocked" };
const CATEGORIES = { expected: "Expected", actual: "Actual" };
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const TO_XRAY = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", pending: "TODO" };
const FROM_XRAY = { PASS: "pass", FAIL: "fail", BLOCKED: "blocked" };

const state = {
  settings: null,
  te: null, // the loaded TE record
  shots: [], // screenshots of the loaded TE
  openTc: null, // key of the expanded test case
  pasteTarget: "actual", // screenshot category Ctrl+V pastes into
  urls: [], // object URLs to revoke on re-render
  busy: false,
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
  toastTimer = setTimeout(() => (t.hidden = true), kind === "error" ? 9000 : 3500);
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
  state.shots = state.te ? await store.shotsForTe(teKey) : [];
  state.openTc = null;
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

async function captureTab(tcKey, category) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, { format: "png" });
  } catch {
    throw new Error("Chrome needs one click on the Auto TTB toolbar icon while that tab is showing, then Capture works there. Alt+Shift+S also captures, and pasting a Snipping Tool shot always works.");
  }
  await addShots(tcKey, category, [await (await fetch(dataUrl)).blob()]);
  toast(`Captured into ${CATEGORIES[category]}.`);
}

async function deleteShot(id) {
  await store.deleteShot(id);
  state.shots = state.shots.filter((s) => s.id !== id);
  render();
}

// --- Pass / fail -----------------------------------------------------------

async function setStatus(tcKey, status) {
  const tc = tcByKey(tcKey);
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
    // Xray keeps the result on the test run, not the Test issue's workflow. Try it
    // even when loading didn't list Xray tests, and only then fall back to a transition.
    let xrayError = "";
    try {
      tc.run_id = await jira().setTestRunStatus(state.te.te_key, tcKey, TO_XRAY[status], tc.run_id);
      await saveTe();
      done.push(`Xray run set to ${TO_XRAY[status]}`);
    } catch (e) {
      if (e.status === 401 || state.te.xray) throw e;
      xrayError = e.message;
    }
    if (xrayError) {
      const transition = { pass: state.settings.transition_pass, fail: state.settings.transition_fail }[status];
      if (!transition) throw new Error(`Xray: ${xrayError}`);
      try {
        await jira().transition(tcKey, transition);
      } catch (e) {
        throw new Error(`Xray: ${xrayError} Jira transition: ${e.message}`);
      }
      done.push(`transitioned to ${transition}`);
    }
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
      h("strong", {}, `${CATEGORIES[category]} (${shots.length})`),
      h("span", { class: "row" },
        h("button", { onclick: () => busy("capture", () => captureTab(tc.key, category)) }, "Capture tab"),
        h("button", { onclick: () => fileInput.click() }, "Upload"),
        fileInput,
      ),
    ),
    active ? h("small", { class: "muted" }, "Ctrl+V pastes here") : null,
    h("div", { class: "thumbs" }, shots.map(thumb)),
  );
}

function tcItem(tc) {
  const open = state.openTc === tc.key;
  const counts = state.shots.filter((s) => s.tc_key === tc.key).length;
  // One test case open at a time, switched synchronously so no other stays open
  const header = h("summary", { onclick: (e) => { e.preventDefault(); state.openTc = open ? null : tc.key; render(); } },
    h("span", { class: `dot ${tc.status}`, title: STATUSES[tc.status] }),
    h("span", { class: "key" }, tc.key),
    h("span", { class: "summary" }, tc.summary || ""),
    counts ? h("span", { class: "muted" }, `📷${counts}`) : null,
  );
  const details = h("details", { class: "tc", open }, header);
  if (!open) return details;

  details.append(
    ISSUE_KEY.test(tc.key) ? h("a", { href: jira().issueUrl(tc.key), target: "_blank" }, "Open in Jira ↗") : null,
    shotSection(tc, "expected"),
    shotSection(tc, "actual"),
    h("label", {}, "Note",
      h("textarea", { rows: 2, value: tc.note || "", onchange: async (e) => { tc.note = e.target.value.trim(); await saveTe(); } })),
    h("label", {}, "Linked defect",
      h("input", { value: tc.defect_key || "", placeholder: "e.g. ABC-123", onchange: async (e) => { tc.defect_key = parseIssueKey(e.target.value) || e.target.value.trim(); await saveTe(); } })),
    h("div", { class: "row actions" },
      h("button", { class: "pass", onclick: () => busy("pass", () => setStatus(tc.key, "pass")) }, "Pass"),
      h("button", { class: "fail", onclick: () => busy("fail", () => setStatus(tc.key, "fail")) }, "Fail"),
      h("button", { onclick: () => busy("blocked", () => setStatus(tc.key, "blocked")) }, "Blocked"),
      tc.status !== "pending" ? h("button", { class: "link", onclick: () => busy("reset", () => setStatus(tc.key, "pending")) }, "Reset") : null,
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
  );
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
  const main = $("te");
  const te = state.te;
  if (!te) {
    main.replaceChildren(h("p", { class: "muted empty" }, "Load a test execution from Jira to start."));
    return;
  }
  const count = (s) => te.test_cases.filter((tc) => tc.status === s).length;
  const addInput = h("input", { placeholder: "Add a test case key", autocomplete: "off" });

  main.replaceChildren(
    h("div", { class: "te-head" },
      h("h2", {}, te.url ? h("a", { href: te.url, target: "_blank" }, te.te_key) : te.te_key),
      te.summary ? h("p", { class: "muted" }, te.summary) : null,
      te.xray === false ? h("p", { class: "warn", title: te.xray_error || "" }, `Xray didn't list this execution's tests (${te.xray_error || "no details"}), so test cases came from its links.`) : null,
      h("div", { class: "row" }, selectFor("environment", splitList(state.settings.environments)), selectFor("language", splitList(state.settings.languages))),
      h("p", { class: "counts" },
        h("span", { class: "pass-text" }, `${count("pass")} passed`), " · ",
        h("span", { class: "fail-text" }, `${count("fail")} failed`), " · ",
        `${count("blocked")} blocked · ${count("pending")} pending`),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: () => busy("pot", exportPot) }, "Download PoT"),
        h("button", { onclick: () => busy("refresh", () => loadFromJira(te.te_key)) }, "Refresh from Jira"),
        h("button", {
          class: "link danger", onclick: async () => {
            if (!confirm(`Remove ${te.te_key} and all its screenshots from this browser?`)) return;
            await store.deleteTe(te.te_key);
            state.te = null;
            await chrome.storage.local.remove("lastTe");
            render();
            refreshTeList();
          },
        }, "Remove"),
      ),
    ),
    h("div", { class: "tcs" }, te.test_cases.map(tcItem)),
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
  );
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
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "captured") return;
  if (!state.te || !state.openTc) return toast("Open a test case first, then capture.", "error");
  if (msg.error) return toast(`Capture failed: ${msg.error}`, "error");
  busy("capture", async () => {
    await addShots(state.openTc, state.pasteTarget, [await (await fetch(msg.dataUrl)).blob()]);
    toast(`Captured into ${CATEGORIES[state.pasteTarget]}.`);
  });
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.settings) return;
  state.settings = await getSettings();
  checkJira();
  render();
});

window.addEventListener("focus", () => state.settings && checkJira());

async function init() {
  $("app-name").title = `Version ${chrome.runtime.getManifest().version}`;
  state.settings = await getSettings();
  checkJira();
  await refreshTeList();
  const { lastTe } = await chrome.storage.local.get("lastTe");
  if (lastTe && (await store.getTe(lastTe))) await openTe(lastTe);
  else render();
}

init();
