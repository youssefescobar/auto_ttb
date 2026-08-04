# QA / JIRA Automation — Setup & User Guide

Automated workflow CLI tool for QA manual testing. Captures screenshots from the Windows clipboard, generates defect documentation with **Google Gemini AI**, logs/transitions test cases in Jira, and maintains individual Proof of Completion (PoC) Word documents per Test Execution (TE).

---

## Folder Structure Overview

```text
auto_ttb/
├── config.py                 # Core configurations & defaults
├── setup.py                  # Interactive Onboarding Setup Wizard
├── main.py                   # Main CLI test execution driver
├── defect_draft.py           # Gemini AI title & defect description generator
├── jira_actions.py           # Playwright Jira UI actions & session management
├── poc_doc.py                # Word document generation per TE
├── screenshot.py             # Clipboard image grabber
├── .env                      # Saved environment variables (created by setup.py)
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

## Quick Setup & Onboarding Wizard

Run the interactive setup wizard to configure your Jira URL, Gemini API Key, default TE key, and defect title patterns:

```bash
python setup.py
```


The wizard will guide you through:
1. **Jira Settings:** Base URL, Username, Project Key, Issue Type.
2. **Gemini AI Settings:** Gemini API Key and Model (`gemini-2.5-flash`).
3. **Test Execution & Defect Customization:** Default TE key and Defect Title pattern (e.g. `[{TE_KEY}][{TC_KEY}] {AI_TITLE}`).
4. **Jira Browser Login:** Launches browser once for manual SSO/2FA login to save `jira_session.json`.

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
