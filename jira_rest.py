"""
Jira Server / Data Center REST API client.

Uses a Personal Access Token (Profile -> Personal Access Tokens in Jira DC 8.14+)
sent as a Bearer token. No browser, no saved cookies. Enabled automatically when
a token is configured (see secret_store.py); jira_actions.py falls back to the
Playwright browser flow otherwise.
"""
import os
import re
import time

import requests

import config
import secret_store

# Field IDs used by the Defect create screen (same IDs the browser flow fills).
FIELD_FOR_PROJECT = "customfield_24115"
FIELD_DEMO = "customfield_28800"
FIELD_SEVERITY = "customfield_10704"
FIELD_TCS_BLOCKED = "customfield_11406"
FIELD_IMPACTED_SYSTEM = "customfield_11414"
FIELD_SCENARIO = "customfield_11518"
FIELD_EXPECTED = "customfield_11519"
FIELD_ACTUAL = "customfield_11520"
FIELD_STEPS = "customfield_11521"
FIELD_QA_ANALYSIS = "customfield_11522"
FIELD_TEST_DATA = "customfield_11523"
FIELD_DEFECT_TYPE = "customfield_11529"  # cascading: Defect Type -> Filed Against
FIELD_ENVIRONMENT = "customfield_10707"
FIELD_PHASE = "customfield_11404"
FIELD_USABILITY = "customfield_14106"
FIELD_REOCCURRENCE = "customfield_15100"
FIELD_NEWSTACK = "customfield_28306"
FIELD_CATEGORY = "customfield_28900"
FIELD_MILESTONE = "customfield_18143"
FIELD_UAT_PRIORITY = "customfield_31100"


class JiraRestError(Exception):
    pass


def is_enabled() -> bool:
    """REST mode is used when a token exists and the user hasn't forced browser mode."""
    if str(config.get("jira_mode", "auto")).lower() == "browser":
        return False
    return bool(secret_store.get_secret("jira_pat"))


def _base_url() -> str:
    return config.get("jira_base_url") or config.JIRA_BASE_URL


def _session() -> requests.Session:
    token = secret_store.get_secret("jira_pat")
    if not token:
        raise JiraRestError("No Jira Personal Access Token configured (JIRA_PAT).")
    s = requests.Session()
    s.headers.update({
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    # Corporate CA bundle, if the Jira host uses an internal certificate authority
    ca_bundle = os.getenv("JIRA_CA_BUNDLE")
    if ca_bundle:
        s.verify = ca_bundle
    return s


def _request(method: str, path: str, **kwargs):
    url = f"{_base_url()}{path}"
    kwargs.setdefault("timeout", 30)
    resp = _session().request(method, url, **kwargs)
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
    result = {"name": me.get("name"), "display_name": me.get("displayName")}
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
        "url": f"{_base_url()}/browse/{te_key}",
    }


# --- Defect creation -------------------------------------------------------

def _project_key() -> str:
    explicit = config.get("jira_project")
    if explicit:
        return explicit
    m = re.search(r"\(([A-Z][A-Z0-9_]+)\)", config.DEFECT_BOILERPLATE.get("project", ""))
    if m:
        return m.group(1)
    raise JiraRestError("Set 'jira_project' (the Jira project key, e.g. BDR) in settings.")


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
    issue_type = config.get("defect_issue_type") or config.DEFECT_ISSUE_TYPE
    type_id, meta = _create_meta(project_key, issue_type)

    wanted = {
        FIELD_FOR_PROJECT: config.get("issue_key") or config.ISSUE_KEY,
        FIELD_DEMO: config.get("demo", "Demo 1"),
        "components": config.get("components", "Android"),
        FIELD_SEVERITY: priority or data.get("severity") or config.get("priority", "1-Low"),
        FIELD_TCS_BLOCKED: str(data.get("blocked_tcs", "1")),
        FIELD_IMPACTED_SYSTEM: config.get("impacted_system", "Mobile App"),
        FIELD_SCENARIO: data.get("scenario"),
        FIELD_EXPECTED: data.get("expected"),
        FIELD_ACTUAL: data.get("actual"),
        FIELD_STEPS: data.get("steps"),
        FIELD_TEST_DATA: data.get("test_data"),
        FIELD_QA_ANALYSIS: data.get("qa_analysis"),
        FIELD_DEFECT_TYPE: (config.get("defect_type", "B2B Digital Revamp"), config.get("filed_against", "BDR-ANDROID")),
        FIELD_ENVIRONMENT: config.get("defect_environment", "Integration"),
        FIELD_PHASE: config.get("defect_phase", "QA"),
        FIELD_USABILITY: config.get("usability_issue", "No"),
        "labels": config.get("labels", "Lightmode"),
        FIELD_REOCCURRENCE: config.get("re_occurrence", "No"),
        FIELD_NEWSTACK: config.get("newstack_impact", "Legacy"),
        FIELD_CATEGORY: config.get("defect_category", "Defect"),
        FIELD_MILESTONE: config.get("milestone_type", "Batch 1"),
        FIELD_UAT_PRIORITY: config.get("uat_priority", "No"),
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
        if value in (None, "", []):
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
