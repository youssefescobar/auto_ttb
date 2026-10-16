// IndexedDB storage for test executions and their screenshots (replaces db.json
// and the executions/ folder). Data stays in this browser profile only.
//
// tes:   { te_key, summary, url, environment, language, created_at, updated_at,
//          test_cases: [{ key, summary, status, defect_key, note, updated_at }] }
// shots: { id, te_key, tc_key, category: "expected" | "actual", name, blob, created_at }

const DB_NAME = "auto_ttb";
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("tes", { keyPath: "te_key" });
      const shots = db.createObjectStore("shots", { keyPath: "id", autoIncrement: true });
      shots.createIndex("te", "te_key");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function listTes() {
  const all = await done((await store("tes")).getAll());
  return all.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
}

export async function getTe(teKey) {
  return done((await store("tes")).get(teKey));
}

export async function saveTe(te) {
  te.updated_at = new Date().toISOString();
  te.created_at ??= te.updated_at;
  await done((await store("tes", "readwrite")).put(te));
  return te;
}

export async function deleteTe(teKey) {
  await done((await store("tes", "readwrite")).delete(teKey));
  for (const shot of await shotsForTe(teKey)) await deleteShot(shot.id);
}

export async function addShot({ te_key, tc_key, category, name, blob }) {
  const shot = { te_key, tc_key, category, name, blob, created_at: new Date().toISOString() };
  shot.id = await done((await store("shots", "readwrite")).add(shot));
  return shot;
}

export async function shotsForTe(teKey) {
  const all = await done((await store("shots")).index("te").getAll(teKey));
  return all.sort((a, b) => a.id - b.id);
}

export async function deleteShot(id) {
  await done((await store("shots", "readwrite")).delete(id));
}

// --- Backup ---------------------------------------------------------------

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function exportAll() {
  const tes = await listTes();
  const shots = [];
  for (const te of tes) {
    for (const s of await shotsForTe(te.te_key)) {
      const { blob, id, ...rest } = s;
      shots.push({ ...rest, data: await blobToDataUrl(blob) });
    }
  }
  return { app: "auto_ttb", version: 1, exported_at: new Date().toISOString(), tes, shots };
}

export async function importAll(backup) {
  if (backup?.app !== "auto_ttb") throw new Error("Not an Auto TTB backup file.");
  for (const te of backup.tes || []) {
    await done((await store("tes", "readwrite")).put(te));
    for (const old of await shotsForTe(te.te_key)) await deleteShot(old.id);
  }
  for (const s of backup.shots || []) {
    const { data, ...rest } = s;
    const blob = await (await fetch(data)).blob();
    await addShot({ ...rest, blob });
  }
}
