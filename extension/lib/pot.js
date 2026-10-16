// Builds the Proof of Testing (PoT) Word document for one test execution.
// Same layout as the Python app's poc_doc.py: a header banner, then per test
// case a banner with its status and the Expected / Actual screenshots side by side.

import {
  AlignmentType, BorderStyle, Document, ImageRun, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType,
} from "./vendor/docx.mjs";

const STATUS_COLORS = {
  PASS: ["DCFCE7", "166534"],
  FAIL: ["FEE2E2", "991B1B"],
  PENDING: ["FEF3C7", "D97706"],
  BLOCKED: ["F3E8FF", "A855F7"],
};
const PAGE_WIDTH = 10800; // twips inside 0.45" margins on A4/Letter
const IMG_MAX_H = 170; // px
const border = (color) => ({ style: BorderStyle.SINGLE, size: 4, color });
const borders = (color) => ({
  top: border(color), bottom: border(color), left: border(color), right: border(color),
  insideHorizontal: border(color), insideVertical: border(color),
});
const shade = (fill) => ({ fill, type: ShadingType.CLEAR, color: "auto" });
const run = (text, opts = {}) => new TextRun({ text, font: "Calibri", ...opts });
const para = (children, opts = {}) => new Paragraph({ spacing: { before: 0, after: 0 }, children, ...opts });
const margins = (v) => ({ top: v, bottom: v, left: v * 2.5, right: v * 2.5 });

function labelled(label, value, color, boldValue = false) {
  return para([
    run(label, { bold: true, size: 17, color }),
    run(value, { size: 17, color, bold: boldValue }),
  ]);
}

function images(shots, maxWidth) {
  const children = [];
  for (const s of shots) {
    const scale = Math.min(IMG_MAX_H / s.height, maxWidth / s.width, 1);
    if (children.length) children.push(run("  "));
    children.push(new ImageRun({
      type: s.type,
      data: s.data,
      transformation: { width: Math.round(s.width * scale), height: Math.round(s.height * scale) },
    }));
  }
  return para(children, { alignment: AlignmentType.CENTER });
}

function tcBlock(tc, shots) {
  const status = (tc.status || "pending").toUpperCase();
  const [bg, fg] = STATUS_COLORS[status] || ["F1F5F9", "64748B"];
  const info = [para([run(`Test Case: ${tc.key}`, { bold: true, size: 20, color: "0F172A" })])];
  if (tc.summary) info.push(labelled("Summary: ", tc.summary, "475569"));
  if (tc.defect_key) info.push(labelled("Linked Defect: ", tc.defect_key, "B91C1C", true));
  if (tc.note) info.push(labelled("Note: ", tc.note, "475569"));
  if (status === "PENDING") info.push(para([run("Awaiting execution", { italics: true, size: 17, color: "64748B" })]));

  const out = [new Table({
    width: { size: PAGE_WIDTH, type: WidthType.DXA },
    columnWidths: [PAGE_WIDTH - 2400, 2400],
    borders: borders("CBD5E1"),
    rows: [new TableRow({ children: [
      new TableCell({ children: info, shading: shade("F8FAFC"), margins: margins(40), width: { size: PAGE_WIDTH - 2400, type: WidthType.DXA } }),
      new TableCell({
        children: [para([run(`[ ${status} ]`, { bold: true, size: 19, color: fg })], { alignment: AlignmentType.CENTER })],
        shading: shade(bg), margins: margins(40), width: { size: 2400, type: WidthType.DXA },
      }),
    ] })],
  })];

  const expected = shots.filter((s) => s.category === "expected");
  const actual = shots.filter((s) => s.category === "actual");
  const groups = [["Expected Result", expected], ["Actual Result (Test Evidence)", actual]].filter(([, s]) => s.length);
  if (groups.length) {
    const colWidth = Math.floor(PAGE_WIDTH / groups.length);
    const maxImgWidth = Math.floor((colWidth / 1440) * 96) - 20;
    out.push(new Table({
      width: { size: PAGE_WIDTH, type: WidthType.DXA },
      columnWidths: groups.map(() => colWidth),
      borders: borders("E2E8F0"),
      rows: [
        new TableRow({ children: groups.map(([title]) => new TableCell({
          children: [para([run(title, { bold: true, size: 15, color: "1E293B" })])],
          shading: shade("F1F5F9"), margins: margins(30), width: { size: colWidth, type: WidthType.DXA },
        })) }),
        new TableRow({ children: groups.map(([, s]) => new TableCell({
          children: [images(s, maxImgWidth)], margins: margins(40), width: { size: colWidth, type: WidthType.DXA },
        })) }),
      ],
    }));
  }
  out.push(new Paragraph({ spacing: { before: 80, after: 80 }, children: [] }));
  return out;
}

// te: the stored TE; shots: [{ tc_key, category, type: "png"|"jpg"|"gif"|"bmp", data: ArrayBuffer|Uint8Array, width, height }]
export function buildPotDocument(te, shots, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const meta = [`Test Execution: ${te.te_key}`, te.environment, te.language, `Generated: ${stamp}`].filter(Boolean).join("  |  ");
  const header = new Table({
    width: { size: PAGE_WIDTH, type: WidthType.DXA },
    columnWidths: [PAGE_WIDTH],
    rows: [new TableRow({ children: [new TableCell({
      shading: shade("1E293B"),
      margins: { top: 80, bottom: 80, left: 160, right: 160 },
      children: [
        para([run("PROOF OF TESTING (POT) REPORT", { bold: true, size: 24, color: "FFFFFF" })]),
        ...(te.summary ? [para([run(te.summary, { size: 18, color: "E2E8F0" })])] : []),
        para([run(meta, { size: 17, color: "94A3B8" })]),
      ],
    })] })],
  });
  const body = [header, new Paragraph({ spacing: { before: 0, after: 40 }, children: [] })];
  for (const tc of te.test_cases || []) body.push(...tcBlock(tc, shots.filter((s) => s.tc_key === tc.key)));
  return new Document({
    creator: "Auto TTB",
    title: `PoT ${te.te_key}`,
    sections: [{ properties: { page: { margin: { top: 648, bottom: 648, left: 648, right: 648 } } }, children: body }],
  });
}

export function buildPotBlob(te, shots, now) {
  return Packer.toBlob(buildPotDocument(te, shots, now));
}
