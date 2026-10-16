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

test("test execution: Xray tests first, summaries looked up in one search", async () => {
  const { jira, calls } = fakeJira({
    "GET /rest/api/2/issue/QA-1": () => [200, { fields: { summary: "Sprint 5 run", issuelinks: [] } }],
    "GET /rest/raven/1.0/api/testexec/QA-1/test": () => [200, [{ key: "QA-10" }, { key: "QA-9" }]],
    "GET /rest/api/2/search": () => [200, { issues: [{ key: "QA-9", fields: { summary: "Nine" } }, { key: "QA-10", fields: { summary: "Ten" } }] }],
  });
  const te = await jira.fetchTestExecution("qa-1");
  assert.equal(te.summary, "Sprint 5 run");
  assert.equal(te.url, "https://jira.example.com/browse/QA-1");
  assert.deepEqual(te.test_cases.map(({ key, summary }) => ({ key, summary })), [{ key: "QA-9", summary: "Nine" }, { key: "QA-10", summary: "Ten" }]);
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

test("Xray executions return test run ids and statuses", async () => {
  const { jira } = fakeJira({
    "GET /rest/api/2/issue/QA-1": () => [200, { fields: { summary: "" } }],
    "GET /rest/raven/1.0/api/testexec/QA-1/test": () => [200, [{ id: 501, key: "QA-2", status: "TODO" }, { id: 502, key: "QA-3", status: "PASS" }]],
    "GET /rest/api/2/search": () => [200, { issues: [] }],
  });
  const te = await jira.fetchTestExecution("QA-1");
  assert.equal(te.xray, true);
  assert.deepEqual(te.test_cases.map((t) => [t.key, t.run_id, t.xray_status]), [["QA-2", 501, "TODO"], ["QA-3", 502, "PASS"]]);
});

test("sets the Xray test run status, looking the run up when its id is unknown", async () => {
  const { jira, calls } = fakeJira({
    "GET /rest/raven/1.0/api/testrun": (u) => [200, u.searchParams.get("testIssueKey") === "QA-2" ? { id: 501 } : {}],
    "PUT /rest/raven/1.0/api/testrun/501/status": () => [200, ""],
  });
  assert.equal(await jira.setTestRunStatus("QA-1", "QA-2", "PASS"), 501);
  const put = calls.at(-1);
  assert.equal(put.method, "PUT");
  assert.equal(put.query.status, "PASS");
  assert.equal(calls[0].query.testExecIssueKey, "QA-1");
  await jira.setTestRunStatus("QA-1", "QA-2", "FAIL", 501);
  assert.equal(calls.length, 3); // no lookup with a known id
  await assert.rejects(jira.setTestRunStatus("QA-1", "QA-7", "PASS"), /no test run/);
});
