# --- Gemini AI Configuration -----------------------------------------
import os
from dotenv import load_dotenv

# Load environment variables from .env file if present
load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# --- Jira connection -------------------------------------------------
JIRA_BASE_URL = os.getenv("JIRA_BASE_URL", "https://jira.prod.mobily.lan/")   # no trailing slash
JIRA_USERNAME = os.getenv("JIRA_USERNAME", "80129258")                   # domain login
HEADLESS_BROWSER = False                           # Set False to watch Playwright execute

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
DEFECT_TITLE_PREFIX = "LightMode_SIT_Android_"
DEFECT_TITLE_PATTERN = os.getenv("DEFECT_TITLE_PATTERN", "LightMode_SIT_Android_{AI_TITLE}")

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

# --- Local file paths ---------------------------------------------------
BROWSER_STATE_PATH = "jira_session.json"

# --- Runtime Overrides --------------------------------------------------
_runtime_overrides = {}

# Map web UI keys to module variables or dicts
_KEY_MAPPING = {
    "gemini_api_key": "GEMINI_API_KEY",
    "gemini_model": "GEMINI_MODEL",
    "jira_base_url": "JIRA_BASE_URL",
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
}

def get(key, default=None):
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
    return val

def set_override(key, value):
    _runtime_overrides[key] = value

def set_overrides(overrides_dict):
    _runtime_overrides.update(overrides_dict)

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
