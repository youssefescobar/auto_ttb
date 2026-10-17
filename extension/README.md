# Auto TTB browser extension

A Chrome/Edge side panel (it replaced the old local Python server). It runs inside your normal browser and uses the Jira tab you are already logged into, so there is no Python, no local server, no saved cookie file and no extra Chromium.

## What it does

- Load a Test Execution by key or pasted Jira link. Its test cases come from Xray, or from the issue's links and sub-tasks.
- Per test case, collect **Expected** and **Actual** screenshots by:
  - pasting (Ctrl+V, e.g. from the Snipping Tool),
  - uploading,
  - pressing **Alt+Shift+S**.
- **Pass / Fail / Blocked / Executing** set the test run status in the Xray execution (PASS, FAIL, BLOCKED, EXECUTING; Reset sets TODO). Optionally Pass and Fail also add a Jira comment with the Actual screenshots.
- Add a note and a linked defect key per test case.
- **Download PoT** builds the Proof of Testing Word file in the browser, with the same layout as before.
- Everything is stored in this browser profile (IndexedDB). Settings → Export backup saves it to a file.
- PoT files are not stored anywhere: **Download PoT** at the top of an open test execution builds the file from what's saved and puts it in your browser's Downloads folder as `PoT_<TE>.docx`.

### Defects

- **Fail** opens a defect editor on the test case (or click **Report defect**). Write a short note and click **Draft with AI**: Gemini writes the title, scenario, steps, expected and actual from your note and the test case's screenshots (screenshots only if "Send screenshots to Gemini" is on). Edit anything before filing.
- **Create in Jira** creates the defect with your project's fields (Settings → Defects), links it to the test case, attaches the screenshots, marks the Xray run FAIL and adds the defect to it.
- **Add to queue** keeps the draft; **Create all in Jira** at the top files every queued draft in one go.
- **Check duplicates** lists open defects in the project with similar words; **Use this** links an existing one instead of filing a new one.
- Settings → Defects shows dropdowns filled from your project's Defect create screen. The extension finds Jira's custom fields by name, so there are no field IDs to set.

### Actions: record and replay (step 3)

- Open **Actions** at the top of the panel, type a name (e.g. "Log in as AP user") and click **● Record**. Click and type through the page in the current tab. Typing is recorded keystroke by keystroke as you type: characters, Backspace, Enter, Tab, arrows, Escape, paste and shortcuts like Ctrl+A, in fields or anywhere else (for example a BrowserStack device). Dropdowns and autofilled fields are recorded as the value chosen. Click **📷 Checkpoint** wherever you want a screenshot, then **Stop**.
- Actions aren't tied to a test execution. **▶ Run** opens the action's start page in the current tab (or, with "Run on the page that's open", starts where you are), repeats the clicks, types character by character and presses the keys. Checkpoint screenshots go into the open test case's Actual. If an element can't be found, the run stops and says at which step.
- **Delays:** click an action's name to see its steps and type a number of seconds next to any step to wait that long before it. Blank steps use the default pause from Settings → Record and replay, where you also set the typing speed. The same list lets you remove steps, rename the action or delete it.
- **Real input** (on by default) runs with real mouse and keyboard events through Chrome's debugger, which BrowserStack and many web apps need. Chrome shows a "started debugging this browser" bar while an action runs. Turn it off in Settings to use page events instead.
- The first Record or Run asks Chrome for access to the sites you test. Passwords are stored in this browser profile but shown as dots.
- On BrowserStack Live the device is a video stream, so runs click at the recorded positions on it; that breaks if the device layout shifts between runs.

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `extension` folder.
3. Pin Auto TTB, then click its icon to open the side panel.
4. Click ⚙ and enter your Jira base URL, then Save. Chrome asks for access to that one site; allow it.
5. If the status says "Log in to Jira", click it, log in as usual, and come back.

If your laptop blocks Developer mode, IT can allow the extension with the `ExtensionInstallAllowlist` policy, or it can be published as an unlisted Chrome Web Store / Edge Add-ons item. Until you use Actions, the extension can only reach your Jira site; recording and running actions asks for access to the sites you test.

### Screen capture

**Alt+Shift+S** captures the visible tab into the open test case; change the shortcut at `chrome://extensions/shortcuts`. Pasting always works.

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
