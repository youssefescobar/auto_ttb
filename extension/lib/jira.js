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
      throw new JiraError(`${method} ${path} failed (HTTP ${resp.status}): ${detail}`, resp.status);
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

  // Xray keeps a test's result on its test run inside the execution, not on the
  // Test issue's workflow. status: PASS, FAIL, TODO, or a custom Xray status.
  async setTestRunStatus(teKey, testKey, status, runId) {
    let id = runId;
    if (!id) {
      const run = await this.request("GET", "/rest/raven/1.0/api/testrun", { params: { testExecIssueKey: teKey, testIssueKey: testKey } });
      id = run?.id;
      if (!id) throw new JiraError(`${testKey} has no test run in ${teKey}.`);
    }
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
