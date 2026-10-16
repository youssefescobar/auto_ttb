# QA / JIRA Automation — Setup & User Guide

Automated workflow CLI tool for QA manual testing. Captures screenshots from the Windows clipboard, generates defect documentation with **Google Gemini AI**, logs/transitions test cases in Jira, and maintains individual Proof of Completion (PoC) Word documents per Test Execution (TE).

---

## Folder Structure Overview

```text
auto_ttb/
├── config.py                 # Settings list (edited on the web Config page)
├── app.py                    # Web app (run this)
├── main.py                   # Main CLI test execution driver
├── defect_draft.py           # Gemini AI title & defect description generator
├── jira_actions.py           # Playwright Jira UI actions & session management
├── poc_doc.py                # Word document generation per TE
├── screenshot.py             # Clipboard image grabber
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

The app sends you to the Config page until the Jira base URL is set. Everything lives there: Jira URL, token and mode, Gemini key and model, project and defect field values, title pattern, workflow transitions, batch timing and the Jira custom field IDs. Secrets (Jira token, Gemini key) go to the OS credential store; everything else is saved to `settings_overrides.json`. Values in an existing `.env` are still read as a fallback.

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

## Daily Execution Workflow

Execute a Test Case using main.py:

```bash
# Explicitly specifying TE key and TC key:
python main.py --te TE-101 TC-123

# Or simply specify TC key (prompts for TE key or uses default TE):
python main.py TC-123
```

### Execution Flow:

1. **Start Execution:** Automatically transitions Jira TC to *Start Progress*.
2. **Choose Result:**
   - **Pass (`p`):** Snip proof screenshots (`Ctrl+C` -> press `Enter` in CLI). Automatically appends the images and TC section into `executions/<TE_KEY>/poc_report_<TE_KEY>.docx` and marks TC *Pass*.
   - **Fail (`f`):** Enter brief notes and grab defect screenshots.
3. **AI Defect Generation & Review:**
   - Gemini generates a concise bug summary title matching your pattern (e.g. `[TE-101][TC-123] Submit button fails on click`).
   - Gemini drafts Scenario, Expected, and Actual sections.
   - **Interactive Review:** Displays both Title and Body, allowing you to accept as-is, edit the title, edit the description body, or cancel before filing to Jira.
