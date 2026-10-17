// Click and keystroke recorder and replayer. Records clicks, typing, keys and
// page loads in one tab, then replays them (typing character by character) and
// takes screenshots at the checkpoints.
//
// Steps (any step may carry `wait`: seconds to pause before it runs):
//   { type: "open", url }                       first step: the page recording started on
//   { type: "click", sel, text, tag, ox, oy }    ox/oy: click position inside the element (0..1)
//   { type: "input", sel, tag, value, secret }   what was typed into a field (or chosen in a select)
//   { type: "text", sel, text }                  keys typed outside a field, e.g. into a BrowserStack stream
//   { type: "key", sel, key, ctrl, shift, alt, meta }   Enter, Tab, arrows, Escape, shortcuts…
//   { type: "page", url }                        a page load caused by the previous step
//   { type: "shot", category: "actual" }         take a screenshot here
//
// recorderMain, recorderStop and playStep are injected into the page with
// chrome.scripting, so they must not use anything outside their own bodies.

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
    if (!el || el === document || el === document.body || el === document.documentElement) return "body";
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
  const isField = (el) => !!el?.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true], [contenteditable='']");
  const valueOf = (el) => (el.isContentEditable ? el.innerText : el.value);
  const sent = new WeakMap(); // field -> last value recorded, so blur doesn't record it twice

  function recordValue(el) {
    const value = valueOf(el);
    if (sent.get(el) === value) return;
    sent.set(el, value);
    send({ type: "input", sel: selectorFor(el), tag: el.tagName.toLowerCase(), value, secret: el.type === "password" });
  }

  const onClick = (e) => {
    if (!e.isTrusted) return;
    const el = target(e.target);
    if (isField(el) && el.tagName !== "SELECT") return; // focusing a field; what's typed is recorded separately
    const r = el.getBoundingClientRect();
    send({
      type: "click", sel: selectorFor(el), text: textOf(el), tag: el.tagName.toLowerCase(),
      ox: r.width ? +((e.clientX - r.left) / r.width).toFixed(3) : 0.5,
      oy: r.height ? +((e.clientY - r.top) / r.height).toFixed(3) : 0.5,
    });
  };
  const onChange = (e) => { // not only trusted events: some pickers set the value from script
    if (isField(e.target)) recordValue(e.target);
  };
  // Keys that do something besides typing a character
  const SPECIAL = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " "]);
  const onKey = (e) => {
    if (!e.isTrusted || ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
    const el = e.target;
    const combo = e.ctrlKey || e.metaKey || e.altKey;
    const field = isField(el) && el.tagName !== "SELECT";
    if (field) {
      // Plain typing and editing inside a field is recorded as its value
      if (!combo && (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete")) return;
      if (e.key === "Tab" || e.key === "Enter") recordValue(el); // these can leave or submit before change fires
      if (!combo && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return; // caret moves
    } else if (!combo && e.key.length === 1 && e.key !== " ") {
      send({ type: "text", sel: selectorFor(el), text: e.key });
      return;
    }
    if (!combo && !SPECIAL.has(e.key) && e.key.length > 1 && !/^F\d+$/.test(e.key)) return;
    send({ type: "key", sel: selectorFor(el), key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("keydown", onKey, true);
  window.__autoTtbRec = {
    stop() {
      if (isField(document.activeElement)) recordValue(document.activeElement); // typed but never left the field
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

// Runs one step in the page. Returns { ok, why } or, with opts.locate, the point to
// click/type at ({ ok, x, y }) so the side panel can send real input there.
// opts: { timeoutMs, typingMs, locate }
export async function playStep(step, opts) {
  const { timeoutMs = 8000, typingMs = 60, locate = false } = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const norm = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
  function find() {
    if (!step.sel || step.sel === "body") return document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    let el = null;
    try {
      el = document.querySelector(step.sel);
    } catch {}
    if (el && visible(el)) return el;
    // Layout changed: look for the same kind of element with the same text
    if (step.text && step.type === "click") {
      const want = norm(step.text);
      const all = [...document.querySelectorAll(step.tag || "*")].filter(visible);
      return all.find((x) => norm(x.innerText || x.value) === want) || all.find((x) => norm(x.innerText).startsWith(want)) || null;
    }
    return null;
  }
  let el = null;
  for (const end = Date.now() + timeoutMs; !(el = find()) && Date.now() < end;) await sleep(200);
  if (!el) return { ok: false, why: `couldn't find ${step.text && step.type === "click" ? `"${step.text}"` : step.sel}` };
  if (el !== document.body) el.scrollIntoView({ block: "center", inline: "center" });
  await sleep(50);

  const isText = (x) => x.tagName !== "SELECT" && (x.isContentEditable || "value" in x);
  const setValue = (x, v) => {
    if (x.isContentEditable) x.innerText = v;
    else {
      // The native setter makes React and similar frameworks notice the change
      const proto = x.tagName === "SELECT" ? HTMLSelectElement.prototype : x.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(x, v);
    }
  };
  const point = () => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * (step.ox ?? 0.5), y: r.top + r.height * (step.oy ?? 0.5) };
  };

  if (locate) {
    // Real input types into a focused, empty field
    if (step.type === "input" && isText(el)) {
      el.focus();
      setValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (step.type !== "click" && el !== document.body) el.focus?.();
    return { ok: true, ...point() };
  }

  if (step.type === "click") {
    const { x, y } = point();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.focus?.();
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  } else if (step.type === "input" || step.type === "text") {
    const value = String(step.type === "input" ? step.value : step.text);
    el.focus?.();
    if (step.type === "input" && !isText(el)) setValue(el, value); // a select: just choose
    else {
      if (step.type === "input") setValue(el, "");
      for (const ch of value) {
        const k = { key: ch, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", k));
        el.dispatchEvent(new KeyboardEvent("keypress", k));
        if (isText(el)) {
          setValue(el, (el.isContentEditable ? el.innerText : el.value) + ch);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        }
        el.dispatchEvent(new KeyboardEvent("keyup", k));
        if (typingMs) await sleep(typingMs);
      }
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (step.type === "key") {
    const k = { key: step.key, code: step.key, bubbles: true, cancelable: true, ctrlKey: !!step.ctrl, shiftKey: !!step.shift, altKey: !!step.alt, metaKey: !!step.meta };
    const notHandled = el.dispatchEvent(new KeyboardEvent("keydown", k));
    el.dispatchEvent(new KeyboardEvent("keyup", k));
    // A synthetic key does nothing by itself; do what the browser would for the common ones
    if (notHandled && step.key === "Enter" && el.form) el.form.requestSubmit();
  }
  return { ok: true };
}

// --- Real input through Chrome's debugger protocol -----------------------

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };

// CDP Input.dispatchKeyEvent parameters (down, up) for a key step.
export function keyEventParams(step) {
  const modifiers = (step.alt ? 1 : 0) | (step.ctrl ? 2 : 0) | (step.meta ? 4 : 0) | (step.shift ? 8 : 0);
  const single = step.key.length === 1;
  const code = KEY_CODES[step.key] ?? (single ? step.key.toUpperCase().charCodeAt(0) : /^F(\d+)$/.test(step.key) ? 111 + Number(step.key.slice(1)) : 0);
  const text = modifiers & 7 ? undefined : step.key === "Enter" ? "\r" : single ? step.key : undefined;
  const down = { type: text ? "keyDown" : "rawKeyDown", key: step.key, windowsVirtualKeyCode: code, modifiers, ...(text ? { text, unmodifiedText: text } : {}) };
  return [down, { type: "keyUp", key: step.key, windowsVirtualKeyCode: code, modifiers }];
}

// --- Helpers used by the side panel --------------------------------------

// Adds a recorded step, merging repeats: typing into the same field keeps the last
// value, consecutive keys typed outside a field become one text step, and a field
// value already recorded just before isn't recorded again.
export function addStep(steps, step) {
  const last = steps[steps.length - 1];
  if (step.type === "input" && last?.type === "input" && last.sel === step.sel) {
    steps[steps.length - 1] = { ...step, wait: last.wait };
    return steps;
  }
  if (step.type === "input" && steps.slice(-3).some((s) => s.type === "input" && s.sel === step.sel && s.value === step.value)) return steps;
  if (step.type === "text" && last?.type === "text" && last.sel === step.sel) {
    last.text += step.text;
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
    case "text": return `Type "${step.text.slice(0, 40)}"`;
    case "key": return `Press ${[step.ctrl && "Ctrl", step.alt && "Alt", step.shift && "Shift", step.meta && "Cmd", step.key === " " ? "Space" : step.key].filter(Boolean).join("+")}`;
    case "page": return `Page loads: ${step.url.replace(/^https?:\/\//, "").slice(0, 50)}`;
    case "shot": return "📷 Screenshot";
    default: return step.type;
  }
}
