"""
Jira Server / Data Center REST API client.

Authenticates with either:
  - a Personal Access Token (Profile -> Personal Access Tokens, Jira DC 8.14+), or
  - the login session saved by the one-time browser login (jira_session.json):
    Jira's REST API accepts the same session cookies as the web UI, so no token
    or password is needed.
jira_actions.py falls back to driving the Jira UI with Playwright when neither exists.
"""
import json
import os
import re
import time

import requests

import config

# Config keys holding the Jira custom field IDs (set on the Config page; empty = skip the field).
FIELD_FOR_PROJECT = "field_for_project"
FIELD_DEMO = "field_demo"
FIELD_SEVERITY = "field_severity"
FIELD_TCS_BLOCKED = "field_tcs_blocked"
FIELD_IMPACTED_SYSTEM = "field_impacted_system"
FIELD_SCENARIO = "field_scenario"
FIELD_EXPECTED = "field_expected"
FIELD_ACTUAL = "field_actual"
FIELD_STEPS = "field_steps"
FIELD_QA_ANALYSIS = "field_qa_analysis"
FIELD_TEST_DATA = "field_test_data"
FIELD_DEFECT_TYPE = "field_defect_type"
FIELD_ENVIRONMENT = "field_environment"
FIELD_PHASE = "field_phase"
FIELD_USABILITY = "field_usability"
FIELD_REOCCURRENCE = "field_reoccurrence"
FIELD_NEWSTACK = "field_newstack"
FIELD_CATEGORY = "field_category"
FIELD_MILESTONE = "field_milestone"
FIELD_UAT_PRIORITY = "field_uat_priority"


class JiraRestError(Exception):
    pass


def auth_mode() -> str | None:
    """'token', 'session', or None when REST can't be used."""
    if str(config.get("jira_mode")).lower() == "browser":
        return None
    if config.get("jira_pat"):
        return "token"
    if os.path.exists(config.BROWSER_STATE_PATH):
        return "session"
    return None


def is_enabled() -> bool:
    return auth_mode() is not None


def base_url() -> str:
    url = config.get("jira_base_url")
    if not url:
        raise JiraRestError("Set the Jira base URL on the Config page.")
    return url


def _load_session_cookies(s: requests.Session):
    """Copies the Jira cookies saved by the browser login into a requests session."""
    try:
        with open(config.BROWSER_STATE_PATH, "r", encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError) as e:
        raise JiraRestError(f"Could not read the saved Jira login: {e}")
    host = re.sub(r"^https?://", "", base_url()).split("/")[0].split(":")[0].lower()
    for c in state.get("cookies", []):
        domain = c.get("domain", "").lstrip(".").lower()
        if domain and (host == domain or host.endswith("." + domain)):
            s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))


def _session() -> requests.Session:
    mode = auth_mode()
    if mode is None:
        raise JiraRestError("No Jira token or saved Jira login. Log in to Jira or set a token on the Config page.")
    s = requests.Session()
    s.headers.update({
        "Accept": "application/json",
        # Required by Jira's XSRF check for cookie-authenticated writes
        "X-Atlassian-Token": "no-check",
    })
    if mode == "token":
        s.headers["Authorization"] = f"Bearer {config.get('jira_pat')}"
    else:
        _load_session_cookies(s)
    # Corporate CA bundle, if the Jira host uses an internal certificate authority
    ca_bundle = config.get("jira_ca_bundle")
    if ca_bundle:
        s.verify = ca_bundle
    return s


def _request(method: str, path: str, **kwargs):
    url = f"{base_url()}{path}"
    kwargs.setdefault("timeout", 30)
    resp = _session().request(method, url, **kwargs)
    if resp.status_code == 401:
        hint = ("Jira login expired: click 'Login to Jira' and save the session again."
                if auth_mode() == "session" else "Jira token rejected: check or replace it on the Config page.")
        err = JiraRestError(f"{method} {path} -> HTTP 401. {hint}")
        err.status_code = 401
        err.response = resp
        raise err
    if resp.status_code >= 400:
        detail = resp.text[:500]
        try:
            body = resp.json()
            msgs = body.get("errorMessages", []) + [f"{k}: {v}" for k, v in body.get("errors", {}).items()]
            if msgs:
                detail = "; ".join(msgs)
        except ValueError:
            pass
        err = JiraRestError(f"{method} {path} -> HTTP {resp.status_code}: {detail}")
        err.status_code = resp.status_code
        err.response = resp
        raise err
    if resp.status_code == 204 or not resp.content:
        return None
    return resp.json()


_connection_cache = {"at": 0.0, "result": None}


def check_connection(max_age_seconds: int = 60) -> dict:
    """Returns the authenticated user (cached briefly), used by the UI status indicator."""
    if _connection_cache["result"] and time.time() - _connection_cache["at"] < max_age_seconds:
        return _connection_cache["result"]
    me = _request("GET", "/rest/api/2/myself")
    result = {"name": me.get("name"), "display_name": me.get("displayName"), "auth": auth_mode()}
    _connection_cache.update(at=time.time(), result=result)
    return result


# --- Transitions ---------------------------------------------------------

def transition_issue(issue_key: str, transition_name: str):
    data = _request("GET", f"/rest/api/2/issue/{issue_key}/transitions")
    transitions = data.get("transitions", [])
    wanted = transition_name.strip().lower()
    match = next(
        (t for t in transitions
         if t.get("name", "").lower() == wanted or t.get("to", {}).get("name", "").lower() == wanted),
        None,
    )
    if not match:
        available = ", ".join(t.get("name", "") for t in transitions) or "none"
        raise JiraRestError(f"Transition '{transition_name}' not available on {issue_key} (available: {available})")
    _request("POST", f"/rest/api/2/issue/{issue_key}/transitions", json={"transition": {"id": match["id"]}})
    print(f"  -> {issue_key} transitioned to '{transition_name}' (REST)")


# --- Attachments & comments ----------------------------------------------

def attach_files(issue_key: str, paths: list[str]) -> list[str]:
    """Uploads files to an issue, returns the uploaded filenames."""
    uploaded = []
    for path in paths or []:
        if not path or not os.path.exists(path):
            continue
        with open(path, "rb") as f:
            _request(
                "POST",
                f"/rest/api/2/issue/{issue_key}/attachments",
                headers={"X-Atlassian-Token": "no-check"},
                files={"file": (os.path.basename(path), f)},
                timeout=120,
            )
        uploaded.append(os.path.basename(path))
    return uploaded


def add_comment(issue_key: str, body: str, screenshot_paths: list[str] = None):
    names = attach_files(issue_key, screenshot_paths)
    text = body or "Test Evidence Screenshots:"
    if names:
        text += "\n\n" + "\n".join(f"!{n}|thumbnail!" for n in names)
    _request("POST", f"/rest/api/2/issue/{issue_key}/comment", json={"body": text})
    print(f"  [+] Comment with {len(names)} screenshot(s) added to {issue_key} (REST)")


# --- Test Execution -> Test Cases ------------------------------------------

def _summaries(keys: list[str]) -> dict:
    if not keys:
        return {}
    out = {}
    for i in range(0, len(keys), 100):
        chunk = keys[i:i + 100]
        res = _request("GET", "/rest/api/2/search", params={
            "jql": f"key in ({','.join(chunk)})",
            "fields": "summary",
            "maxResults": len(chunk),
        })
        for issue in res.get("issues", []):
            out[issue["key"]] = issue.get("fields", {}).get("summary", "")
    return out


def fetch_test_execution(te_key: str) -> dict | None:
    """
    Returns {te_key, summary, test_cases, url}, or None when no TCs could be
    found over REST (the caller then falls back to scraping the page).
    Tries Xray's Test Execution API, then the issue's links and sub-tasks.
    """
    issue = _request("GET", f"/rest/api/2/issue/{te_key}", params={"fields": "summary,issuelinks,subtasks"})
    fields = issue.get("fields", {})
    keys = []

    try:
        tests = _request("GET", f"/rest/raven/1.0/api/testexec/{te_key}/test")
        keys = [t["key"] for t in (tests or []) if t.get("key")]
    except JiraRestError:
        pass  # Xray not installed or not a Test Execution

    if not keys:
        for link in fields.get("issuelinks", []):
            other = link.get("outwardIssue") or link.get("inwardIssue")
            if other and other.get("key"):
                keys.append(other["key"])
        keys += [s["key"] for s in fields.get("subtasks", []) if s.get("key")]

    keys = sorted(set(k.upper() for k in keys if k.upper() != te_key.upper()))
    if not keys:
        return None

    names = _summaries(keys)
    return {
        "te_key": te_key,
        "summary": fields.get("summary", ""),
        "test_cases": [{"key": k, "name": f"{k} {names.get(k, '')}".strip()} for k in keys],
        "url": f"{base_url()}/browse/{te_key}",
    }


# --- Defect creation -------------------------------------------------------

def _project_key() -> str:
    explicit = config.get("jira_project")
    if explicit:
        return explicit
    m = re.search(r"\(([A-Z][A-Z0-9_]+)\)", config.get("project") or "")
    if m:
        return m.group(1)
    raise JiraRestError("Set the Jira project key on the Config page.")


def _create_meta(project_key: str, issue_type: str) -> tuple[str, dict]:
    """Returns (issue_type_id, {field_id: field_meta}) for the create screen."""
    try:
        types = _request("GET", f"/rest/api/2/issue/createmeta/{project_key}/issuetypes")
        values = types.get("values", types if isinstance(types, list) else [])
        it = next((t for t in values if t.get("name", "").lower() == issue_type.lower()), None)
        if not it:
            raise JiraRestError(f"Issue type '{issue_type}' not found in project {project_key}")
        fields, start = {}, 0
        while True:
            page = _request("GET", f"/rest/api/2/issue/createmeta/{project_key}/issuetypes/{it['id']}",
                            params={"startAt": start, "maxResults": 100})
            for f in page.get("values", []):
                fields[f["fieldId"]] = f
            start += len(page.get("values", []))
            if page.get("isLast", True) or not page.get("values"):
                break
        return it["id"], fields
    except JiraRestError as e:
        if getattr(e, "status_code", None) != 404:
            raise
    # Jira < 8.4
    res = _request("GET", "/rest/api/2/issue/createmeta", params={
        "projectKeys": project_key, "issuetypeNames": issue_type,
        "expand": "projects.issuetypes.fields",
    })
    try:
        it = res["projects"][0]["issuetypes"][0]
    except (KeyError, IndexError):
        raise JiraRestError(f"No create metadata for {project_key}/{issue_type}")
    return it["id"], it.get("fields", {})


# Names a field is commonly given on the Defect create screen, per Config key.
FIELD_NAMES = {
    FIELD_FOR_PROJECT: ["For Project"],
    FIELD_DEMO: ["Demo"],
    FIELD_SEVERITY: ["Defect Severity", "Severity"],
    FIELD_TCS_BLOCKED: ["Test Cases Blocked", "TCs Blocked", "No. of Test Cases Blocked"],
    FIELD_IMPACTED_SYSTEM: ["Impacted System", "Impacted Systems"],
    FIELD_SCENARIO: ["Scenario"],
    FIELD_EXPECTED: ["Expected Result", "Expected Results", "Expected"],
    FIELD_ACTUAL: ["Actual Result", "Actual Results", "Actual"],
    FIELD_STEPS: ["Steps to Recreate", "Steps to Reproduce", "Steps"],
    FIELD_QA_ANALYSIS: ["QA Analysis"],
    FIELD_TEST_DATA: ["Test Data"],
    FIELD_DEFECT_TYPE: ["Defect Type"],
    FIELD_ENVIRONMENT: ["Defect Environment", "Environment"],
    FIELD_PHASE: ["Defect Phase", "Phase"],
    FIELD_USABILITY: ["Usability Issue", "Usability"],
    FIELD_REOCCURRENCE: ["Re-occurrence", "Reoccurrence", "Re-Occurrence"],
    FIELD_NEWSTACK: ["NewStack Impact", "New Stack Impact"],
    FIELD_CATEGORY: ["Defect Category"],
    FIELD_MILESTONE: ["Milestone Type", "Milestone"],
    FIELD_UAT_PRIORITY: ["UAT Priority"],
}


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def detect_custom_fields(project_key: str = None, issue_type: str = None) -> dict:
    """
    Reads the Defect create screen and matches custom fields to Config keys by name.
    Returns {"found": {config_key: field_id}, "unmatched": [config_key], "fields": [{id, name}]}.
    """
    project_key = project_key or _project_key()
    issue_type = issue_type or config.get("defect_issue_type")
    _, meta = _create_meta(project_key, issue_type)
    custom = {fid: m.get("name", "") for fid, m in meta.items() if fid.startswith("customfield_")}
    by_name = {}
    for fid, name in custom.items():
        by_name.setdefault(_norm(name), fid)

    found, unmatched = {}, []
    for key, names in FIELD_NAMES.items():
        fid = next((by_name[_norm(n)] for n in names if _norm(n) in by_name), None)
        if fid:
            found[key] = fid
        else:
            unmatched.append(key)
    fields = sorted(({"id": fid, "name": name} for fid, name in custom.items()), key=lambda f: f["name"].lower())
    return {"found": found, "unmatched": unmatched, "fields": fields}


def _match_option(allowed: list, value: str):
    v = str(value).strip().lower()
    for opt in allowed or []:
        for k in ("value", "name", "key"):
            if str(opt.get(k, "")).strip().lower() == v:
                return opt
    return None


def _format_value(meta: dict, value):
    """Builds the REST payload for a field from its schema and allowed values."""
    schema = meta.get("schema", {})
    ftype = schema.get("type")
    custom = schema.get("custom", "")
    allowed = meta.get("allowedValues")

    if "cascadingselect" in custom:
        parent, child = value
        p = _match_option(allowed, parent)
        if not p:
            return None
        out = {"id": p["id"]}
        c = _match_option(p.get("children", []), child) if child else None
        if c:
            out["child"] = {"id": c["id"]}
        return out

    if ftype == "array":
        items = value if isinstance(value, list) else [v.strip() for v in str(value).split(",") if v.strip()]
        if schema.get("items") == "string":  # labels
            return [str(i).replace(" ", "_") for i in items]
        if allowed:
            matched = [_match_option(allowed, i) for i in items]
            return [{"id": m["id"]} for m in matched if m]
        return [{"name": i} for i in items]

    if ftype == "number":
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    if ftype in ("string",) and not allowed:
        return str(value)

    if ftype == "user":
        return {"name": value}

    if allowed:
        opt = _match_option(allowed, value)
        return {"id": opt["id"]} if opt else None

    if ftype in ("option", "priority"):
        return {"value": value} if ftype == "option" else {"name": value}
    return value


def _find_user(query: str) -> str | None:
    if not query:
        return None
    try:
        users = _request("GET", "/rest/api/2/user/search", params={"username": query, "maxResults": 5})
    except JiraRestError:
        return None
    return users[0]["name"] if users else None


def _link_issues(defect_key: str, other_key: str, link_name: str = "relates to"):
    types = _request("GET", "/rest/api/2/issueLinkType").get("issueLinkTypes", [])
    wanted = link_name.lower()
    lt = next((t for t in types if wanted in (t.get("name", "").lower(), t.get("outward", "").lower(),
                                               t.get("inward", "").lower())), None)
    if not lt:
        lt = next((t for t in types if t.get("name", "").lower() == "relates"), None)
    if not lt:
        print(f"  [!] Link type '{link_name}' not found; skipping link to {other_key}")
        return
    _request("POST", "/rest/api/2/issueLink", json={
        "type": {"name": lt["name"]},
        "inwardIssue": {"key": other_key},
        "outwardIssue": {"key": defect_key},
    })


def create_defect(summary: str, description: str, screenshot_paths: list[str],
                  assignee: str = None, priority: str = None, data: dict = None) -> str:
    """Creates the Defect over REST and returns its key. Mirrors jira_actions.create_defect."""
    data = data or {}
    project_key = _project_key()
    issue_type = config.get("defect_issue_type")
    type_id, meta = _create_meta(project_key, issue_type)

    wanted = {
        FIELD_FOR_PROJECT: config.get("for_project"),
        FIELD_DEMO: config.get("demo"),
        "components": config.get("components"),
        FIELD_SEVERITY: priority or data.get("severity") or config.get("priority"),
        FIELD_TCS_BLOCKED: str(data.get("blocked_tcs", "1")),
        FIELD_IMPACTED_SYSTEM: config.get("impacted_system"),
        FIELD_SCENARIO: data.get("scenario"),
        FIELD_EXPECTED: data.get("expected"),
        FIELD_ACTUAL: data.get("actual"),
        FIELD_STEPS: data.get("steps"),
        FIELD_TEST_DATA: data.get("test_data"),
        FIELD_QA_ANALYSIS: data.get("qa_analysis"),
        FIELD_DEFECT_TYPE: (config.get("defect_type"), config.get("filed_against")),
        FIELD_ENVIRONMENT: config.get("defect_environment"),
        FIELD_PHASE: config.get("defect_phase"),
        FIELD_USABILITY: config.get("usability_issue"),
        "labels": config.get("labels"),
        FIELD_REOCCURRENCE: config.get("re_occurrence"),
        FIELD_NEWSTACK: config.get("newstack_impact"),
        FIELD_CATEGORY: config.get("defect_category"),
        FIELD_MILESTONE: config.get("milestone_type"),
        FIELD_UAT_PRIORITY: config.get("uat_priority"),
    }

    fields = {
        "project": {"key": project_key},
        "issuetype": {"id": type_id},
        "summary": summary,
    }
    if description:
        fields["description"] = description

    skipped = []
    for field_id, value in wanted.items():
        if value in (None, "", []) or (isinstance(value, tuple) and not value[0]):
            continue
        if field_id.startswith("field_"):
            field_id = config.get(field_id)
            if not field_id:
                continue
        if field_id not in meta:
            skipped.append(field_id)
            continue
        formatted = _format_value(meta[field_id], value)
        if formatted in (None, [], {}):
            skipped.append(f"{field_id} ('{value}' not an allowed value)")
            continue
        fields[field_id] = formatted

    assignee_query = assignee or data.get("assignee") or config.get("assignee")
    if assignee_query and "assignee" in meta:
        username = _find_user(assignee_query)
        if username:
            fields["assignee"] = {"name": username}
        else:
            skipped.append(f"assignee ('{assignee_query}' not found)")

    # Create; if Jira rejects specific fields, drop them and retry once.
    try:
        created = _request("POST", "/rest/api/2/issue", json={"fields": fields})
    except JiraRestError as e:
        bad = {}
        if getattr(e, "status_code", None) == 400:
            try:
                bad = e.response.json().get("errors", {})
            except ValueError:
                pass
        droppable = [f for f in bad if f in fields and f not in ("project", "issuetype", "summary")]
        if not droppable or len(droppable) != len(bad):
            raise
        for f in droppable:
            fields.pop(f)
            skipped.append(f"{f} (rejected: {bad[f]})")
        created = _request("POST", "/rest/api/2/issue", json={"fields": fields})

    issue_key = created["key"]
    print(f"[SUCCESS] Defect {issue_key} created (REST)")
    if skipped:
        print(f"  [!] Fields not set, please check in Jira: {', '.join(skipped)}")

    tc_link = data.get("tc_number") or data.get("tc_key")
    if tc_link:
        try:
            _link_issues(issue_key, tc_link)
        except JiraRestError as e:
            print(f"  [!] Could not link {issue_key} to {tc_link}: {e}")

    try:
        attach_files(issue_key, screenshot_paths)
    except JiraRestError as e:
        print(f"  [!] Could not attach screenshots to {issue_key}: {e}")

    return issue_key
