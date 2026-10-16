import { test } from "node:test";
import assert from "node:assert/strict";
import { Jira, parseIssueKey } from "../lib/jira.js";

function fakeJira(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), init });
    const handler = routes[`${init.method} ${u.pathname}`];
    const [status, body] = handler ? handler(u, init) : [404, { errorMessages: ["not found"] }];
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return { status, text: async () => text };
  };
  return { jira: new Jira("https://jira.example.com/", fetch), calls };
}

test("parses keys and Jira URLs", () => {
  assert.equal(parseIssueKey("qa-12"), "QA-12");
  assert.equal(parseIssueKey("https://jira.example.com/browse/BDR-4021?focusedId=1"), "BDR-4021");
  assert.equal(parseIssueKey("https://jira.example.com/secure/RapidBoard.jspa?selectedIssue=AB-7"), "AB-7");
  assert.equal(parseIssueKey("not a key"), "");
});

test("sends the browser session and XSRF header", async () => {
  const { jira, calls } = fakeJira({ "GET /rest/api/2/myself": () => [200, { name: "qa1" }] });
  assert.deepEqual(await jira.myself(), { name: "qa1" });
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.headers["X-Atlassian-Token"], "no-check");
});

test("401 and an HTML login page both read as not logged in", async () => {
  let { jira } = fakeJira({ "GET /rest/api/2/myself": () => [401, ""] });
  await assert.rejects(jira.myself(), /Not logged in/);
  ({ jira } = fakeJira({ "GET /rest/api/2/myself": () => [200, "<html>login</html>"] }));
  await assert.rejects(jira.myself(), /Not logged in/);
});

test("Jira error messages are surfaced", async () => {
  const { jira } = fakeJira({ "GET /rest/api/2/issue/QA-1": () => [404, { errorMessages: ["Issue does not exist"] }] });
  await assert.rejects(jira.fetchTestExecution("QA-1"), /Issue does not exist/);
});

test("transitions by name or target status, and lists what is available otherwise", async () => {
  const { jira, calls } = fakeJira({
    "GET /rest/api/2/issue/QA-2/transitions": () => [200, { transitions: [{ id: "11", name: "Start Progress" }, { id: "21", name: "Mark passed", to: { name: "Pass" } }] }],
    "POST /rest/api/2/issue/QA-2/transitions": () => [204],
  });
  await jira.transition("QA-2", "pass");
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { transition: { id: "21" } });
  await assert.rejects(jira.transition("QA-2", "Fail"), /available: Start Progress, Mark passed/);
});

test("test execution: Xray tests first, summaries looked up in one search", async () => {
  const { jira, calls } = fakeJira({
    "GET /rest/api/2/issue/QA-1": () => [200, { fields: { summary: "Sprint 5 run", issuelinks: [] } }],
    "GET /rest/raven/1.0/api/testexec/QA-1/test": () => [200, [{ key: "QA-10" }, { key: "QA-9" }]],
    "GET /rest/api/2/search": () => [200, { issues: [{ key: "QA-9", fields: { summary: "Nine" } }, { key: "QA-10", fields: { summary: "Ten" } }] }],
  });
  const te = await jira.fetchTestExecution("qa-1");
  assert.equal(te.summary, "Sprint 5 run");
  assert.equal(te.url, "https://jira.example.com/browse/QA-1");
  assert.deepEqual(te.test_cases, [{ key: "QA-9", summary: "Nine" }, { key: "QA-10", summary: "Ten" }]);
  assert.equal(calls.find((c) => c.path === "/rest/api/2/search").query.jql, "key in (QA-9,QA-10)");
});

test("test execution without Xray falls back to links and sub-tasks", async () => {
  const { jira } = fakeJira({
    "GET /rest/api/2/issue/QA-1": () => [200, { fields: { summary: "", issuelinks: [{ outwardIssue: { key: "QA-3" } }, { inwardIssue: { key: "QA-1" } }], subtasks: [{ key: "QA-4" }] } }],
    "GET /rest/api/2/search": () => [200, { issues: [] }],
  });
  const te = await jira.fetchTestExecution("QA-1");
  assert.deepEqual(te.test_cases.map((t) => t.key), ["QA-3", "QA-4"]);
});

test("comment uploads screenshots and embeds them as thumbnails", async () => {
  const { jira, calls } = fakeJira({
    "POST /rest/api/2/issue/QA-2/attachments": () => [200, [{}]],
    "POST /rest/api/2/issue/QA-2/comment": () => [201, {}],
  });
  await jira.comment("QA-2", "Passed", [{ name: "a.png", blob: new Blob(["x"]) }]);
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(JSON.parse(calls[1].init.body).body, "Passed\n\n!a.png|thumbnail!");
});
