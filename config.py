# --- Gemini AI Configuration -----------------------------------------
import os
from dotenv import load_dotenv

# Load environment variables from .env file if present
load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# --- Jira connection -------------------------------------------------
JIRA_BASE_URL = os.getenv("JIRA_BASE_URL", "https://jira.yourcompany.com")   # no trailing slash
JIRA_USERNAME = os.getenv("JIRA_USERNAME", "your.username")                   # domain login
# Password/SSO is handled via a persisted browser session (see jira_actions.py
# login_and_save_session()) — we do NOT store your password in this repo.
HEADLESS_BROWSER = True                           # Set False to watch Playwright execute

# --- Project / issue defaults -----------------------------------------
PROJECT_KEY = os.getenv("PROJECT_KEY", "PROJ")          
DEFECT_ISSUE_TYPE = os.getenv("DEFECT_ISSUE_TYPE", "Bug")     

# --- Test Execution (TE) & Folder Structure Settings -----------------
DEFAULT_TE_KEY = os.getenv("DEFAULT_TE_KEY", "TE-001")
EXECUTIONS_DIR = "executions"

# Defect title pattern format. Available placeholders: {TE_KEY}, {TC_KEY}, {AI_TITLE}
# Example result: "[TE-101][TC-123] Login button fails on submit"
DEFECT_TITLE_PATTERN = os.getenv("DEFECT_TITLE_PATTERN", "[{TE_KEY}][{TC_KEY}] {AI_TITLE}")

# Fields that are the SAME on every defect you file. Add/remove keys to match
# your actual create-issue form. Leave a value as None to skip setting it.
DEFECT_BOILERPLATE = {
    "components": ["QA"],              # e.g. your team's component
    "labels": ["auto-filed"],
    "priority": "Medium",
    "affects_version": None,           # e.g. "v2.4.1" if you track this
    "environment": "Production",       # or "Staging", etc.
}

# If your Jira has a custom field for "linked test case number", put its
# visible field label here (used to find it with Playwright get_by_label).
# Set to None if you just put the TC number in the summary/description instead.
TC_NUMBER_FIELD_LABEL = None   # e.g. "Test Case ID"

# --- Test case status transitions -------------------------------------
# Exact transition button/link text as it appears in Jira's workflow menu
TRANSITION_EXECUTING = "Start Progress"
TRANSITION_PASS = "Pass"
TRANSITION_FAIL = "Fail"

# --- Local file paths ---------------------------------------------------
BROWSER_STATE_PATH = "jira_session.json"   # saved login session (see below)


