import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateRawSync } from "node:zlib";
import { buildPotBlob } from "../lib/pot.js";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Minimal zip reader: returns { name: Buffer } for deflated/stored entries
function unzip(buf) {
  const files = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8), size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26), extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    files[name] = method === 8 ? inflateRawSync(data) : data;
    i += 30 + nameLen + extra + size;
  }
  return files;
}

test("PoT document lists every test case with status and screenshots", async () => {
  const te = {
    te_key: "QA-1", summary: "Login flows", environment: "UAT", language: "English",
    test_cases: [
      { key: "QA-2", summary: "Valid login", status: "pass" },
      { key: "QA-3", summary: "Wrong password", status: "fail", defect_key: "QA-9", note: "500 on submit" },
      { key: "QA-4", summary: "Locked account", status: "pending" },
    ],
  };
  const shot = (tc_key, category, w) => ({ tc_key, category, type: "png", data: png(w, 800), width: w, height: 800 });
  const shots = [shot("QA-2", "actual", 400), shot("QA-3", "expected", 401), shot("QA-3", "actual", 402)];
  const blob = await buildPotBlob(te, shots, new Date(2026, 9, 16, 10, 0));
  const files = unzip(Buffer.from(await blob.arrayBuffer()));
  const xml = files["word/document.xml"].toString();
  for (const text of ["PROOF OF TESTING (POT) REPORT", "Login flows", "Test Case: QA-2", "[ PASS ]", "[ FAIL ]", "[ PENDING ]", "QA-9", "500 on submit", "Awaiting execution", "Expected Result", "Actual Result (Test Evidence)", "2026-10-16 10:00"]) {
    assert.ok(xml.includes(text), `missing ${text}`);
  }
  assert.equal(Object.keys(files).filter((n) => /^word\/media\/.+\.png$/.test(n)).length, 3);
  // Images are scaled to at most 170px tall: 170px * 9525 EMU
  assert.match(xml, /cy="1619250"/);
});
