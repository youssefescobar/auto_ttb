"""
All app settings live here and are edited on the web app's Config page (/config).

Values are read at call time with `config.get(key)`, in this order:
  1. the OS credential store (secrets only)
  2. settings saved from the Config page (settings_overrides.json)
  3. an entry in .env with the upper-case key name (optional, from older versions)
  4. the default below

No company, project or Jira-instance values are built in: those defaults are empty.
Only generic behaviour (timeouts, Jira's standard transition names, ...) has a default.
"""
import os
import json
from dotenv import dotenv_values, load_dotenv

import secret_store

load_dotenv()  # secrets fallback (JIRA_PAT, GEMINI_API_KEY) and proxy vars
_ENV_FILE = {k.lower(): v for k, v in dotenv_values(".env").items() if v}

# Local file paths (not user settings)
EXECUTIONS_DIR = "executions"
BROWSER_STATE_PATH = "jira_session.json"
OVERRIDES_PATH = "settings_overrides.json"

# (key, label, default, type, help). Types: text, secret, bool, number, select:<a|b|c>
SECTIONS = [
    ("Jira connection", [
        ("jira_base_url", "Jira base URL", "", "text", "e.g. https://jira.example.com"),
        ("jira_username", "Jira username", "", "text", ""),
        ("jira_pat", "Jira Personal Access Token", "", "secret",
         "Jira → Profile → Personal Access Tokens. Kept in the OS credential store, never in a file. "
         "With a token, Jira actions use the REST API instead of a browser."),
        ("jira_mode", "Connection mode", "auto", "select:auto|browser",
         "auto = REST API when a token is set; browser = always drive the Jira page"),
        ("jira_ca_bundle", "Corporate CA bundle path", "", "text",
         "Only if Jira uses an internal certificate authority"),
        ("network_speed", "Browser speed / timeout", "Normal", "select:Fast|Normal|Slow|Very Slow", ""),
        ("headless_browser", "Hide the browser window", False, "bool", ""),
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
        ("project", "Project name (as shown in Jira)", "", "text", "Typed into the Create Issue project picker"),
        ("issue_key", "For Project issue key", "", "text", "Issue key for the 'For Project' field"),
        ("for_project", "For Project search text", "", "text", "Typed into the 'For Project' picker in the browser"),
        ("demo", "Demo", "", "text", ""),
        ("default_te_key", "Default Test Execution key", "", "text", ""),
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
        ("transition_executing", "Transition: executing", "Start Progress", "text", ""),
        ("transition_pass", "Transition: pass", "Pass", "text", ""),
        ("transition_fail", "Transition: fail", "Fail", "text", ""),
        ("auto_submit_defect", "Auto-submit defects", False, "bool",
         "Off = open the pre-filled Jira form so you review it and click Create"),
        ("auto_save_pot", "Auto-save Proof of Testing on Pass / Fail", False, "bool", ""),
        ("draft_delay_min_seconds", "Batch submit: min delay (s)", 120, "number", ""),
        ("draft_delay_max_seconds", "Batch submit: max delay (s)", 300, "number", ""),
    ]),
    ("Jira custom field IDs", [
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
_ALIASES = {"issue_type": "defect_issue_type", "environment": "defect_environment", "demo_name": "demo"}

_runtime_overrides = {}


def get(key, default=None):
    key = _ALIASES.get(key, key)
    if key in secret_store.SECRETS:
        return secret_store.get_secret(key) or default
    if _runtime_overrides.get(key, "") != "":  # an emptied field falls back to the default
        val = _runtime_overrides[key]
    elif key in _ENV_FILE:
        val = _ENV_FILE[key]
    else:
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
