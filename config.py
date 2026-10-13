# --- Gemini AI Configuration -----------------------------------------
import os
import json
from dotenv import load_dotenv

import secret_store

# Load environment variables from .env file if present
load_dotenv()

GEMINI_API_KEY = secret_store.get_secret("gemini_api_key")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# --- Jira connection -------------------------------------------------
JIRA_BASE_URL = os.getenv("JIRA_BASE_URL", "https://jira.prod.mobily.lan").rstrip('/')   # no trailing slash
JIRA_USERNAME = os.getenv("JIRA_USERNAME", "")                   # domain login
HEADLESS_BROWSER = False                           # Set False to watch Playwright execute

# "auto": use the REST API when a Personal Access Token (JIRA_PAT) is set, else the browser.
# "browser": always drive the Jira UI with Playwright.
JIRA_MODE = os.getenv("JIRA_MODE", "auto")
JIRA_PROJECT = os.getenv("JIRA_PROJECT", "")   # Jira project key, e.g. BDR (derived from DEFECT_BOILERPLATE if empty)

# --- Project / CR Scope Settings ------------------------------------
PROJECT_KEY = os.getenv("PROJECT_KEY", "JK26-3835")          
PROJECT_NAME = "B2B Digital Revamp (BDR)"
TECHNICAL_PROJECT = "B2B Digital Revamp - Font Family and Light Mode CR Scope"
ISSUE_KEY = "JK26-3835"
DEMO_NAME = "Demo 1"
DEFECT_ISSUE_TYPE = os.getenv("DEFECT_ISSUE_TYPE", "Defect")     

# --- Test Execution (TE) & Folder Structure Settings -----------------
DEFAULT_TE_KEY = os.getenv("DEFAULT_TE_KEY", "TE-001")
EXECUTIONS_DIR = "executions"

# Defect title pattern format
DEFECT_TITLE_PREFIX = os.getenv("DEFECT_TITLE_PREFIX", "LightMode_SIT_Android_")
DEFECT_TITLE_PATTERN = os.getenv("DEFECT_TITLE_PATTERN", "{AI_TITLE}")

# Fields matching actual Jira form defaults
DEFECT_BOILERPLATE = {
    "project": "B2B Digital Revamp (BDR)",
    "issue_type": "Defect",
    "for_project": "JK26-3835 Technical project:\"B2B Digital Revamp - Font Family and Light Mode CR Scope\"",
    "demo": "Demo 1",
    "components": ["Android"],
    "impacted_system": "Mobile App",
    "defect_type": "B2B Digital Revamp",
    "filed_against": "BDR-ANDROID",
    "defect_environment": "Integration",
    "defect_phase": "QA",
    "usability_issue": "No",
    "labels": ["Lightmode"],
    "re_occurrence": "No",
    "newstack_impact": "Legacy",
    "defect_category": "Defect",
    "milestone_type": "Batch 1",
    "uat_priority": "None",
    "priority": "1-Low",
}

# Custom field labels
TC_NUMBER_FIELD_LABEL = None

# --- Test case status transitions -------------------------------------
TRANSITION_EXECUTING = "Start Progress"
TRANSITION_PASS = "Pass"
TRANSITION_FAIL = "Fail"

AUTO_SAVE_POT = False
AUTO_SUBMIT_DEFECT = False
SHARE_SCREENSHOTS_WITH_AI = True

# --- Draft Queue Settings ---
DRAFT_DELAY_MIN_SECONDS = 120    # Min delay between batch submissions (seconds)
DRAFT_DELAY_MAX_SECONDS = 300    # Max delay between batch submissions (seconds)

# --- Local file paths ---------------------------------------------------
BROWSER_STATE_PATH = "jira_session.json"

# --- Runtime Overrides --------------------------------------------------
_runtime_overrides = {}

# Map web UI keys to module variables or dicts
_KEY_MAPPING = {
    "gemini_api_key": "GEMINI_API_KEY",
    "gemini_model": "GEMINI_MODEL",
    "jira_base_url": "JIRA_BASE_URL",
    "jira_mode": "JIRA_MODE",
    "jira_project": "JIRA_PROJECT",
    "project_key": "PROJECT_KEY",
    "defect_title_prefix": "DEFECT_TITLE_PREFIX",
    "defect_title_pattern": "DEFECT_TITLE_PATTERN",
    "demo_name": "DEMO_NAME",
    "technical_project": "TECHNICAL_PROJECT",
    "issue_key": "ISSUE_KEY",
    "defect_issue_type": "DEFECT_ISSUE_TYPE",
    "environment": ("DEFECT_BOILERPLATE", "defect_environment"),
    "labels": ("DEFECT_BOILERPLATE", "labels"),
    "components": ("DEFECT_BOILERPLATE", "components"),
    "impacted_system": ("DEFECT_BOILERPLATE", "impacted_system"),
    "defect_type": ("DEFECT_BOILERPLATE", "defect_type"),
    "filed_against": ("DEFECT_BOILERPLATE", "filed_against"),
    "defect_phase": ("DEFECT_BOILERPLATE", "defect_phase"),
    "milestone_type": ("DEFECT_BOILERPLATE", "milestone_type"),
    "transition_executing": "TRANSITION_EXECUTING",
    "transition_pass": "TRANSITION_PASS",
    "transition_fail": "TRANSITION_FAIL",
    "auto_save_pot": "AUTO_SAVE_POT",
    "auto_submit_defect": "AUTO_SUBMIT_DEFECT",
    "share_screenshots_with_ai": "SHARE_SCREENSHOTS_WITH_AI",
    "draft_delay_min_seconds": "DRAFT_DELAY_MIN_SECONDS",
    "draft_delay_max_seconds": "DRAFT_DELAY_MAX_SECONDS",
    "network_speed": "NETWORK_SPEED",
}

NETWORK_SPEED = "Normal" # Options: Fast, Normal, Slow, Very Slow

def get(key, default=None):
    if key in secret_store.SECRETS:
        return secret_store.get_secret(key) or _runtime_overrides.get(key) or default
    if key in _runtime_overrides:
        val = _runtime_overrides[key]
    elif key in _KEY_MAPPING:
        mapping = _KEY_MAPPING[key]
        if isinstance(mapping, tuple):
            dict_name, dict_key = mapping
            val = globals().get(dict_name, {}).get(dict_key, default)
        else:
            val = globals().get(mapping, default)
    else:
        val = default

    if isinstance(val, str):
        if val.lower() == 'true':
            return True
        elif val.lower() == 'false':
            return False
        # Always strip trailing slash from URL fields
        if key == 'jira_base_url':
            return val.rstrip('/')
    return val

def set_override(key, value):
    _runtime_overrides[key] = value
    persist_overrides()

def set_overrides(overrides_dict):
    _runtime_overrides.update(overrides_dict)
    persist_overrides()

def get_all_settings():
    settings = {}
    for key in _KEY_MAPPING:
        settings[key] = get(key)
    # Include all boilerplate defaults too
    for bp_key, bp_val in DEFECT_BOILERPLATE.items():
        if bp_key not in settings:
            settings[bp_key] = _runtime_overrides.get(bp_key, bp_val)
    return settings

def clear_overrides():
    _runtime_overrides.clear()
    persist_overrides()

def load_persisted_overrides():
    try:
        if os.path.exists("settings_overrides.json"):
            with open("settings_overrides.json", "r", encoding="utf-8") as f:
                _runtime_overrides.update(json.load(f))
            # Move any secrets saved by older versions into the OS credential store
            moved = [k for k in secret_store.SECRETS
                     if _runtime_overrides.get(k) and secret_store.set_secret(k, _runtime_overrides[k])]
            for k in moved:
                _runtime_overrides.pop(k)
            if moved:
                persist_overrides()
    except Exception as e:
        print(f"[!] Error loading settings overrides: {e}")

def persist_overrides():
    try:
        with open("settings_overrides.json", "w", encoding="utf-8") as f:
            json.dump(_runtime_overrides, f, indent=2)
    except Exception as e:
        print(f"[!] Error saving settings overrides: {e}")

load_persisted_overrides()
