import { test } from "node:test";
import assert from "node:assert/strict";
import { addStep, describeStep } from "../lib/recorder.js";

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
