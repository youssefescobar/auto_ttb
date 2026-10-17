# Auto TTB

A Chrome/Edge side panel for QA on Jira Data Center with Xray. It uses the Jira tab you're already logged into, so there's no server to run.

- Load a Test Execution and its test cases, and set each Xray run to Pass, Fail, Blocked or Executing.
- Collect Expected/Actual screenshots and download the Proof of Testing Word document.
- Draft defects with Gemini, check for duplicates, and create them in Jira with the screenshots attached and the defect linked to the test case and run.
- Record a test's clicks and typing once, then replay it with the screenshots taken automatically.

Install and usage: [`extension/README.md`](extension/README.md).

## Old Python app

The Flask app was retired once the extension covered everything it did; its code is in git history. `db.json` is its last test-execution data, kept here as a backup.
