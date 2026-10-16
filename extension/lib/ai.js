// Gemini defect drafting. Asks for strict JSON instead of parsing prose.

const API = "https://generativelanguage.googleapis.com/v1beta/models";

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING", description: "Concise bug title, 4-8 words, no trailing punctuation" },
    scenario: { type: "STRING", description: "The test scenario being executed" },
    steps: { type: "STRING", description: "Numbered steps to recreate, one per line" },
    expected: { type: "STRING", description: "What should have happened per requirements or design" },
    actual: { type: "STRING", description: "What actually happened, as seen in the actual screenshots" },
  },
  required: ["title", "scenario", "steps", "expected", "actual"],
};

function systemPrompt(environment) {
  return `You are helping a QA engineer write a structured Jira defect for ${environment || "the current environment"} testing.
You get the engineer's notes, optionally the test case, and screenshots: EXPECTED (requirements / Figma design) and ACTUAL (the bug).
Write clean, professional, concise QA content. Don't invent details that the notes or screenshots don't support. Plain text, no markdown.`;
}

// images: [{ category: "expected" | "actual", mime, base64 }]
export async function draftDefect({ apiKey, model, notes, environment, testCase, images = [] }, fetchImpl = globalThis.fetch.bind(globalThis)) {
  if (!apiKey) throw new Error("Set the Gemini API key in Settings to draft defects with AI.");
  const parts = [];
  for (const category of ["expected", "actual"]) {
    const imgs = images.filter((i) => i.category === category);
    if (!imgs.length) continue;
    parts.push({ text: category === "expected" ? "EXPECTED RESULT / DESIGN screenshots:" : "ACTUAL RESULT (bug) screenshots:" });
    for (const i of imgs) parts.push({ inline_data: { mime_type: i.mime, data: i.base64 } });
  }
  if (testCase) parts.push({ text: `Test case: ${testCase}` });
  parts.push({ text: `QA notes: ${notes || "(none)"}` });

  let resp;
  try {
    resp = await fetchImpl(`${API}/${encodeURIComponent(model || "gemini-2.5-flash")}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(environment) }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
    });
  } catch (e) {
    throw new Error(`Could not reach Gemini (${e.message}). Check that your network allows ${GEMINI_ORIGIN}.`);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Gemini error (HTTP ${resp.status}): ${data?.error?.message || "no details"}`);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || "unreadable answer";
    throw new Error(`Gemini didn't return a draft (${reason}).`);
  }
  const clean = (v) => String(v ?? "").trim();
  return {
    title: clean(out.title).replace(/^["']|["']$/g, "").replace(/[.!]+$/, ""),
    scenario: clean(out.scenario),
    steps: clean(out.steps),
    expected: clean(out.expected),
    actual: clean(out.actual),
  };
}
