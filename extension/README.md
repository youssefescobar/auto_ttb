# Auto TTB browser extension

A Chrome/Edge side panel (it replaced the old local Python server). It runs inside your normal browser and uses the Jira tab you are already logged into, so there is no Python, no local server, no saved cookie file and no extra Chromium.

## What it does

- Load a Test Execution by key or pasted Jira link. Its test cases come from Xray, or from the issue's links and sub-tasks.
- Per test case, collect **Expected** and **Actual** screenshots by:
  - pasting (Ctrl+V, e.g. from the Snipping Tool),
  - uploading,
  - clicking **Capture tab**,
  - pressing **Alt+Shift+S**.
- **Pass / Fail / Blocked / Executing** set the test run status in the Xray execution (PASS, FAIL, BLOCKED, EXECUTING; Reset sets TODO). Optionally Pass and Fail also add a Jira comment with the Actual screenshots.
- Add a note and a linked defect key per test case.
- **Download PoT** builds the Proof of Testing Word file in the browser, with the same layout as before.
- Everything is stored in this browser profile (IndexedDB). Settings → Export backup saves it to a file.

### Defects

- **Fail** opens a defect editor on the test case (or click **Report defect**). Write a short note and click **Draft with AI**: Gemini writes the title, scenario, steps, expected and actual from your note and the test case's screenshots (screenshots only if "Send screenshots to Gemini" is on). Edit anything before filing.
- **Create in Jira** creates the defect with your project's fields (Settings → Defects), links it to the test case, attaches the screenshots, marks the Xray run FAIL and adds the defect to it.
- **Add to queue** keeps the draft; **Create all in Jira** at the top files every queued draft in one go.
- **Check duplicates** lists open defects in the project with similar words; **Use this** links an existing one instead of filing a new one.
- Settings → **Detect field IDs from Jira** fills the custom field IDs from your Defect create screen.

Still to come: the click recorder (step 3).

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `extension` folder.
3. Pin Auto TTB, then click its icon to open the side panel.
4. Click ⚙ and enter your Jira base URL, then Save. Chrome asks for access to that one site; allow it.
5. If the status says "Log in to Jira", click it, log in as usual, and come back.

If your laptop blocks Developer mode, IT can allow the extension with the `ExtensionInstallAllowlist` policy, or it can be published as an unlisted Chrome Web Store / Edge Add-ons item. The extension asks only for your Jira site. Screen capture uses Chrome's `activeTab`, so it gets no blanket access to other sites.

### Screen capture

**Capture tab** works on a tab once you have clicked the Auto TTB toolbar icon while that tab was showing. **Alt+Shift+S** works on any tab; change the shortcut at `chrome://extensions/shortcuts`. Pasting always works.

## How it talks to Jira

It calls Jira Server/Data Center's REST API (`/rest/api/2/...`) with your browser session cookies. Jira rejects cookie-authenticated writes from a foreign `Origin`, so a `declarativeNetRequest` rule sets `Origin` to your Jira URL on the extension's own requests only.

## Development

```bash
cd extension
npm install
npm test          # unit tests
npm run vendor    # rebuild lib/vendor/docx.mjs after changing the docx version
```

`lib/vendor/docx.mjs` is the bundled [docx](https://github.com/dolanmiu/docx) library, so the extension loads without a build step.
