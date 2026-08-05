"""
Playwright driving Jira Server/DC UI.
Logs in, saves session state to jira_session.json, and reuses it for headless actions.
"""
import os
import sys
import threading
import time
from playwright.sync_api import sync_playwright

import config

_login_lock = threading.Lock()
_save_requested_event = threading.Event()

_login_state = {
    "status": "idle",  # "idle", "opening", "open", "saving", "saved", "error"
    "message": ""
}

def start_login_session():
    """Opens a real browser window to Jira for manual login."""
    with _login_lock:
        if _login_state["status"] in ("opening", "open"):
            return {"status": _login_state["status"], "message": "Login browser is already open."}

        _save_requested_event.clear()
        _login_state["status"] = "opening"
        _login_state["message"] = f"Opening browser to {config.JIRA_BASE_URL}..."

    def _worker():
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=False)
                context = browser.new_context()
                page = context.new_page()
                page.goto(config.JIRA_BASE_URL)

                with _login_lock:
                    _login_state["status"] = "open"
                    _login_state["message"] = "Browser open! Log into Jira, then click 'Save Jira Session' in web app."
                print(f"[+] Login browser launched to {config.JIRA_BASE_URL}")

                # Wait on this thread for save request or timeout (5 minutes)
                save_triggered = _save_requested_event.wait(timeout=300)

                if save_triggered:
                    with _login_lock:
                        _login_state["status"] = "saving"
                    context.storage_state(path=config.BROWSER_STATE_PATH)
                    browser.close()
                    with _login_lock:
                        _login_state["status"] = "saved"
                        _login_state["message"] = "Session saved successfully!"
                    print(f"[+] Session saved successfully to '{config.BROWSER_STATE_PATH}'.")
                else:
                    browser.close()
                    with _login_lock:
                        _login_state["status"] = "idle"
                        _login_state["message"] = "Login timed out after 5 minutes."
                    print("[!] Login browser closed due to timeout.")

        except Exception as e:
            with _login_lock:
                _login_state["status"] = "error"
                _login_state["message"] = f"Browser session error: {e}"
            print(f"[!] Login browser session error: {e}")

    threading.Thread(target=_worker, daemon=True).start()
    return {"status": "opening", "message": "Launching browser window..."}

def save_login_session():
    """Signals the login worker thread to save storage_state to BROWSER_STATE_PATH."""
    with _login_lock:
        status = _login_state["status"]

    if status not in ("opening", "open"):
        if os.path.exists(config.BROWSER_STATE_PATH):
            return {"status": "success", "message": "Jira session file exists."}
        return {"status": "error", "message": "No open login browser found. Click 'Login' first."}

    # Signal the worker thread to save state and close browser
    _save_requested_event.set()

    # Wait up to 10 seconds for the worker thread to finish saving
    for _ in range(100):
        time.sleep(0.1)
        with _login_lock:
            if _login_state["status"] in ("saved", "idle", "error"):
                if _login_state["status"] == "saved":
                    return {"status": "success", "message": f"Session saved to '{config.BROWSER_STATE_PATH}'"}
                elif _login_state["status"] == "error":
                    return {"status": "error", "message": _login_state["message"]}
                break

    if os.path.exists(config.BROWSER_STATE_PATH):
        return {"status": "success", "message": f"Session saved to '{config.BROWSER_STATE_PATH}'"}

    return {"status": "error", "message": "Save timed out waiting for worker thread."}

def get_login_status():
    with _login_lock:
        session_file = config.BROWSER_STATE_PATH
        has_file = os.path.exists(session_file)
        return {
            "status": _login_state["status"],
            "message": _login_state["message"],
            "exists": has_file,
            "mtime": os.path.getmtime(session_file) if has_file else None
        }

def login_and_save_session():
    """CLI wrapper: launches browser, waits for Enter in terminal, saves session."""
    print(f"Opening browser to {config.JIRA_BASE_URL}...")
    start_login_session()
    time.sleep(3)
    input("\n--> Log in manually in the opened browser window, then press Enter here to save session...")
    save_login_session()


def _get_context(p):
    headless_setting = getattr(config, "HEADLESS_BROWSER", False)
    browser = p.chromium.launch(headless=headless_setting)
    
    if not os.path.exists(config.BROWSER_STATE_PATH):
        browser.close()
        raise FileNotFoundError(
            f"Jira session file '{config.BROWSER_STATE_PATH}' not found.\n"
            f"Please run 'python jira_actions.py' to perform initial login first."
        )

    context = browser.new_context(storage_state=config.BROWSER_STATE_PATH)
    return browser, context


def transition_tc(tc_key: str, transition_name: str):
    """Opens a TC issue and clicks the given workflow transition."""
    with sync_playwright() as p:
        browser, context = _get_context(p)
        page = context.new_page()
        page.goto(f"{config.JIRA_BASE_URL}/browse/{tc_key}")

        more_button = page.locator("#opsbar-transitions_more")
        if more_button.is_visible():
            more_button.click()
        
        try:
            page.get_by_text(transition_name, exact=True).click()
        except Exception:
            print(f"  [!] Transition '{transition_name}' button not found directly, trying workflow menu...")

        submit = page.locator("#issue-workflow-transition-submit")
        if submit.is_visible():
            submit.click()

        print(f"  -> {tc_key} transitioned to '{transition_name}'")
        browser.close()


def fill_jira_field(page, field_name: str, value: str):
    """
    Robustly fills a Jira form field by matching ID, name, label text, or customfield wrapper.
    Handles inputs, textareas, standard selects, and AUI autocompletes.
    """
    if not value or not str(value).strip():
        return

    val_str = str(value).strip()

    try:
        if field_name.startswith("#") or field_name.startswith("."):
            loc = page.locator(field_name)
            if loc.count() > 0 and loc.first.is_visible(timeout=1000):
                tag = loc.first.evaluate("el => el.tagName.toLowerCase()")
                if tag == "select":
                    try: loc.first.select_option(label=val_str)
                    except Exception: loc.first.select_option(value=val_str)
                else:
                    loc.first.fill(val_str)
                return
    except Exception:
        pass

    try:
        lbl_loc = page.get_by_label(field_name, exact=False)
        if lbl_loc.count() > 0 and lbl_loc.first.is_visible(timeout=1000):
            tag = lbl_loc.first.evaluate("el => el.tagName.toLowerCase()")
            if tag == "select":
                try: lbl_loc.first.select_option(label=val_str)
                except Exception: lbl_loc.first.select_option(value=val_str)
            else:
                lbl_loc.first.fill(val_str)
                page.keyboard.press("Enter")
            return
    except Exception:
        pass

    try:
        xpath = f"//label[contains(normalize-space(.), '{field_name}')]/following-sibling::*[self::input or self::textarea or self::select] | //label[contains(normalize-space(.), '{field_name}')]/..//input | //label[contains(normalize-space(.), '{field_name}')]/..//textarea | //label[contains(normalize-space(.), '{field_name}')]/..//select"
        loc = page.locator(xpath).first
        if loc.count() > 0 and loc.is_visible(timeout=1000):
            tag = loc.evaluate("el => el.tagName.toLowerCase()")
            if tag == "select":
                try: loc.select_option(label=val_str)
                except Exception: loc.select_option(value=val_str)
            else:
                loc.fill(val_str)
                page.keyboard.press("Enter")
            return
    except Exception:
        pass

    print(f"  [!] Note: Field '{field_name}' not automatically filled (will use defaults if present).")

def create_defect(
    summary: str,
    description: str,
    screenshot_paths: list[str],
    assignee: str = None,
    priority: str = None,
    data: dict = None
) -> str:
    """
    Files a new defect in Jira Server/DC.
    Step 1: Selects Project and Issue Type ('Defect') and clicks Next / Submit.
    Step 2: Fills out all form fields provided by user and attaches screenshots.
    """
    if data is None:
        data = {}

    with sync_playwright() as p:
        browser, context = _get_context(p)
        page = context.new_page()
        print(f"[*] Opening Jira Create Issue dialog: {config.JIRA_BASE_URL}/secure/CreateIssue.jspa")
        page.goto(f"{config.JIRA_BASE_URL}/secure/CreateIssue.jspa")
        page.wait_for_load_state("domcontentloaded")

        # --- STEP 1: Select Project and Issue Type ('Defect') ---
        try:
            print("  -> Executing Step 1: Project & Issue Type selection...")
            project_val = config.get("project_key", "JK26-3835")
            defect_type_val = config.get("defect_issue_type", "Defect")

            # Select Project
            for proj_sel in ["#project", "#project-field", "#project-val", "select[name='pid']"]:
                if page.locator(proj_sel).count() > 0 and page.locator(proj_sel).first.is_visible(timeout=1000):
                    try: page.select_option(proj_sel, label=config.PROJECT_NAME)
                    except Exception:
                        try: page.select_option(proj_sel, value=project_val)
                        except Exception:
                            page.fill(proj_sel, project_val)
                            page.keyboard.press("Enter")
                    break

            # Select Issue Type to Defect
            for issue_sel in ["#issuetype", "#issuetype-field", "#issuetype-val", "select[name='issuetype']"]:
                if page.locator(issue_sel).count() > 0 and page.locator(issue_sel).first.is_visible(timeout=1000):
                    try: page.select_option(issue_sel, label=defect_type_val)
                    except Exception:
                        try: page.select_option(issue_sel, value=defect_type_val)
                        except Exception:
                            page.fill(issue_sel, defect_type_val)
                            page.keyboard.press("Enter")
                    break

            # Click Next / Submit to proceed to Step 2 form
            for btn_sel in ["#issue-create-submit", "#qf-create-issue-submit", "input[name='next']", "input[type='submit']", "button[type='submit']"]:
                if page.locator(btn_sel).count() > 0 and page.locator(btn_sel).first.is_visible(timeout=1000):
                    page.click(btn_sel)
                    time.sleep(1)
                    break
        except Exception as e:
            print(f"  [!] Step 1 navigation note: {e}")

        # Wait for Step 2 Form to load
        try:
            page.wait_for_selector("#summary, input[name='summary']", timeout=10000)
        except Exception:
            pass

        print("  -> Executing Step 2: Filling out full Jira Defect Form fields...")

        # --- STEP 2: Fill out form fields ---
        # 1. Summary
        fill_jira_field(page, "Summary", summary)

        # 2. Description (if field exists)
        fill_jira_field(page, "Description", description)

        # 3. For Project
        fill_jira_field(page, "For Project", config.get("for_project", 'JK26-3835 Technical project :"B2B Digital Revamp..."'))

        # 4. Demo
        fill_jira_field(page, "Demo", config.get("demo", "Demo 1"))

        # 5. Component/s
        fill_jira_field(page, "Component", config.get("components", "Android"))

        # 6. Defect Severity
        fill_jira_field(page, "Defect Severity", priority or data.get("severity") or config.get("priority", "1-Low"))

        # 7. Test Cases Blocked
        fill_jira_field(page, "Test Cases Blocked", data.get("blocked_tcs", "1"))

        # 8. Impacted System
        fill_jira_field(page, "Impacted System", config.get("impacted_system", "Mobile App"))

        # 9. Scenario
        if data.get("scenario"):
            fill_jira_field(page, "Scenario", data.get("scenario"))

        # 10. Expected Result
        if data.get("expected"):
            fill_jira_field(page, "Expected Result", data.get("expected"))

        # 11. Actual Result
        if data.get("actual"):
            fill_jira_field(page, "Actual Result", data.get("actual"))

        # 12. Steps to Recreate
        if data.get("steps"):
            fill_jira_field(page, "Steps to Recreate", data.get("steps"))

        # 13. Test Data
        if data.get("test_data"):
            fill_jira_field(page, "Test Data", data.get("test_data"))

        # 14. QA Analysis
        if data.get("qa_analysis"):
            fill_jira_field(page, "QA Analysis", data.get("qa_analysis"))

        # 15. Defect Type & Filed Against
        fill_jira_field(page, "Defect Type", config.get("defect_type", "B2B Digital Revamp"))
        fill_jira_field(page, "Filed Against", config.get("filed_against", "BDR-ANDROID"))

        # 16. Assignee
        if assignee or data.get("assignee"):
            fill_jira_field(page, "Assignee", assignee or data.get("assignee"))

        # 17. Defect Environment
        fill_jira_field(page, "Defect Environment", config.get("defect_environment", "Integration"))

        # 18. Defect Phase
        fill_jira_field(page, "Defect Phase", config.get("defect_phase", "QA"))

        # 19. Usability Issue
        fill_jira_field(page, "Usability Issue", config.get("usability_issue", "No"))

        # 20. Labels
        fill_jira_field(page, "Labels", config.get("labels", "Lightmode"))

        # 21. Re-occurrence
        fill_jira_field(page, "Re-occurrence", config.get("re_occurrence", "No"))

        # 22. NewStack Impact
        fill_jira_field(page, "NewStack Impact", config.get("newstack_impact", "Legacy"))

        # 23. Defect Category
        fill_jira_field(page, "Defect Category", config.get("defect_category", "Defect"))

        # 24. Milestone Type
        fill_jira_field(page, "Milestone Type", config.get("milestone_type", "Batch 1"))

        # 25. UAT Priority
        fill_jira_field(page, "UAT Priority", config.get("uat_priority", "None"))

        # --- Attach Screenshots ---
        valid_shots = [p for p in screenshot_paths if os.path.exists(p)]
        if valid_shots:
            print(f"  -> Attaching {len(valid_shots)} screenshots...")
            for file_sel in ["input[type='file']", "#file-input", "input.issue-drop-zone__file-input"]:
                if page.locator(file_sel).count() > 0:
                    try:
                        page.set_input_files(file_sel, valid_shots)
                        time.sleep(2)
                        break
                    except Exception:
                        pass

        # --- SUBMIT ISSUE ---
        print("  -> Submitting Defect Issue to Jira...")
        submitted = False
        for submit_btn in ["#qf-create-issue-submit", "#issue-create-submit", "input[name='Create']", "button[name='Create']"]:
            if page.locator(submit_btn).count() > 0 and page.locator(submit_btn).first.is_visible(timeout=1000):
                page.click(submit_btn)
                submitted = True
                break

        if not submitted:
            try:
                page.locator("#summary").press("Control+Enter")
            except Exception:
                pass

        # Wait for created issue key (e.g. BDR-1234 or JK26-5678)
        issue_key = None
        try:
            page.wait_for_selector(".aui-message-success, #key-val, a.issue-created-key", timeout=15000)
            if page.locator("#key-val").count() > 0:
                issue_key = page.locator("#key-val").first.inner_text().strip()
            elif page.locator("a.issue-created-key").count() > 0:
                issue_key = page.locator("a.issue-created-key").first.inner_text().strip()
        except Exception:
            pass

        if not issue_key:
            current_url = page.url
            if "/browse/" in current_url:
                issue_key = current_url.split("/browse/")[1].split("?")[0]
            else:
                issue_key = f"{config.PROJECT_KEY}-NEW"

        print(f"[SUCCESS] Defect issue '{issue_key}' created in Jira!")
        browser.close()
        return issue_key


def add_comment_with_screenshots(issue_key: str, comment_text: str, screenshot_paths: list[str]):
    with sync_playwright() as p:
        browser, context = _get_context(p)
        page = context.new_page()
        page.goto(f"{config.JIRA_BASE_URL}/browse/{issue_key}")

        page.click("#footer-comment-button")
        page.fill("#comment", comment_text)
        for path in screenshot_paths:
            if os.path.exists(path):
                page.set_input_files("#comment-add input[type='file']", path)
        page.click("#issue-comment-add-submit")

def fetch_te_from_jira(te_key: str) -> dict:
    """
    Navigates to https://jira.prod.mobily.lan/browse/<te_key> using the saved Jira session.
    Scrapes the TE summary/title and any linked Test Case (TC) keys.
    """
    import re
    url = f"{config.JIRA_BASE_URL}/browse/{te_key}"
    print(f"[*] Navigating to Jira TE URL: {url}")

    with sync_playwright() as p:
        browser, context = _get_context(p)
        page = context.new_page()
        page.goto(url)
        page.wait_for_load_state("domcontentloaded")

        summary = ""
        for sum_sel in ["#summary-val", "h1#summary-val", "h1.item-summary", "h1"]:
            if page.locator(sum_sel).count() > 0 and page.locator(sum_sel).first.is_visible():
                summary = page.locator(sum_sel).first.inner_text().strip()
                break

        tc_keys = set()
        links = page.locator("a[href*='/browse/']").all()
        for link in links:
            try:
                href = link.get_attribute("href") or ""
                match = re.search(r'/browse/([A-Za-z0-9_\-\.]+)', href)
                if match:
                    key = match.group(1).upper()
                    if key != te_key.upper() and ("TC" in key or key.startswith("TC-") or key.startswith("QA-")):
                        tc_keys.add(key)
            except Exception:
                pass

        browser.close()
        return {
            "te_key": te_key,
            "summary": summary,
            "test_cases": sorted(list(tc_keys)),
            "url": url
        }


if __name__ == "__main__":
    login_and_save_session()
