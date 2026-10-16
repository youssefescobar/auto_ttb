import { test } from "node:test";
import assert from "node:assert/strict";
import { matchOldShots, mergeOldDb, oldTcDir } from "../lib/legacy.js";

const db = { test_executions: { "BDR-1": { te_key: "BDR-1", environment: "Prod", language: "English", test_cases: [
  { key: "TC01_Login: check?", name: "TC01_Login: check?", tc_number: "BDR-11", status: "fail", summary: "button misaligned", defect_key: "BDR-99" },
  { key: "TC02 draft", name: "TC02 draft", tc_number: "BDR-12", status: "skip", summary: "", defect_key: "JK26-3835-DRAFT" },
  { key: "TC03 no number", name: "TC03 no number", tc_number: "", status: "pass", summary: "" },
] } } };

test("converts old test executions", () => {
  const [te] = mergeOldDb(db);
  assert.equal(te.environment, "Prod");
  assert.deepEqual(te.test_cases[0], { key: "BDR-11", summary: "TC01_Login: check?", status: "fail", legacy_dir: "TC01_Login_ check_", note: "button misaligned", defect_key: "BDR-99" });
  assert.equal(te.test_cases[1].status, "pending");
  assert.equal(te.test_cases[1].note, "Skipped");
  assert.equal(te.test_cases[1].defect_key, undefined);
  assert.equal(te.test_cases[2].key, "TC03 no number");
});

test("keeps work already in the extension", () => {
  const existing = [{ te_key: "BDR-1", test_cases: [{ key: "BDR-11", status: "pass", note: "retested" }] }];
  const [te] = mergeOldDb(db, existing);
  assert.equal(te.test_cases.length, 3);
  assert.equal(te.test_cases[0].status, "pass");
  assert.equal(te.test_cases[0].note, "retested");
  assert.equal(te.test_cases[0].defect_key, "BDR-99");
});

test("matches screenshots from the executions folder", () => {
  const tes = mergeOldDb(db);
  const f = (path) => ({ name: path.split("/").pop(), webkitRelativePath: path });
  const shots = matchOldShots([
    f(`executions/BDR-1/${oldTcDir("TC01_Login: check?")}/actual/shot_2.png`),
    f(`executions/BDR-1/${oldTcDir("TC01_Login: check?")}/expected/shot_1.png`),
    f("executions/BDR-1/unknown/actual/x.png"),
    f("executions/BDR-1/poc_report_BDR-1.docx"),
  ], tes);
  assert.deepEqual(shots.map((s) => [s.tc_key, s.category, s.name]), [["BDR-11", "expected", "shot_1.png"], ["BDR-11", "actual", "shot_2.png"]]);
});

test("rejects files that aren't the old db", () => {
  assert.throws(() => mergeOldDb({ tes: [] }), /no test executions/);
});
