# QA / JIRA Automation — Setup & User Guide

Local web app for QA manual testing. Collects test evidence screenshots, generates defect documentation with **Google Gemini AI**, logs/transitions test cases in Jira, and maintains individual Proof of Completion (PoC) Word documents per Test Execution (TE).

---

## Folder Structure Overview

```text
auto_ttb/
├── config.py                 # Settings list (edited on the web Config page)
├── app.py                    # Web app (run this)
├── defect_draft.py           # Gemini AI title & defect description generator
├── jira_actions.py           # Jira actions: REST first, Playwright page automation as fallback
├── jira_rest.py              # Jira REST API client (token or saved Jira login)
├── poc_doc.py                # Word document generation per TE
├── settings_overrides.json   # Settings saved from the Config page
└── executions/               # Organized test output directory
    └── TE-101/               # Test Execution Folder
        ├── poc_report_TE-101.docx
        ├── TC-101/           # TC-specific screenshots
        │   ├── shot_1722800000.png
        │   └── shot_1722800005.png
        └── TC-102/
            └── shot_1722800010.png
```

---

## Prerequisites & Virtual Environment Setup

Before running the project, create and activate a Python virtual environment (`venv`) to keep your dependencies isolated:

### 1. Create Virtual Environment

```bash
python -m venv venv
```

### 2. Activate Virtual Environment

- **Windows (PowerShell / Command Prompt):**
  ```powershell
  .\venv\Scripts\activate
  ```
- **macOS / Linux:**
  ```bash
  source venv/bin/activate
  ```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
playwright install chromium
```

---

## Configuration

There is no setup script and nothing company-specific is built in. Start the web app and open **Config** (the gear icon, or http://127.0.0.1:5000/config):

```bash
python app.py
```

The app sends you to the Config page until the Jira base URL is set. Everything lives there: Jira URL, token and mode, Gemini key and model, project and defect field values, title pattern, the pass transition, and (under the collapsed *Advanced* sections) browser-mode options and the Jira custom field IDs. Secrets (Jira token, Gemini key) go to the OS credential store; everything else is saved to `settings_overrides.json`. Values in an existing `.env` are still read as a fallback.

---

## Jira Connection

Jira actions use the Jira REST API, signed in one of two ways:

- **Your Jira login (no token needed).** Click **Login to Jira** in the top bar, log in as usual in the window that opens, then **Save Jira Session**. The app sends that saved login (`jira_session.json`) to the REST API. When it expires, the top bar shows *Jira login expired*: log in again. Treat `jira_session.json` like a password.
- **Personal Access Token (optional).** If your Jira offers *Profile → Personal Access Tokens*, enter one on the Config page. It is stored in the OS credential store (Windows Credential Manager / macOS Keychain), never in a project file, and is used instead of the saved login.

Either way:

- TC transitions and Test Execution lookups go through REST, with no browser window.
- Defects and comments are created over REST when **Auto-submit defect** is on. When it is off, the browser opens the pre-filled Jira form so you can review it before clicking Create.
- Set the **Jira project key** on the Config page. If Jira uses an internal certificate authority, set **Corporate CA bundle path**.
- For the **Jira custom field IDs**, click **🔍 Detect from Jira** on the Config page: it reads your Defect create screen, fills the empty boxes by field name, and lists any it couldn't match. Fields left empty are skipped.

Set Connection mode to *browser* to always drive the Jira page with Playwright instead.

The web app's Flask debugger is off by default; set `FLASK_DEBUG=1` only while developing.

---

## Daily Workflow

Everything happens in the web app (`python app.py`, then http://127.0.0.1:5000):

1. **Load a Test Execution:** enter its key and fetch its test cases from Jira.
2. **Collect evidence:** add *Expected* and *Actual* screenshots to a test case (upload or paste).
3. **Pass:** marks the TC *Pass* in Jira and, if enabled, appends it to the TE's Proof of Testing document (`executions/<TE_KEY>/poc_report_<TE_KEY>.docx`).
4. **Fail:** write short notes; Gemini drafts the defect title, scenario, steps, expected and actual results. Review and edit, then file it now or save it to the draft queue and **Raise All** later.
5. **Proof of Testing:** rebuild or download the Word document for the TE at any time.
