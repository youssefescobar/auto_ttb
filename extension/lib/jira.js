// Jira Server / Data Center REST client. Uses the browser's own Jira login
// (session cookies), so no token or password is stored anywhere.

export class JiraError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Jira {
  constructor(baseUrl, fetchImpl = globalThis.fetch.bind(globalThis)) {
    if (!baseUrl) throw new JiraError("Set the Jira base URL in Settings.");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  async request(method, path, { json, form, params } = {}) {
    let url = this.baseUrl + path;
    if (params) url += "?" + new URLSearchParams(params).toString();
    const headers = { Accept: "application/json", "X-Atlassian-Token": "no-check" };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    let resp;
    try {
      resp = await this.fetch(url, { method, headers, body, credentials: "include" });
    } catch (e) {
      throw new JiraError(`Could not reach Jira at ${this.baseUrl} (${e.message}). Check the URL and that you are on the company network.`);
    }
    if (resp.status === 401) {
      throw new JiraError("Not logged in to Jira. Open Jira in a tab, log in, then try again.", 401);
    }
    const text = await resp.text();
    if (resp.status >= 400) {
      let detail = text.slice(0, 300);
      try {
        const data = JSON.parse(text);
        const msgs = [...(data.errorMessages || []), ...Object.entries(data.errors || {}).map(([k, v]) => `${k}: ${v}`)];
        if (msgs.length) detail = msgs.join("; ");
      } catch { /* not JSON */ }
      if (resp.status === 403 && /XSRF/i.test(text)) {
        detail = "Jira's XSRF check rejected the request. Reload the extension and try again.";
      }
      const err = new JiraError(`${method} ${path} failed (HTTP ${resp.status}): ${detail}`, resp.status);
      try { err.body = JSON.parse(text); } catch { /* not JSON */ }
      throw err;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Jira answers with its HTML login page when the session has expired
      throw new JiraError("Not logged in to Jira. Open Jira in a tab, log in, then try again.", 401);
    }
  }

  myself() {
    return this.request("GET", "/rest/api/2/myself");
  }

  issueUrl(key) {
    return `${this.baseUrl}/browse/${encodeURIComponent(key)}`;
  }

  // files: [{ name, blob }]
  async attach(issueKey, files) {
    const names = [];
    for (const f of files || []) {
      const form = new FormData();
      form.append("file", f.blob, f.name);
      await this.request("POST", `/rest/api/2/issue/${issueKey}/attachments`, { form });
      names.push(f.name);
    }
    return names;
  }

  async comment(issueKey, body, files = []) {
    const names = await this.attach(issueKey, files);
    let text = body || "Test evidence:";
    if (names.length) text += "\n\n" + names.map((n) => `!${n}|thumbnail!`).join("\n");
    await this.request("POST", `/rest/api/2/issue/${issueKey}/comment`, { json: { body: text } });
  }

  async summaries(keys) {
    const out = {};
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const res = await this.request("GET", "/rest/api/2/search", {
        params: { jql: `key in (${chunk.join(",")})`, fields: "summary", maxResults: String(chunk.length) },
      });
      for (const issue of res?.issues || []) out[issue.key] = issue.fields?.summary || "";
    }
    return out;
  }

  // Returns { te_key, summary, url, xray, xray_error, test_cases: [{ key, summary, run_id?, xray_status? }] }.
  // Tries Xray's Test Execution API, then the issue's links and sub-tasks.
  async fetchTestExecution(teKey) {
    const te = teKey.toUpperCase();
    const issue = await this.request("GET", `/rest/api/2/issue/${te}`, { params: { fields: "summary,issuelinks,subtasks" } });
    const fields = issue?.fields || {};
    const runs = {}; // test key -> { run_id, xray_status }
    let xrayError = "";
    try {
      const tests = await this.request("GET", `/rest/raven/1.0/api/testexec/${te}/test`);
      for (const t of tests || []) {
        if (t.key) runs[t.key.toUpperCase()] = { run_id: t.id, xray_status: t.status };
      }
    } catch (e) {
      if (e.status === 401) throw e; // anything else: Xray missing or not a Test Execution
      xrayError = e.message;
    }
    const xray = Object.keys(runs).length > 0;
    let keys = Object.keys(runs);
    if (!xray) {
      for (const link of fields.issuelinks || []) {
        const other = link.outwardIssue || link.inwardIssue;
        if (other?.key) keys.push(other.key);
      }
      for (const s of fields.subtasks || []) if (s.key) keys.push(s.key);
    }
    keys = [...new Set(keys.map((k) => k.toUpperCase()))].filter((k) => k !== te).sort(compareKeys);
    const names = keys.length ? await this.summaries(keys) : {};
    return {
      te_key: te,
      summary: fields.summary || "",
      url: this.issueUrl(te),
      xray,
      xray_error: xray ? "" : xrayError || "Xray returned no tests for this issue.",
      test_cases: keys.map((k) => ({ key: k, summary: names[k] || "", ...runs[k] })),
    };
  }

  // --- Defects --------------------------------------------------------------

  // Returns { typeId, fields: { fieldId: meta } } for the project's create screen.
  async createMeta(projectKey, issueType) {
    try {
      const types = await this.request("GET", `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`);
      const list = types?.values || (Array.isArray(types) ? types : []);
      const it = list.find((t) => (t.name || "").toLowerCase() === issueType.toLowerCase());
      if (!it) throw new JiraError(`Issue type "${issueType}" not found in project ${projectKey} (available: ${list.map((t) => t.name).join(", ") || "none"}).`);
      const fields = {};
      for (let start = 0; ;) {
        const page = await this.request("GET", `/rest/api/2/issue/createmeta/${projectKey}/issuetypes/${it.id}`, { params: { startAt: String(start), maxResults: "100" } });
        const values = page?.values || [];
        for (const f of values) fields[f.fieldId] = f;
        start += values.length;
        if (page?.isLast !== false || !values.length) break;
      }
      return { typeId: it.id, fields };
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    // Jira older than 8.4
    const res = await this.request("GET", "/rest/api/2/issue/createmeta", {
      params: { projectKeys: projectKey, issuetypeNames: issueType, expand: "projects.issuetypes.fields" },
    });
    const it = res?.projects?.[0]?.issuetypes?.[0];
    if (!it) throw new JiraError(`No create screen found for ${projectKey} / ${issueType}.`);
    return { typeId: it.id, fields: it.fields || {} };
  }

  async findUser(query) {
    if (!query) return null;
    try {
      const users = await this.request("GET", "/rest/api/2/user/search", { params: { username: query, maxResults: "5" } });
      return users?.[0]?.name || null;
    } catch {
      return null;
    }
  }

  // Creates the issue. If Jira rejects specific fields, drops them and retries once.
  // Returns { key, dropped: ["field (reason)"] }.
  async createIssue(fields) {
    try {
      const created = await this.request("POST", "/rest/api/2/issue", { json: { fields } });
      return { key: created.key, dropped: [] };
    } catch (e) {
      const bad = e.status === 400 ? e.body?.errors || {} : {};
      const droppable = Object.keys(bad).filter((f) => f in fields && !["project", "issuetype", "summary"].includes(f));
      if (!droppable.length || droppable.length !== Object.keys(bad).length) throw e;
      const retry = { ...fields };
      for (const f of droppable) delete retry[f];
      const created = await this.request("POST", "/rest/api/2/issue", { json: { fields: retry } });
      return { key: created.key, dropped: droppable.map((f) => `${f} (${bad[f]})`) };
    }
  }

  async linkIssues(fromKey, toKey, linkName = "relates to") {
    const types = (await this.request("GET", "/rest/api/2/issueLinkType"))?.issueLinkTypes || [];
    const wanted = linkName.toLowerCase();
    const lt = types.find((t) => [t.name, t.outward, t.inward].some((n) => (n || "").toLowerCase() === wanted))
      || types.find((t) => (t.name || "").toLowerCase() === "relates");
    if (!lt) throw new JiraError(`Link type "${linkName}" not found.`);
    await this.request("POST", "/rest/api/2/issueLink", {
      json: { type: { name: lt.name }, inwardIssue: { key: toKey }, outwardIssue: { key: fromKey } },
    });
  }

  async search(jql, fields = "summary,status", maxResults = 10) {
    const res = await this.request("GET", "/rest/api/2/search", { params: { jql, fields, maxResults: String(maxResults) } });
    return res?.issues || [];
  }

  async testRunId(teKey, testKey) {
    const run = await this.request("GET", "/rest/raven/1.0/api/testrun", { params: { testExecIssueKey: teKey, testIssueKey: testKey } });
    if (!run?.id) throw new JiraError(`${testKey} has no test run in ${teKey}.`);
    return run.id;
  }

  // Adds a defect to an Xray test run (shows under the run's Defects).
  async addDefectToTestRun(runId, defectKey) {
    await this.request("PUT", `/rest/raven/1.0/api/testrun/${runId}`, { json: { defects: { add: [defectKey] } } });
  }

  // Xray keeps a test's result on its test run inside the execution, not on the
  // Test issue's workflow. status: PASS, FAIL, TODO, or a custom Xray status.
  async setTestRunStatus(teKey, testKey, status, runId) {
    const id = runId || (await this.testRunId(teKey, testKey));
    await this.request("PUT", `/rest/raven/1.0/api/testrun/${id}/status`, { params: { status } });
    return id;
  }
}

// "ABC-123", or a pasted Jira URL containing /browse/ABC-123 or selectedIssue=ABC-123
export function parseIssueKey(input) {
  const s = String(input || "").trim();
  const m = s.match(/(?:browse\/|selectedIssue=)([A-Za-z][A-Za-z0-9_]*-\d+)/) || s.match(/^([A-Za-z][A-Za-z0-9_]*-\d+)$/);
  return m ? m[1].toUpperCase() : "";
}

export function compareKeys(a, b) {
  const [pa, na] = a.split("-");
  const [pb, nb] = b.split("-");
  return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb);
}
