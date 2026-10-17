// Click and keystroke recorder and replayer. Records clicks, typing, keys and
// page loads in one tab, then replays them (typing character by character) and
// takes screenshots at the checkpoints.
//
// Steps (any step may carry `wait`: seconds to pause before it runs):
//   { type: "open", url }                       first step: the page recording started on
//   { type: "click", sel, text, tag, ox, oy }    ox/oy: click position inside the element (0..1)
//   { type: "text", sel, text, secret }          characters typed (into a field, or e.g. a BrowserStack stream)
//   { type: "input", sel, tag, value, secret }   a value set without typing: a select, autofill, a picker
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
  // Selectors are unique within the element's own document or shadow root
  function selectorFor(el) {
    if (!el || el === document || el === document.body || el === document.documentElement) return "body";
    const root = el.getRootNode?.() || document;
    const unique = (sel) => {
      try {
        return root.querySelectorAll(sel).length === 1;
      } catch {
        return false;
      }
    };
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
  // The element under the event, looking inside shadow DOM (e.target stops at the host)
  const origin = (e) => e.composedPath?.()[0] || e.target;
  // The element a person meant: the nearest button/link/field rather than an icon inside it
  const target = (el) => el.closest?.("a, button, input, select, textarea, label, [role=button], [role=link], [role=tab], [role=option], [role=menuitem], [onclick]") || el;
  const textOf = (el) => (el.innerText || el.value || el.getAttribute?.("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const isField = (el) => !!el?.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable=true], [contenteditable='']") || !!el?.isContentEditable;
  const keyed = new WeakSet(); // fields typed into with the keyboard since they got focus

  const onClick = (e) => {
    if (!e.isTrusted) return;
    const el = target(origin(e));
    if (isField(el)) return; // focusing a field; what's typed is recorded as keystrokes
    const r = el.getBoundingClientRect();
    send({
      type: "click", sel: selectorFor(el), text: textOf(el), tag: el.tagName.toLowerCase(),
      ox: r.width ? +((e.clientX - r.left) / r.width).toFixed(3) : 0.5,
      oy: r.height ? +((e.clientY - r.top) / r.height).toFixed(3) : 0.5,
    });
  };
  // Selects, and fields filled without typing (autofill, pickers), are recorded as their value
  const onChange = (e) => {
    const el = origin(e);
    if (el.tagName === "SELECT") send({ type: "input", sel: selectorFor(el), tag: "select", value: el.value });
    else if (isField(el) && !keyed.has(el)) {
      send({ type: "input", sel: selectorFor(el), tag: el.tagName.toLowerCase(), value: el.isContentEditable ? el.innerText : el.value, secret: el.type === "password" });
    }
  };
  const onFocus = (e) => keyed.delete(origin(e));
  const onPaste = (e) => {
    const el = origin(e);
    const text = e.clipboardData?.getData("text") || "";
    if (!text) return;
    if (isField(el)) keyed.add(el);
    send({ type: "text", sel: selectorFor(el), text, secret: el.type === "password" });
  };
  // Keys that do something besides typing a character
  const SPECIAL = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
  const onKey = (e) => {
    if (!e.isTrusted || e.isComposing || ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Process", "Unidentified"].includes(e.key)) return;
    const el = origin(e);
    const combo = e.ctrlKey || e.metaKey || e.altKey;
    if (isField(el)) keyed.add(el);
    const sel = selectorFor(el);
    if (!combo && e.key.length === 1) {
      send({ type: "text", sel, text: e.key, secret: el.type === "password" });
      return;
    }
    if (!combo && !SPECIAL.has(e.key) && !/^F\d+$/.test(e.key)) return;
    if (combo && (e.key === "v" || e.key === "V") && isField(el)) return; // recorded by the paste handler
    send({ type: "key", sel, key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
  };
  const listeners = [["click", onClick], ["change", onChange], ["keydown", onKey], ["focusin", onFocus], ["paste", onPaste]];
  for (const [type, fn] of listeners) document.addEventListener(type, fn, true);
  window.__autoTtbRec = {
    stop() {
      for (const [type, fn] of listeners) document.removeEventListener(type, fn, true);
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
    // Search the page and any shadow roots in it
    const roots = [document];
    for (let i = 0; i < roots.length; i++) for (const x of roots[i].querySelectorAll("*")) if (x.shadowRoot) roots.push(x.shadowRoot);
    for (const root of roots) {
      let el = null;
      try {
        el = root.querySelector(step.sel);
      } catch {}
      if (el && visible(el)) return el;
      // Remote-control pages type through a hidden field, so keys may go to an invisible one
      if (el && (step.type === "text" || step.type === "key")) return el;
    }
    if (step.type === "text" || step.type === "key") {
      const a = document.activeElement;
      if (a && a !== document.body) return a;
    }
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
  const field = el.isContentEditable || (el.tagName !== "SELECT" && "value" in el);
  const wasFocused = document.activeElement === el || el.shadowRoot?.activeElement;
  // Typing into a field that wasn't focused starts at its end, as after a click
  const caretToEnd = () => {
    try {
      if (!wasFocused && el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
    } catch {}
  };
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
    // Count keys the page receives, so the panel can tell if the debugger's typing arrived
    if (!window.__autoTtbKeys) {
      window.__autoTtbKeys = { count: 0 };
      document.addEventListener("keydown", () => window.__autoTtbKeys.count++, true);
    }
    window.__autoTtbKeys.count = 0;
    // Real input types into a focused, empty field
    if (step.type === "input" && isText(el)) {
      el.focus();
      setValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (step.type !== "click" && el !== document.body) {
      el.focus?.();
      if (step.type === "text") caretToEnd();
    }
    return { ok: true, field, ...point() };
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
    if (step.type === "text") caretToEnd();
    if (step.type === "input" && !isText(el)) setValue(el, value); // a select: just choose
    else {
      if (step.type === "input") setValue(el, "");
      for (const ch of value) {
        const k = { key: ch, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", k));
        el.dispatchEvent(new KeyboardEvent("keypress", k));
        if (isText(el) && !el.isContentEditable && "selectionStart" in el && el.selectionStart !== null) {
          const { selectionStart: a, selectionEnd: b, value: v } = el;
          setValue(el, v.slice(0, a) + ch + v.slice(b));
          el.setSelectionRange(a + 1, a + 1);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        } else if (isText(el)) {
          setValue(el, (el.isContentEditable ? el.innerText : el.value) + ch);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        }
        el.dispatchEvent(new KeyboardEvent("keyup", k));
        if (typingMs) await sleep(typingMs);
      }
    }
    if (step.type === "input") el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (step.type === "key") {
    const k = { key: step.key, code: step.key, bubbles: true, cancelable: true, ctrlKey: !!step.ctrl, shiftKey: !!step.shift, altKey: !!step.alt, metaKey: !!step.meta };
    const notHandled = el.dispatchEvent(new KeyboardEvent("keydown", k));
    el.dispatchEvent(new KeyboardEvent("keyup", k));
    // A synthetic key does nothing by itself; do what the browser would for the common ones
    if (notHandled && step.key === "Enter" && el.form) el.form.requestSubmit();
    if (notHandled && !step.ctrl && !step.meta && !step.alt && "selectionStart" in el && typeof el.value === "string") {
      let { selectionStart: a, selectionEnd: b, value: v } = el;
      if (step.key === "Backspace" || step.key === "Delete") {
        if (a === b) step.key === "Backspace" ? (a = Math.max(0, a - 1)) : (b = Math.min(v.length, b + 1));
        setValue(el, v.slice(0, a) + v.slice(b));
        el.setSelectionRange(a, a);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: step.key === "Backspace" ? "deleteContentBackward" : "deleteContentForward" }));
      } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(step.key)) {
        const p = { ArrowLeft: Math.max(0, a - 1), ArrowRight: Math.min(v.length, b + 1), Home: 0, End: v.length }[step.key];
        el.setSelectionRange(p, p);
      }
    }
  }
  return { ok: true };
}

// How many keys reached the page since playStep located a field (injected).
export function keysSeen() {
  return window.__autoTtbKeys?.count ?? -1;
}

// --- Real input through Chrome's debugger protocol -----------------------

// Remote-control pages such as BrowserStack forward a key by its code and keyCode,
// not its text, so every event carries the full physical key of a US keyboard.
const NAMED = {
  Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46],
  ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40],
  Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], " ": ["Space", 32],
};
const PUNCT = { "`": ["Backquote", 192, "~"], "-": ["Minus", 189, "_"], "=": ["Equal", 187, "+"], "[": ["BracketLeft", 219, "{"], "]": ["BracketRight", 221, "}"], "\\": ["Backslash", 220, "|"], ";": ["Semicolon", 186, ":"], "'": ["Quote", 222, '"'], ",": ["Comma", 188, "<"], ".": ["Period", 190, ">"], "/": ["Slash", 191, "?"] };
const SHIFTED_DIGITS = ")!@#$%^&*(";

// { code, keyCode, shift } of the key that types ch, or null for characters a US keyboard lacks.
export function physicalKey(ch) {
  if (NAMED[ch]) return { code: NAMED[ch][0], keyCode: NAMED[ch][1], shift: false };
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, keyCode: ch.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), shift: false };
  const d = SHIFTED_DIGITS.indexOf(ch);
  if (d >= 0) return { code: `Digit${d}`, keyCode: 48 + d, shift: true };
  for (const [base, [code, keyCode, shifted]] of Object.entries(PUNCT)) {
    if (ch === base) return { code, keyCode, shift: false };
    if (ch === shifted) return { code, keyCode, shift: true };
  }
  if (/^F\d+$/.test(ch)) return { code: ch, keyCode: 111 + Number(ch.slice(1)), shift: false };
  return null;
}

const SHIFT = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 };

// CDP Input.dispatchKeyEvent parameters, in order, for one key step or one typed character.
// step: { key, ctrl, shift, alt, meta } (a typed character is { key: ch }).
export function keyEventParams(step) {
  const phys = physicalKey(step.key);
  const shift = !!step.shift || !!phys?.shift;
  const modifiers = (step.alt ? 1 : 0) | (step.ctrl ? 2 : 0) | (step.meta ? 4 : 0) | (shift ? 8 : 0);
  const text = modifiers & 7 ? undefined : step.key === "Enter" ? "\r" : step.key.length === 1 ? step.key : undefined;
  const ids = { key: step.key, code: phys?.code || "", windowsVirtualKeyCode: phys?.keyCode || 0, nativeVirtualKeyCode: phys?.keyCode || 0 };
  const events = [];
  if (shift) events.push({ type: "rawKeyDown", ...SHIFT, modifiers: 8 });
  events.push({ type: text ? "keyDown" : "rawKeyDown", ...ids, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
  events.push({ type: "keyUp", ...ids, modifiers });
  if (shift) events.push({ type: "keyUp", ...SHIFT, modifiers: 0 });
  return events;
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
    case "text": return `Type ${step.secret ? "••••••" : `"${step.text.slice(0, 40)}"`}`;
    case "key": return `Press ${[step.ctrl && "Ctrl", step.alt && "Alt", step.shift && "Shift", step.meta && "Cmd", step.key === " " ? "Space" : step.key].filter(Boolean).join("+")}`;
    case "page": return `Page loads: ${step.url.replace(/^https?:\/\//, "").slice(0, 50)}`;
    case "shot": return "📷 Screenshot";
    default: return step.type;
  }
}
