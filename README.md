# Auto TTB

A Chrome/Edge side panel for QA on Jira Data Center with Xray. It uses the Jira tab you're already logged into, so there's no server to run.

- Load a Test Execution and its test cases, and set each Xray run to Pass, Fail, Blocked or Executing.
- Collect Expected/Actual screenshots and download the Proof of Testing Word document.
- Draft defects with Gemini, check for duplicates, and create them in Jira with the screenshots attached and the defect linked to the test case and run.

Install and usage: [`extension/README.md`](extension/README.md).

## Moving from the old Python app

The Flask app (`app.py`) was retired once the extension covered everything it did. It is still in git history before this change.

- **Settings:** in the extension, open Settings → **Import old app settings** and pick your old `settings_overrides.json`, then Save.
- **Local files:** the old `executions/` folders, `jira_session.json` and `settings_overrides.json` are no longer used. Delete them when you no longer need them (the last two hold your Jira login and keys).
