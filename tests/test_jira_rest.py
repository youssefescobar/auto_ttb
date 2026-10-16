"""Tests for jira_rest.py against an in-memory fake Jira (no network)."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
import jira_rest  # noqa: E402


class FakeResponse:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body
        self.content = b"" if body is None else json.dumps(body).encode()
        self.text = self.content.decode()

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


SELECT = {"type": "option", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:select"}


def cf(setting_key):
    """Fake Jira custom field ID for a field_* setting."""
    return f"customfield_{setting_key}"


def opt(i, v):
    return {"id": str(i), "value": v}


class FakeJira:
    def __init__(self):
        self.calls = []
        self.created = None
        self.reject_fields = {}
        self.meta = [
            {"fieldId": "summary", "schema": {"type": "string"}},
            {"fieldId": "customfield_sprint", "name": "Sprint", "schema": {"type": "array"}},
            {"fieldId": "description", "schema": {"type": "string"}},
            {"fieldId": "components", "schema": {"type": "array", "items": "component"},
             "allowedValues": [{"id": "10", "name": "Android"}, {"id": "11", "name": "iOS"}]},
            {"fieldId": "labels", "schema": {"type": "array", "items": "string"}},
            {"fieldId": "assignee", "schema": {"type": "user"}},
            {"fieldId": cf(jira_rest.FIELD_SEVERITY), "name": "Defect Severity", "schema": SELECT, "allowedValues": [opt(1, "1-Low"), opt(2, "2-Medium")]},
            {"fieldId": cf(jira_rest.FIELD_SCENARIO), "name": "Scenario", "schema": {"type": "string"}},
            {"fieldId": cf(jira_rest.FIELD_TCS_BLOCKED), "name": "Test Cases Blocked", "schema": {"type": "number"}},
            {"fieldId": cf(jira_rest.FIELD_ENVIRONMENT), "name": "Defect Environment", "schema": SELECT, "allowedValues": [opt(5, "Integration")]},
            {"fieldId": cf(jira_rest.FIELD_DEFECT_TYPE), "name": "Defect type",
             "schema": {"type": "option-with-child", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect"},
             "allowedValues": [{"id": "41119", "value": "B2B Digital Revamp",
                                "children": [{"id": "41813", "value": "BDR-ANDROID"}]}]},
            {"fieldId": cf(jira_rest.FIELD_DEMO), "name": "Demo", "schema": SELECT, "allowedValues": [opt(7, "Demo 1")]},
        ]

    def request(self, method, url, **kw):
        path = url.split("://", 1)[-1].split("/", 1)[-1]
        path = "/" + path
        self.calls.append((method, path, kw))
        if path == "/rest/api/2/myself":
            return FakeResponse(200, {"name": "qa1", "displayName": "QA One"})
        if path.endswith("/transitions") and method == "GET":
            return FakeResponse(200, {"transitions": [{"id": "11", "name": "Start Progress"}, {"id": "21", "name": "Pass"}]})
        if path.endswith("/transitions") and method == "POST":
            return FakeResponse(204)
        if path == "/rest/api/2/issue/createmeta/BDR/issuetypes":
            return FakeResponse(200, {"values": [{"id": "1", "name": "Bug"}, {"id": "42", "name": "Defect"}]})
        if path == "/rest/api/2/issue/createmeta/BDR/issuetypes/42":
            return FakeResponse(200, {"values": self.meta, "isLast": True})
        if path == "/rest/api/2/user/search":
            return FakeResponse(200, [{"name": "sshukla", "displayName": "Saurabh"}])
        if path == "/rest/api/2/issue" and method == "POST":
            fields = kw["json"]["fields"]
            bad = {f: "not on screen" for f in self.reject_fields if f in fields}
            if bad:
                self.reject_fields = {}
                return FakeResponse(400, {"errorMessages": [], "errors": bad})
            self.created = fields
            return FakeResponse(201, {"id": "9", "key": "BDR-77"})
        if path == "/rest/api/2/issueLinkType":
            return FakeResponse(200, {"issueLinkTypes": [{"name": "Relates", "inward": "relates to", "outward": "relates to"}]})
        if path in ("/rest/api/2/issueLink",) or path.endswith("/attachments") or path.endswith("/comment"):
            return FakeResponse(201, {})
        if path == "/rest/api/2/issue/TE-5":
            return FakeResponse(200, {"fields": {"summary": "Exec 5", "issuelinks": [], "subtasks": []}})
        if path == "/rest/raven/1.0/api/testexec/TE-5/test":
            return FakeResponse(200, [{"key": "TC-2"}, {"key": "TC-1"}])
        if path == "/rest/api/2/search":
            return FakeResponse(200, {"issues": [{"key": "TC-1", "fields": {"summary": "Login"}},
                                                 {"key": "TC-2", "fields": {"summary": "Logout"}}]})
        return FakeResponse(404, {"errorMessages": [f"no route {method} {path}"]})


@pytest.fixture
def jira(monkeypatch):
    fake = FakeJira()

    class Sess:
        headers = {}
        verify = True

        def request(self, method, url, **kw):
            return fake.request(method, url, **kw)

    monkeypatch.setattr(jira_rest, "_session", lambda: Sess())
    monkeypatch.delenv("JIRA_PAT", raising=False)
    field_ids = {k: cf(k) for k in config.DEFAULTS if k.startswith("field_")}
    monkeypatch.setattr(config, "_runtime_overrides", {
        "jira_base_url": "https://jira.test", "jira_pat": "tok", "jira_project": "BDR", "defect_issue_type": "Defect",
        "components": "Android", "defect_type": "B2B Digital Revamp", "filed_against": "BDR-ANDROID",
        "defect_environment": "Integration", "labels": "Lightmode", "priority": "1-Low", "demo": "Demo 1",
        "usability_issue": "No", **field_ids,
    })
    return fake


def test_enabled_only_with_token(jira, monkeypatch):
    assert jira_rest.is_enabled()
    monkeypatch.setitem(config._runtime_overrides, "jira_mode", "browser")
    assert not jira_rest.is_enabled()


def test_transition_by_name(jira):
    jira_rest.transition_issue("TC-1", "pass")
    method, path, kw = jira.calls[-1]
    assert (method, path, kw["json"]) == ("POST", "/rest/api/2/issue/TC-1/transitions", {"transition": {"id": "21"}})


def test_transition_missing_lists_available(jira):
    with pytest.raises(jira_rest.JiraRestError, match="Start Progress, Pass"):
        jira_rest.transition_issue("TC-1", "Fail")


def test_fetch_test_execution_via_xray(jira):
    te = jira_rest.fetch_test_execution("TE-5")
    assert te["summary"] == "Exec 5"
    assert te["test_cases"] == [{"key": "TC-1", "name": "TC-1 Login"}, {"key": "TC-2", "name": "TC-2 Logout"}]


def test_create_defect_builds_fields(jira, tmp_path):
    shot = tmp_path / "shot.png"
    shot.write_bytes(b"png")
    key = jira_rest.create_defect(
        "Button overlaps", "desc", [str(shot)], assignee="Saurabh",
        data={"scenario": "Login", "tc_key": "TC-1", "blocked_tcs": "2"},
    )
    assert key == "BDR-77"
    f = jira.created
    assert f["project"] == {"key": "BDR"} and f["issuetype"] == {"id": "42"}
    assert f["components"] == [{"id": "10"}]
    assert f["labels"] == ["Lightmode"]
    assert f[cf(jira_rest.FIELD_SEVERITY)] == {"id": "1"}
    assert f[cf(jira_rest.FIELD_TCS_BLOCKED)] == 2.0
    assert f[cf(jira_rest.FIELD_DEFECT_TYPE)] == {"id": "41119", "child": {"id": "41813"}}
    assert f["assignee"] == {"name": "sshukla"}
    assert cf(jira_rest.FIELD_USABILITY) not in f  # not on the create screen
    paths = [(m, p) for m, p, _ in jira.calls]
    assert ("POST", "/rest/api/2/issueLink") in paths
    assert ("POST", "/rest/api/2/issue/BDR-77/attachments") in paths


def test_create_defect_drops_rejected_fields(jira):
    jira.reject_fields = {cf(jira_rest.FIELD_DEMO): True}
    assert jira_rest.create_defect("t", "", [], data={}) == "BDR-77"
    assert cf(jira_rest.FIELD_DEMO) not in jira.created


def test_secret_saved_but_never_sent_back(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config, "_runtime_overrides", {})
    import app as app_module
    client = app_module.app.test_client()
    res = client.post("/api/settings", json={"jira_pat": "secret-token", "project": "X"})
    assert res.status_code == 200
    saved = json.loads((tmp_path / "settings_overrides.json").read_text())
    assert saved["jira_pat"] == "secret-token" and saved["project"] == "X"
    settings = client.get("/api/settings").json
    assert "jira_pat" not in settings and settings["jira_pat_set"] is True


def test_field_without_id_is_skipped(jira, monkeypatch):
    monkeypatch.setitem(config._runtime_overrides, jira_rest.FIELD_SEVERITY, "")
    jira_rest.create_defect("t", "", [], data={})
    assert cf(jira_rest.FIELD_SEVERITY) not in jira.created
    assert jira.created[cf(jira_rest.FIELD_DEMO)] == {"id": "7"}


def test_missing_base_url_is_reported(jira, monkeypatch):
    monkeypatch.setitem(config._runtime_overrides, "jira_base_url", "")
    with pytest.raises(jira_rest.JiraRestError, match="Config page"):
        jira_rest.transition_issue("TC-1", "Pass")


def test_detect_custom_fields_matches_by_name(jira):
    res = jira_rest.detect_custom_fields()
    assert res["found"][jira_rest.FIELD_SEVERITY] == cf(jira_rest.FIELD_SEVERITY)
    assert res["found"][jira_rest.FIELD_DEFECT_TYPE] == cf(jira_rest.FIELD_DEFECT_TYPE)  # case/spacing ignored
    assert res["found"][jira_rest.FIELD_ENVIRONMENT] == cf(jira_rest.FIELD_ENVIRONMENT)
    assert jira_rest.FIELD_QA_ANALYSIS in res["unmatched"]
    assert "customfield_sprint" not in res["found"].values()
    assert {"id": "customfield_sprint", "name": "Sprint"} in res["fields"]


# --- Signing in with the saved browser login instead of a token ---------------

@pytest.fixture
def saved_login(monkeypatch, tmp_path):
    state = tmp_path / "jira_session.json"
    state.write_text(json.dumps({"cookies": [
        {"name": "JSESSIONID", "value": "abc", "domain": "jira.test", "path": "/"},
        {"name": "seraph.rememberme.cookie", "value": "rm", "domain": ".jira.test", "path": "/"},
        {"name": "other", "value": "x", "domain": "example.com", "path": "/"},
    ]}))
    monkeypatch.setattr(config, "BROWSER_STATE_PATH", str(state))
    monkeypatch.delenv("JIRA_PAT", raising=False)
    monkeypatch.setattr(config, "_runtime_overrides", {"jira_base_url": "https://jira.test"})
    return state


def test_saved_login_used_when_no_token(saved_login):
    assert jira_rest.auth_mode() == "session"
    s = jira_rest._session()
    assert "Authorization" not in s.headers
    assert s.headers["X-Atlassian-Token"] == "no-check"
    assert s.cookies.get("JSESSIONID") == "abc"
    assert s.cookies.get("seraph.rememberme.cookie") == "rm"
    assert s.cookies.get("other") is None  # cookies for other sites are not sent


def test_token_preferred_over_saved_login(saved_login, monkeypatch):
    monkeypatch.setitem(config._runtime_overrides, "jira_pat", "tok")
    assert jira_rest.auth_mode() == "token"
    assert jira_rest._session().headers["Authorization"] == "Bearer tok"


def test_no_token_and_no_login_disables_rest(saved_login):
    saved_login.unlink()
    assert jira_rest.auth_mode() is None and not jira_rest.is_enabled()


def test_expired_login_says_to_log_in_again(saved_login, monkeypatch):
    class Sess:
        def request(self, method, url, **kw):
            return FakeResponse(401, {"errorMessages": ["unauthorized"]})

    monkeypatch.setattr(jira_rest, "_session", lambda: Sess())
    with pytest.raises(jira_rest.JiraRestError, match="login expired"):
        jira_rest.transition_issue("TC-1", "Pass")


def test_detect_fields_endpoint_reports_missing_login(saved_login, monkeypatch):
    saved_login.unlink()
    monkeypatch.setitem(config._runtime_overrides, "jira_project", "BDR")
    import app as app_module
    res = app_module.app.test_client().post("/api/detect-fields", json={})
    assert res.status_code == 400 and "saved Jira login" in res.json["error"]


def test_old_issue_key_setting_fills_for_project(jira, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "settings_overrides.json").write_text(json.dumps({"issue_key": "ABC-1"}))
    monkeypatch.setattr(config, "_runtime_overrides", dict(config._runtime_overrides))
    config.load_persisted_overrides()
    assert config.get("for_project") == "ABC-1"
    jira.meta.append({"fieldId": cf(jira_rest.FIELD_FOR_PROJECT), "name": "For Project", "schema": {"type": "string"}})
    jira_rest.create_defect("t", "", [], data={})
    assert jira.created[cf(jira_rest.FIELD_FOR_PROJECT)] == "ABC-1"
