"""
All app settings live here and are edited on the web app's Config page (/config).

Values are read at call time with `config.get(key)`: secrets from the OS credential
store, everything else from settings saved on the Config page (settings_overrides.json),
falling back to the default below when a setting is unset or empty.

No company, project or Jira-instance values are built in: those defaults are empty.
Only generic behaviour (timeouts, Jira's standard transition names, ...) has a default.
"""
import os
import json
from dotenv import load_dotenv

import secret_store

load_dotenv()  # secret_store falls back to JIRA_PAT / GEMINI_API_KEY env vars

# Local file paths (not user settings)
EXECUTIONS_DIR = "executions"
BROWSER_STATE_PATH = "jira_session.json"
OVERRIDES_PATH = "settings_overrides.json"

# (key, label, default, type, help). Types: text, secret, bool, number, select:<a|b|c>
SECTIONS = [
    ("Jira connection", [
        ("jira_base_url", "Jira base URL", "", "text", "e.g. https://jira.example.com"),
        ("jira_pat", "Jira Personal Access Token", "", "secret",
         "Jira → Profile → Personal Access Tokens. Kept in the OS credential store, never in a file. "
         "Optional: without one, the app uses your saved Jira login (Login button) for the REST API."),
        ("jira_mode", "Connection mode", "auto", "select:auto|browser",
         "auto = REST API using your token, or your saved Jira login if no token; browser = always drive the Jira page"),
        ("jira_ca_bundle", "Corporate CA bundle path", "", "text",
         "Only if Jira uses an internal certificate authority"),
    ]),
    ("AI (Gemini)", [
        ("gemini_api_key", "Gemini API key", "", "secret", "Kept in the OS credential store"),
        ("gemini_model", "Gemini model", "gemini-2.5-flash", "text", ""),
        ("share_screenshots_with_ai", "Share screenshots with AI", True, "bool",
         "When off, only text notes go to Gemini"),
        ("https_proxy", "HTTPS proxy", "", "text", "Optional, for reaching Gemini"),
    ]),
    ("Project", [
        ("jira_project", "Jira project key", "", "text", "Key defects are created in, e.g. ABC"),
        ("for_project", "For Project issue key", "", "text", "Issue key for the 'For Project' field, e.g. ABC-123"),
        ("demo", "Demo", "", "text", ""),
        ("environments", "TE environments (comma separated)", "SIT, UAT, PP, Prod", "text",
         "Options in the environment picker"),
        ("languages", "TE languages (comma separated)", "English, Arabic", "text", ""),
    ]),
    ("Defect fields", [
        ("defect_issue_type", "Issue type", "Defect", "text", ""),
        ("components", "Component/s", "", "text", ""),
        ("impacted_system", "Impacted system", "", "text", ""),
        ("defect_type", "Defect type", "", "text", ""),
        ("filed_against", "Filed against", "", "text", ""),
        ("defect_environment", "Defect environment", "", "text", "Also tells the AI which environment you test"),
        ("defect_phase", "Defect phase", "", "text", ""),
        ("priority", "Default severity", "", "text", ""),
        ("assignee", "Default assignee", "", "text", ""),
        ("labels", "Labels", "", "text", ""),
        ("usability_issue", "Usability issue", "", "text", ""),
        ("re_occurrence", "Re-occurrence", "", "text", ""),
        ("newstack_impact", "NewStack impact", "", "text", ""),
        ("defect_category", "Defect category", "", "text", ""),
        ("milestone_type", "Milestone type", "", "text", ""),
        ("uat_priority", "UAT priority", "", "text", ""),
    ]),
    ("Defect title", [
        ("defect_title_prefix", "Title prefix", "", "text", ""),
        ("defect_title_pattern", "Title pattern", "{AI_TITLE}", "text",
         "Placeholders: {PREFIX} {TE_KEY} {TC_KEY} {AI_TITLE}"),
    ]),
    ("Workflow", [
        ("transition_pass", "Transition: pass", "Pass", "text", ""),
        ("auto_submit_defect", "Auto-submit defects", False, "bool",
         "Off = open the pre-filled Jira form so you review it and click Create"),
        ("auto_save_pot", "Auto-save Proof of Testing on Pass / Fail", False, "bool", ""),
    ]),
    # Sections titled "Advanced: ..." start collapsed on the Config page.
    ("Advanced: browser mode", [
        ("project", "Project name (as shown in Jira)", "", "text",
         "Only for filling the Create Issue form in the browser; typed into its project picker"),
        ("network_speed", "Browser speed / timeout", "Normal", "select:Fast|Normal|Slow|Very Slow", ""),
        ("headless_browser", "Hide the browser window", False, "bool", ""),
    ]),
    ("Advanced: Jira custom field IDs", [
        # Instance-specific: leave empty to skip a field. Find IDs in Jira's field admin or the Create form HTML.
        ("field_for_project", "For Project", "", "text", "e.g. customfield_12345"),
        ("field_demo", "Demo", "", "text", ""),
        ("field_severity", "Defect severity", "", "text", ""),
        ("field_tcs_blocked", "Test cases blocked", "", "text", ""),
        ("field_impacted_system", "Impacted system", "", "text", ""),
        ("field_scenario", "Scenario", "", "text", ""),
        ("field_expected", "Expected result", "", "text", ""),
        ("field_actual", "Actual result", "", "text", ""),
        ("field_steps", "Steps to recreate", "", "text", ""),
        ("field_qa_analysis", "QA analysis", "", "text", ""),
        ("field_test_data", "Test data", "", "text", ""),
        ("field_defect_type", "Defect type → Filed against (cascading)", "", "text", ""),
        ("field_environment", "Defect environment", "", "text", ""),
        ("field_phase", "Defect phase", "", "text", ""),
        ("field_usability", "Usability issue", "", "text", ""),
        ("field_reoccurrence", "Re-occurrence", "", "text", ""),
        ("field_newstack", "NewStack impact", "", "text", ""),
        ("field_category", "Defect category", "", "text", ""),
        ("field_milestone", "Milestone type", "", "text", ""),
        ("field_uat_priority", "UAT priority", "", "text", ""),
    ]),
]

DEFAULTS = {key: default for _, fields in SECTIONS for key, _, default, *_ in fields}
TYPES = {key: kind for _, fields in SECTIONS for key, _, _, kind, _ in fields}
REQUIRED = ["jira_base_url"]

# Keys saved by older versions -> current key
_ALIASES = {"issue_type": "defect_issue_type", "environment": "defect_environment", "demo_name": "demo",
            "issue_key": "for_project"}

_runtime_overrides = {}


def get(key, default=None):
    key = _ALIASES.get(key, key)
    if key in secret_store.SECRETS:
        return secret_store.get_secret(key) or default
    val = _runtime_overrides.get(key, "")
    if val == "":  # unset or emptied on the Config page
        val = DEFAULTS.get(key, default)

    kind = TYPES.get(key)
    if kind == "bool" and isinstance(val, str):
        return val.strip().lower() in ("1", "true", "yes", "on")
    if kind == "number" and isinstance(val, str):
        try:
            return float(val) if "." in val else int(val)
        except ValueError:
            return DEFAULTS[key]
    if key == "jira_base_url" and isinstance(val, str):
        return val.strip().rstrip("/")
    return val


def missing_required():
    return [k for k in REQUIRED if not get(k)]


def set_overrides(overrides_dict):
    for key, value in overrides_dict.items():
        _runtime_overrides[_ALIASES.get(key, key)] = value
    persist_overrides()


def get_all_settings():
    """Every non-secret setting; secrets are reported only as set / not set."""
    settings = {k: get(k) for k in DEFAULTS if k not in secret_store.SECRETS}
    for k in secret_store.SECRETS:
        settings[f"{k}_set"] = bool(secret_store.get_secret(k))
    return settings


def schema():
    return [{"title": title, "fields": [
        {"key": k, "label": label, "type": kind, "help": help_text, "default": default}
        for k, label, default, kind, help_text in fields]} for title, fields in SECTIONS]


def load_persisted_overrides():
    try:
        if os.path.exists(OVERRIDES_PATH):
            with open(OVERRIDES_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            for key, value in saved.items():
                _runtime_overrides[_ALIASES.get(key, key)] = value
            # Move any secrets saved by older versions into the OS credential store
            moved = [k for k in secret_store.SECRETS
                     if _runtime_overrides.get(k) and secret_store.set_secret(k, _runtime_overrides[k])]
            for k in moved:
                _runtime_overrides.pop(k)
            if moved or saved.keys() != _runtime_overrides.keys():
                persist_overrides()
    except Exception as e:
        print(f"[!] Error loading settings overrides: {e}")


def persist_overrides():
    try:
        with open(OVERRIDES_PATH, "w", encoding="utf-8") as f:
            json.dump(_runtime_overrides, f, indent=2)
    except Exception as e:
        print(f"[!] Error saving settings overrides: {e}")


load_persisted_overrides()
