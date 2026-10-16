// Imports the retired Python app's db.json and executions/ screenshots folder.

const STATUS = { pass: "pass", fail: "fail", blocked: "blocked", executing: "executing", pending: "pending" };
const REAL_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

// Folder name the Python app used for a test case (app.get_tc_dir).
export function oldTcDir(oldKey) {
  return String(oldKey).replace(/[\\/*?:"<>|]/g, "_").slice(0, 100).trim();
}

function convertTc(old) {
  const key = REAL_KEY.test(old.tc_number || "") ? old.tc_number : old.tc_number || old.key;
  const skipped = old.status === "skip";
  const note = [skipped && "Skipped", old.summary].filter(Boolean).join(": ");
  const tc = {
    key,
    summary: old.name && old.name !== key ? old.name : "",
    status: STATUS[old.status] || "pending",
    legacy_dir: oldTcDir(old.key || old.name || key),
  };
  if (note) tc.note = note;
  if (REAL_KEY.test(old.defect_key || "")) tc.defect_key = old.defect_key; // "-DRAFT" keys were never filed
  return tc;
}

// Merges the old test executions into the ones already stored (existing work wins).
// Returns the test executions to save.
export function mergeOldDb(db, existing = []) {
  const olds = Object.values(db?.test_executions || {});
  if (!olds.length) throw new Error("This file has no test executions. Pick the old app's db.json.");
  const byKey = new Map(existing.map((te) => [te.te_key, te]));
  return olds.map((old) => {
    const te = byKey.get(old.te_key) || {
      te_key: old.te_key,
      created_at: old.created_at,
      environment: old.environment || "",
      language: old.language || "",
      test_cases: [],
    };
    const tcs = new Map(te.test_cases.map((tc) => [tc.key, tc]));
    for (const tc of (old.test_cases || []).map(convertTc)) {
      const cur = tcs.get(tc.key);
      if (!cur) tcs.set(tc.key, tc);
      else {
        cur.legacy_dir ??= tc.legacy_dir;
        if (cur.status === "pending") cur.status = tc.status;
        cur.note ||= tc.note;
        cur.defect_key ||= tc.defect_key;
        cur.summary ||= tc.summary;
      }
    }
    te.test_cases = [...tcs.values()];
    return te;
  });
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// files: picked from the executions folder (webkitRelativePath ".../TE-1/<tc dir>/expected/shot.png").
// Returns [{ te_key, tc_key, category, name, file }] for test cases that exist in tes.
export function matchOldShots(files, tes) {
  const dirs = new Map();
  for (const te of tes) for (const tc of te.test_cases) if (tc.legacy_dir) dirs.set(`${te.te_key}/${tc.legacy_dir}`, tc.key);
  const out = [];
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split("/");
    if (parts.length < 4 || !IMAGE.test(file.name)) continue;
    const [teKey, tcDir, category] = parts.slice(-4, -1);
    if (category !== "expected" && category !== "actual") continue;
    const tcKey = dirs.get(`${teKey}/${tcDir}`);
    if (tcKey) out.push({ te_key: teKey, tc_key: tcKey, category, name: file.name, file });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
