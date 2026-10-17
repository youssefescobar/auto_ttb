import { test } from "node:test";
import assert from "node:assert/strict";
import { addStep, describeStep, keyEventParams } from "../lib/recorder.js";

test("merges repeated typing and duplicate page loads", () => {
  const steps = [{ type: "open", url: "https://a/x" }];
  addStep(steps, { type: "page", url: "https://a/x" });
  addStep(steps, { type: "input", sel: "#u", value: "a" });
  addStep(steps, { type: "input", sel: "#u", value: "ab" });
  addStep(steps, { type: "click", sel: "button", text: "Go" });
  addStep(steps, { type: "page", url: "https://a/y" });
  addStep(steps, { type: "page", url: "https://a/y" });
  assert.deepEqual(steps.map((s) => s.type), ["open", "input", "click", "page"]);
  assert.equal(steps[1].value, "ab");
});

test("describes steps without showing passwords", () => {
  assert.equal(describeStep({ type: "input", value: "s3cret", secret: true }), "Type ••••••");
  assert.equal(describeStep({ type: "input", tag: "select", value: "Arabic" }), 'Choose "Arabic"');
  assert.equal(describeStep({ type: "click", text: "Sign in" }), 'Click "Sign in"');
});

test("merges keys typed outside a field and names shortcuts", () => {
  const steps = [];
  for (const ch of "ab1") addStep(steps, { type: "text", sel: "#stream", text: ch });
  addStep(steps, { type: "key", sel: "#stream", key: "a", ctrl: true });
  assert.deepEqual(steps.map(describeStep), ['Type "ab1"', "Press Ctrl+a"]);
});

test("real key events", () => {
  assert.deepEqual(keyEventParams({ key: "Enter" })[0], { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" });
  assert.deepEqual(keyEventParams({ key: "a", ctrl: true })[0], { type: "rawKeyDown", key: "a", windowsVirtualKeyCode: 65, modifiers: 2 });
  assert.equal(keyEventParams({ key: "ArrowDown" })[0].windowsVirtualKeyCode, 40);
});

test("masks typed passwords", () => {
  assert.equal(describeStep({ type: "text", text: "s3cret", secret: true }), "Type ••••••");
});
