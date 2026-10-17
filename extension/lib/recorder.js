// Click recorder and replayer. Records clicks, typing and page loads in one tab,
// then replays them and takes screenshots at the checkpoints.
//
// Steps:
//   { type: "open", url }                      first step: the page recording started on
//   { type: "click", sel, text, tag, ox, oy }   ox/oy: click position inside the element (0..1)
//   { type: "input", sel, tag, value, secret }  final value of a field
//   { type: "key", sel, key: "Enter" }
//   { type: "page", url }                       a page load caused by the previous step
//   { type: "shot", category: "actual" }        take a screenshot here
//
// The two functions below are injected into the page with chrome.scripting, so
// they must not use anything outside their own bodies.

export function recorderMain() {
  if (window.__autoTtbRec) return;
  const send = (step) => chrome.runtime.sendMessage({ type: "rec-step", step }).catch(() => {});

  const esc = (v) => CSS.escape(v);
  const generated = (v) => /\d{3,}|[a-f0-9]{8,}|^(ember|ext|react|rc|mui|ng)[-_]?/i.test(v);
  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }
  function selectorFor(el) {
    for (const attr of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label", "placeholder"]) {
      const v = el.getAttribute?.(attr);
      if (v) {
        const sel = `${el.tagName.toLowerCase()}[${attr}="${v.replace(/"/g, '\\"')}"]`;
        if (unique(sel)) return sel;
      }
    }
    if (el.id && !generated(el.id) && unique(`#${esc(el.id)}`)) return `#${esc(el.id)}`;
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id && !generated(node.id)) {
        parts.unshift(`#${esc(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      if (unique(parts.join(" > "))) break;
    }
    return parts.join(" > ");
  }
  // The element a person meant: the nearest button/link/field rather than an icon inside it
  const target = (el) => el.closest?.("a, button, input, select, textarea, label, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [onclick]") || el;
  const textOf = (el) => (el.innerText || el.value || el.getAttribute?.("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const isField = (el) => el.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true]");

  const onClick = (e) => {
    if (!e.isTrusted) return;
    const el = target(e.target);
    if (isField(el) && el.tagName !== "SELECT") return; // focusing a field; its value is recorded on change
    const r = el.getBoundingClientRect();
    send({
      type: "click", sel: selectorFor(el), text: textOf(el), tag: el.tagName.toLowerCase(),
      ox: r.width ? +((e.clientX - r.left) / r.width).toFixed(3) : 0.5,
      oy: r.height ? +((e.clientY - r.top) / r.height).toFixed(3) : 0.5,
    });
  };
  const onChange = (e) => {
    const el = e.target; // not only trusted events: some pickers set the value from script
    if (!isField(el)) return;
    const value = el.isContentEditable ? el.innerText : el.value;
    send({ type: "input", sel: selectorFor(el), tag: el.tagName.toLowerCase(), value, secret: el.type === "password" });
  };
  const onKey = (e) => {
    if (!e.isTrusted || e.key !== "Enter" || !isField(e.target) || e.target.tagName === "TEXTAREA") return;
    onChange({ isTrusted: true, target: e.target }); // Enter can submit before change fires
    send({ type: "key", sel: selectorFor(e.target), key: "Enter" });
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("keydown", onKey, true);
  window.__autoTtbRec = {
    stop() {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("keydown", onKey, true);
      delete window.__autoTtbRec;
    },
  };
}

export function recorderStop() {
  window.__autoTtbRec?.stop();
}

// Runs one step in the page. Returns { ok, why }; waits up to timeoutMs for the element.
export async function playStep(step, timeoutMs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const norm = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
  function find() {
    let el = null;
    try {
      el = document.querySelector(step.sel);
    } catch {}
    if (el && visible(el)) return el;
    // Layout changed: look for the same kind of element with the same text
    if (step.text) {
      const want = norm(step.text);
      const all = [...document.querySelectorAll(step.tag || "*")].filter(visible);
      return all.find((x) => norm(x.innerText || x.value) === want) || all.find((x) => norm(x.innerText).startsWith(want)) || null;
    }
    return null;
  }
  let el = null;
  for (const end = Date.now() + timeoutMs; !(el = find()) && Date.now() < end;) await sleep(200);
  if (!el) return { ok: false, why: `couldn't find ${step.text ? `"${step.text}"` : step.sel}` };
  el.scrollIntoView({ block: "center", inline: "center" });
  await sleep(50);

  if (step.type === "click") {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * (step.ox ?? 0.5);
    const y = r.top + r.height * (step.oy ?? 0.5);
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.focus?.();
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  } else if (step.type === "input") {
    el.focus?.();
    if (el.isContentEditable) el.innerText = step.value;
    else {
      // The native setter makes React and similar frameworks notice the change
      const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, step.value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (step.type === "key") {
    const opts = { key: step.key, code: step.key, keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notHandled = el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    // A synthetic Enter never submits a form by itself; do what the browser would
    if (notHandled && el.form) el.form.requestSubmit();
  }
  return { ok: true };
}

// --- Helpers used by the side panel --------------------------------------

// Adds a recorded step, merging repeats: a field typed into twice keeps the last value,
// and an Enter right after typing doesn't need a separate page step later.
export function addStep(steps, step) {
  const last = steps[steps.length - 1];
  if (step.type === "input" && last?.type === "input" && last.sel === step.sel) {
    steps[steps.length - 1] = step;
    return steps;
  }
  if (step.type === "page" && (last?.type === "page" || last?.type === "open") && last.url === step.url) return steps;
  steps.push(step);
  return steps;
}

export function describeStep(step) {
  switch (step.type) {
    case "open": return `Open ${step.url}`;
    case "click": return `Click ${step.text ? `"${step.text}"` : step.tag || "element"}`;
    case "input": return `${step.tag === "select" ? "Choose" : "Type"} ${step.secret ? "••••••" : `"${String(step.value).slice(0, 40)}"`}`;
    case "key": return `Press ${step.key}`;
    case "page": return `Page loads: ${step.url.replace(/^https?:\/\//, "").slice(0, 50)}`;
    case "shot": return "📷 Screenshot";
    default: return step.type;
  }
}
