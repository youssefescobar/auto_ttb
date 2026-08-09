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


def _fill_select(page, selector: str, val_str: str) -> bool:
    """Fill a standard <select> element by matching option text or value."""
    try:
        loc = page.locator(selector)
        if loc.count() == 0 or not loc.first.is_visible(timeout=1000):
            return False
        options = loc.first.locator("option").all()
        for opt in options:
            opt_text = opt.inner_text().strip()
            opt_val = opt.get_attribute("value") or ""
            if val_str.lower() in opt_text.lower() or val_str == opt_val:
                loc.first.select_option(value=opt_val)
                time.sleep(0.3)
                return True
        loc.first.select_option(label=val_str)
        time.sleep(0.3)
        return True
    except Exception:
        return False

def _fill_textarea(page, selector: str, val_str: str) -> bool:
    """Fill a plain <textarea> or <input type=text> instantly (paste-like).
    Uses Ctrl+A + Delete to clear, then insert_text() to paste the full value
    in one shot — fires input events so Jira's JS listeners still trigger.
    """
    try:
        loc = page.locator(selector)
        if loc.count() == 0 or not loc.first.is_visible(timeout=1000):
            return False
        loc.first.scroll_into_view_if_needed()
        loc.first.click()
        time.sleep(0.1)
        page.keyboard.press("Control+a")
        page.keyboard.press("Delete")
        page.keyboard.insert_text(val_str)  # instant paste — triggers input events
        time.sleep(0.1)
        return True
    except Exception as e:
        print(f"  [!] textarea fill note ({selector}): {e}")
        return False

def _fill_aui_autocomplete(page, selector: str, val_str: str, wait_ms: int = 1500) -> bool:
    """
    Fill an AUI autocomplete textarea/input: paste value instantly, wait for dropdown,
    click the matching item if found, or press Enter to add as a tag/confirm.
    Works for: Components, Labels, Assignee, Linked Issues, and similar AUI pickers.
    """
    try:
        loc = page.locator(selector)
        if loc.count() == 0 or not loc.first.is_visible(timeout=2000):
            print(f"  [!] AUI autocomplete: {selector} not found/visible")
            return False
        loc.first.scroll_into_view_if_needed()
        loc.first.click()
        time.sleep(0.3)
        # Clear any existing content, then paste the full value instantly
        page.keyboard.press("Control+a")
        page.keyboard.press("Delete")
        page.keyboard.insert_text(val_str)   # instant paste — triggers input events
        # Wait for dropdown results (network or local)
        time.sleep(wait_ms / 1000)

        # 1. Check the inline suggestions div derived from the input id
        #    e.g. #components-textarea -> #components-suggestions li
        #    e.g. #labels-textarea    -> #labels-suggestions li
        base_id = selector.lstrip("#").replace("-textarea", "").replace("-field", "")
        inline_loc = page.locator(f"#{base_id}-suggestions li")

        # 2. Broad overlay selector (.ajs-layer)
        overlay_items = page.locator(
            ".ajs-layer .aui-list-item:not(.no-suggestions),"
            ".ajs-layer-placeholder .aui-list-item:not(.no-suggestions),"
            ".suggestions li:not(.no-suggestions),"
            ".aui-list-truncate li:not(.no-suggestions),"
            "ul.suggestions li"
        )

        # Prefer inline suggestions; fall back to overlay
        if inline_loc.count() > 0:
            dropdown_items = inline_loc
        else:
            dropdown_items = overlay_items

        matched = None
        count = min(dropdown_items.count(), 20)
        for i in range(count):
            item = dropdown_items.nth(i)
            try:
                if not item.is_visible(timeout=300):
                    continue
                txt = item.inner_text().strip()
                if val_str.lower() in txt.lower():
                    matched = item
                    break
            except Exception:
                continue

        if matched:
            matched.click()
            time.sleep(0.3)
        elif count > 0:
            try:
                if dropdown_items.first.is_visible(timeout=300):
                    dropdown_items.first.click()
                    time.sleep(0.3)
                else:
                    page.keyboard.press("Enter")
                    time.sleep(0.3)
            except Exception:
                page.keyboard.press("Enter")
                time.sleep(0.3)
        else:
            # No dropdown — press Enter to confirm/add as tag
            page.keyboard.press("Enter")
            time.sleep(0.3)
        return True
    except Exception as e:
        print(f"  [!] AUI autocomplete note ({selector}): {e}")
        return False

def _fill_single_element(page, el, val_str: str) -> bool:
    """Generic helper to fill/select a Playwright locator element in Jira."""
    try:
        if not el or el.count() == 0 or not el.first.is_visible(timeout=500):
            return False
        target = el.first
        tag = target.evaluate("el => el.tagName.toLowerCase()")
        if tag == "select":
            options = target.locator("option").all()
            for opt in options:
                opt_text = opt.inner_text().strip()
                opt_val = opt.get_attribute("value") or ""
                if val_str.lower() in opt_text.lower() or val_str == opt_val:
                    target.select_option(value=opt_val)
                    time.sleep(0.2)
                    return True
            try:
                target.select_option(label=val_str)
                time.sleep(0.2)
                return True
            except Exception:
                pass
        else:
            try:
                target.scroll_into_view_if_needed()
            except Exception:
                pass
            target.click()
            target.fill(val_str)
            time.sleep(0.2)
            return True
    except Exception as e:
        print(f"  [!] Element fill note: {e}")
    return False

def _select_or_fill_jira_field(page, field_name: str, values_to_try: list) -> bool:
    """
    Attempts to select or fill a Jira field using select_option, AUI autocomplete, or label/xpath matching.
    Returns True if successfully selected/filled.
    """
    if isinstance(values_to_try, (str, int)):
        values_to_try = [str(values_to_try)]

    for val in values_to_try:
        if not val or not str(val).strip():
            continue
        val_str = str(val).strip()

        # 1. Try direct <select> elements matching ID or name
        selectors = [
            f"select[name='{field_name}']",
            f"select[name='{field_name.lower()}']",
            f"select#{field_name}",
            f"select#{field_name.lower()}",
            f"#{field_name} select",
            f"#{field_name.lower()} select"
        ]
        for sel in selectors:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible(timeout=500):
                if _fill_single_element(page, loc, val_str):
                    return True

        # 2. Try AUI Autocomplete Input fields (e.g. #project-field, #issuetype-field)
        input_selectors = [
            f"#{field_name}-field",
            f"#{field_name.lower()}-field",
            f"#{field_name}-single-select input",
            f"#{field_name.lower()}-single-select input",
            f"input#{field_name}-field",
            f"input#{field_name.lower()}-field",
            f"input[name='{field_name}']",
            f"input[name='{field_name.lower()}']",
            f"#{field_name}",
            f"#{field_name.lower()}"
        ]
        for sel in input_selectors:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible(timeout=500):
                if _fill_single_element(page, loc, val_str):
                    return True

    return False

def fill_jira_field(page, field_name: str, value: str):
    """
    Robustly fills a Jira form field by matching ID, name, label text, or customfield wrapper.
    """
    if not value or not str(value).strip():
        return

    val_str = str(value).strip()
    fn_lower = field_name.lower().replace(" ", "").replace("/", "").replace("_", "").replace("-", "")

    # Known Jira field ID & Name mappings matching Jira DOM HTML exactly
    field_selectors_map = {
        "summary": ["#summary", "input[name='summary']", "textarea[name='summary']"],
        "description": ["#description", "textarea[name='description']"],
        "forproject": ["[data-customfieldid='customfield_24115'] input", "#customfield_24115-field", "#customfield_24115", "select[name='customfield_24115']", "#react-select-2-input"],
        "linkedissues": ["#issuelinks-issues-textarea", "#issuelinks-issues-field", "#issuelinks-issues", "textarea[name='issuelinks-issues']"],
        "issue": ["#issuelinks-issues-textarea", "#issuelinks-issues-field", "#issuelinks-issues", "textarea[name='issuelinks-issues']"],
        "demo": ["#customfield_28800", "select[name='customfield_28800']", "#customfield_28800-field"],
        "sprint": ["#customfield_10103-field", "#customfield_10103", "select[name='customfield_10103']"],
        "component": ["#components-textarea", "#components-field", "select[name='components']", "#components"],
        "components": ["#components-textarea", "#components-field", "select[name='components']", "#components"],
        "defectseverity": ["#customfield_10704", "select[name='customfield_10704']", "#priority-field", "#priority"],
        "testcasesblocked": ["#customfield_11406", "input[name='customfield_11406']"],
        "impactedsystem": ["#customfield_11414", "select[name='customfield_11414']"],
        "scenario": ["#customfield_11518", "textarea[name='customfield_11518']"],
        "expectedresult": ["#customfield_11519", "textarea[name='customfield_11519']"],
        "actualresult": ["#customfield_11520", "textarea[name='customfield_11520']"],
        "stepstorecreate": ["#customfield_11521", "textarea[name='customfield_11521']"],
        "testdata": ["#customfield_11523", "textarea[name='customfield_11523']"],
        "qaanalysis": ["#customfield_11522", "textarea[name='customfield_11522']"],
        "defecttype": ["#customfield_11529", "select[name='customfield_11529']"],
        "filedagainst": ["select[name='customfield_11529:1']", "#customfield_11529\\:1"],
        "assignee": ["#assignee-field", "#assignee", "input[name='assignee']"],
        "defectenvironment": ["#customfield_10707", "select[name='customfield_10707']", "#environment"],
        "defectphase": ["#customfield_11404", "select[name='customfield_11404']"],
        "usabilityissue": ["#customfield_14106-2", "input[name='customfield_14106']"],
        "labels": ["#labels-textarea", "#labels-field", "textarea[name='labels']", "#labels"],
        "reoccurrence": ["#customfield_15100", "select[name='customfield_15100']"],
        "newstackimpact": ["#customfield_28306", "select[name='customfield_28306']"],
        "defectcategory": ["#customfield_28900", "select[name='customfield_28900']"],
        "milestonetype": ["#customfield_18143", "select[name='customfield_18143']"],
        "uatpriority": ["#customfield_31100", "select[name='customfield_31100']"]
    }

    # Try exact mappings
    if fn_lower in field_selectors_map:
        for sel in field_selectors_map[fn_lower]:
            loc = page.locator(sel)
            if _fill_single_element(page, loc, val_str):
                print(f"  [+] Filled field '{field_name}' via selector '{sel}'")
                return

    # Try field_name as selector if starts with # or .
    if field_name.startswith("#") or field_name.startswith("."):
        loc = page.locator(field_name)
        if _fill_single_element(page, loc, val_str):
            print(f"  [+] Filled field '{field_name}'")
            return

    # Try parent container search by Label text
    try:
        label_xpath = f"//*[self::div or self::tr or self::section][contains(@class, 'field') or contains(@class, 'form') or contains(@class, 'group') or self::tr][.//label[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '{field_name.lower()}')]]//*[self::input or self::textarea or self::select]"
        loc = page.locator(label_xpath)
        if loc.count() > 0 and _fill_single_element(page, loc, val_str):
            print(f"  [+] Filled field '{field_name}' via container label search")
            return
    except Exception:
        pass

    # Fallback to get_by_label
    try:
        lbl_loc = page.get_by_label(field_name, exact=False)
        if lbl_loc.count() > 0 and _fill_single_element(page, lbl_loc, val_str):
            print(f"  [+] Filled field '{field_name}' via get_by_label")
            return
    except Exception:
        pass

    print(f"  [!] Note: Field '{field_name}' not automatically filled.")

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
    Step 2: Fills out all form fields provided by user.
    """
    if data is None:
        data = {}

    with sync_playwright() as p:
        browser, context = _get_context(p)
        page = context.new_page()
        print(f"[*] Opening Jira Create Issue dialog: {config.JIRA_BASE_URL}/secure/CreateIssue.jspa")
        page.goto(f"{config.JIRA_BASE_URL}/secure/CreateIssue.jspa")
        page.wait_for_load_state("networkidle")  # wait for all JS/AUI to finish loading
        # Extra wait for AUI widgets to fully initialise after network idle
        page.wait_for_selector("#project-field", timeout=15000)
        time.sleep(1.5)

        # --- STEP 1: Select Project and Issue Type ('Defect') ---
        try:
            # Check if we are already on Step 2 (summary input visible)
            is_step_2 = (
                page.locator("#summary").count() > 0
                and page.locator("#summary").first.is_visible(timeout=1000)
            )

            if not is_step_2:
                print("  -> Executing Step 1: Project & Issue Type selection...")

                # 1. Project — type "B2B Digital Revamp (BDR)" then press Enter
                proj_input = page.locator("#project-field")
                proj_input.click()
                proj_input.click(click_count=3)
                proj_input.type("B2B Digital Revamp (BDR)", delay=40)
                time.sleep(0.5)
                page.keyboard.press("Enter")
                print("     Project: typed + Enter")
                time.sleep(0.8)  # wait for issue types to reload

                # 2. Issue Type — type "Defect" then press Enter
                it_input = page.locator("#issuetype-field")
                it_input.click()
                it_input.click(click_count=3)
                it_input.type("Defect", delay=40)
                time.sleep(0.5)
                page.keyboard.press("Enter")
                print("     Issue Type: typed + Enter")
                time.sleep(0.3)

                # 3. Click Next button
                next_clicked = False
                for btn_sel in [
                    "#issue-create-submit",
                    "input[name='Next']",
                    "input[value='Next']",
                    "input[name='next']",
                    "input[type='submit']",
                    "button[type='submit']",
                ]:
                    btn = page.locator(btn_sel)
                    if btn.count() > 0 and btn.first.is_visible(timeout=500):
                        btn.first.click()
                        next_clicked = True
                        print(f"     Clicked Next: {btn_sel}")
                        break
                if not next_clicked:
                    page.keyboard.press("Enter")

        except Exception as e:
            print(f"  [!] Step 1 navigation note: {e}")


        # Wait for Step 2 Form to load - longer delay for slow connections
        try:
            page.wait_for_selector("#summary, input[name='summary']", timeout=15000)
            time.sleep(1.5)  # Extra wait for JS/React fields to initialise
        except Exception:
            pass

        print("  -> Executing Step 2: Filling out full Jira Defect Form fields...")

        # --- STEP 2: Fill out form fields ---

        # 1. Summary (#summary) — plain input
        _fill_textarea(page, "#summary", summary)
        time.sleep(0.3)

        # 2. Description — plain textarea (skip if missing)
        if description:
            _fill_textarea(page, "#description", description)
            time.sleep(0.3)

        # 3. For Project (customfield_24115) — React-Select autocomplete
        # If already pre-filled (value shown) skip; otherwise type JK26-3835
        react_input = page.locator("#react-select-2-input")
        if react_input.count() > 0 and react_input.first.is_visible(timeout=1000):
            try:
                react_input.first.click()
                react_input.first.fill("JK26-3835")
                time.sleep(1.5)  # wait for React dropdown
                page.keyboard.press("ArrowDown")
                page.keyboard.press("Enter")
                time.sleep(0.5)
                print("  [+] For Project filled")
            except Exception as e:
                print(f"  [!] For Project note: {e}")

        # 4. Linked Issues — AUI issue-picker textarea
        # Select link type first (simple select)
        _fill_select(page, "#issuelinks-linktype", "relates to")
        time.sleep(0.2)
        # Type tc_number into the textarea and wait for autocomplete, then Enter
        tc_link = data.get("tc_number") or data.get("tc_key") or ""
        if tc_link:
            _fill_aui_autocomplete(page, "#issuelinks-issues-textarea", tc_link, wait_ms=1500)
            time.sleep(0.3)

        # 5. Demo (customfield_28800) — standard <select>
        _fill_select(page, "#customfield_28800", config.get("demo", "Demo 1"))
        time.sleep(0.2)

        # 6. Component/s — AUI multi-select textarea (type → dropdown → click)
        _fill_aui_autocomplete(page, "#components-textarea", config.get("components", "Android"), wait_ms=1500)
        time.sleep(0.4)

        # 7. Defect Severity (customfield_10704) — standard <select>
        sev_val = priority or data.get("severity") or config.get("priority", "1-Low")
        _fill_select(page, "#customfield_10704", sev_val)
        time.sleep(0.2)

        # 8. Test Cases Blocked (customfield_11406) — plain input
        _fill_textarea(page, "#customfield_11406", str(data.get("blocked_tcs", "1")))
        time.sleep(0.2)

        # 9. Impacted System (customfield_11414) — standard <select>
        _fill_select(page, "#customfield_11414", config.get("impacted_system", "Mobile App"))
        time.sleep(0.2)

        # 10. Scenario (customfield_11518) — plain textarea
        if data.get("scenario"):
            _fill_textarea(page, "#customfield_11518", data["scenario"])
            time.sleep(0.2)

        # 11. Expected Result (customfield_11519) — plain textarea
        if data.get("expected"):
            _fill_textarea(page, "#customfield_11519", data["expected"])
            time.sleep(0.2)

        # 12. Actual Result (customfield_11520) — plain textarea
        if data.get("actual"):
            _fill_textarea(page, "#customfield_11520", data["actual"])
            time.sleep(0.2)

        # 13. Steps to Recreate (customfield_11521) — plain textarea
        if data.get("steps"):
            _fill_textarea(page, "#customfield_11521", data["steps"])
            time.sleep(0.2)

        # 14. Test Data (customfield_11523) — plain textarea
        if data.get("test_data"):
            _fill_textarea(page, "#customfield_11523", data["test_data"])
            time.sleep(0.2)

        # 15. QA Analysis (customfield_11522) — plain textarea
        if data.get("qa_analysis"):
            _fill_textarea(page, "#customfield_11522", data["qa_analysis"])
            time.sleep(0.2)

        # 16. Defect Type & Filed Against — cascading <select>
        # Select parent first (B2B Digital Revamp = value 41119)
        _fill_select(page, "#customfield_11529", config.get("defect_type", "B2B Digital Revamp"))
        time.sleep(0.8)  # wait for child options to load after parent change
        # Now select child (BDR-ANDROID = value 41813)
        _fill_select(page, "select[name='customfield_11529:1']", config.get("filed_against", "BDR-ANDROID"))
        time.sleep(0.3)

        # 17. Assignee — AUI user-picker autocomplete
        assignee_name = assignee or data.get("assignee") or config.get("assignee", "Saurabh Shukla")
        _fill_aui_autocomplete(page, "#assignee-field", assignee_name, wait_ms=1800)
        time.sleep(0.4)

        # 18. Defect Environment (customfield_10707) — standard <select>
        _fill_select(page, "#customfield_10707", config.get("defect_environment", "Integration"))
        time.sleep(0.2)

        # 19. Defect Phase (customfield_11404) — standard <select>
        _fill_select(page, "#customfield_11404", config.get("defect_phase", "QA"))
        time.sleep(0.2)

        # 20. Usability Issue — radio button (No)
        # Try both known ID patterns
        usability_no = page.locator(
            "#customfield_14106-2, "
            "input[name='customfield_14106'][value='17440'], "
            "input[name='customfield_14106'][value='No']"
        )
        if usability_no.count() > 0:
            try:
                # Force check even if already checked
                usability_no.first.scroll_into_view_if_needed()
                usability_no.first.check(force=True)
                time.sleep(0.2)
                print("  [+] Usability Issue set to No")
            except Exception as ue:
                print(f"  [!] Usability Issue note: {ue}")

        # 21. Labels — AUI label-picker autocomplete textarea
        _fill_aui_autocomplete(page, "#labels-textarea", config.get("labels", "Lightmode"), wait_ms=1500)
        time.sleep(0.4)

        # 22. Re-occurrence (customfield_15100) — standard <select>
        _fill_select(page, "#customfield_15100", config.get("re_occurrence", "No"))
        time.sleep(0.2)

        # 23. NewStack Impact (customfield_28306) — standard <select>
        _fill_select(page, "#customfield_28306", config.get("newstack_impact", "Legacy"))
        time.sleep(0.2)

        # 24. Defect Category (customfield_28900) — standard <select>
        _fill_select(page, "#customfield_28900", config.get("defect_category", "Defect"))
        time.sleep(0.2)

        # 25. Milestone Type (customfield_18143) — standard <select>
        _fill_select(page, "#customfield_18143", config.get("milestone_type", "Batch 1"))
        time.sleep(0.2)

        # 26. UAT Priority (customfield_31100) — standard <select>
        _fill_select(page, "#customfield_31100", config.get("uat_priority", "No"))
        time.sleep(0.2)

        # Attach screenshots to defect form
        valid_shots = [p for p in (screenshot_paths or []) if os.path.exists(p)]
        if valid_shots:
            print(f"  -> Attaching {len(valid_shots)} screenshots to defect form...")
            for file_sel in ["input[type='file']", "input.issue-drop-zone__file-input"]:
                if page.locator(file_sel).count() > 0:
                    try:
                        page.set_input_files(file_sel, valid_shots)
                        time.sleep(2)
                        break
                    except Exception as e:
                        print(f"  [!] Could not attach screenshots to form: {e}")

        # --- SUBMIT ISSUE ---
        should_auto_submit = config.get("auto_submit_defect", False)
        
        if should_auto_submit:
            print("  -> Auto-submitting Defect Issue to Jira...")
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
        else:
            print("  [+] All fields filled in Jira Defect form!")
            print("  [-->] Please review the form and click 'Create' / 'Submit' manually in the open Jira browser window.")
            try:
                page.bring_to_front()
            except Exception:
                pass

        # Wait for created issue key (e.g. BDR-1234 or JK26-5678) after manual or auto submission
        issue_key = None
        try:
            if not should_auto_submit:
                # Wait until navigation away from CreateIssue page
                page.wait_for_function("!window.location.href.includes('CreateIssue')", timeout=300000)
            
            page.wait_for_selector(".aui-message-success, #key-val, a.issue-created-key, h1.item-summary", timeout=30000)
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
                issue_key = f"{config.PROJECT_KEY}-DRAFT"

        print(f"[SUCCESS] Defect issue '{issue_key}' processed in Jira!")
        # Browser intentionally left open — close it manually when done.
        return issue_key


def add_comment_with_screenshots(issue_key: str, comment_text: str, screenshot_paths: list[str]):
    """
    Pre-fills a comment with screenshots attached on the given Jira defect issue.
    Does NOT auto-submit; leaves comment box open for user to review and click Save/Comment manually.
    """
    valid_shots = [p for p in (screenshot_paths or []) if os.path.exists(p)]

    with sync_playwright() as p:
        browser, context = _get_context(p)
        page = context.new_page()
        page.goto(f"{config.JIRA_BASE_URL}/browse/{issue_key}")
        page.wait_for_load_state("domcontentloaded")

        try:
            print(f"  -> Opening comment area for {issue_key}...")
            # Click comment button
            for c_btn in ["#footer-comment-button", "a.add-comment-button", "#comment-issue", "#comment-add", "button:has-text('Comment')"]:
                loc = page.locator(c_btn)
                if loc.count() > 0 and loc.first.is_visible(timeout=1000):
                    loc.first.click()
                    time.sleep(0.5)
                    break

            # Fill comment text
            comment_input = page.locator("#comment, textarea[name='comment']")
            if comment_input.count() > 0:
                comment_input.first.fill(comment_text or "Test Evidence Screenshots:")

            # Attach screenshots to comment
            if valid_shots:
                print(f"  -> Attaching {len(valid_shots)} screenshots to comment...")
                for file_sel in ["#comment-add input[type='file']", "input[type='file']", "input.issue-drop-zone__file-input"]:
                    if page.locator(file_sel).count() > 0:
                        try:
                            page.set_input_files(file_sel, valid_shots)
                            time.sleep(2)
                            break
                        except Exception:
                            pass

            try:
                page.bring_to_front()
            except Exception:
                pass

            print("  [+] Comment text pre-filled & screenshots attached!")
            print("  [-->] Please review the comment in your browser window and click 'Save' / 'Add Comment' manually.")

            # Wait for user to submit comment manually
            try:
                # Wait until the comment textarea is no longer visible (meaning it was submitted or cancelled)
                page.wait_for_function(
                    "() => !document.querySelector('#comment') || document.querySelector('#comment').offsetParent === null",
                    timeout=300000
                )
            except Exception:
                pass

        except Exception as e:
            print(f"  [!] Note on comment pre-fill: {e}")
        finally:
            browser.close()

def fetch_te_from_jira(te_key: str) -> dict:
    """
    Navigates to https://jira.prod.mobily.lan/browse/<te_key> using the saved Jira session.
    Scrapes the TE summary/title and any linked Test Case (TC) keys.
    """
    # Handle full URLs: extract key from URL if needed
    if '/browse/' in te_key:
        te_key = te_key.split('/browse/')[-1].split('?')[0].split('#')[0].strip()

    import re
    url = f"{config.JIRA_BASE_URL}/browse/{te_key}"
    print(f"[*] Navigating to Jira TE URL: {url}")

    with sync_playwright() as p:
        browser, context = _get_context(p)
        page = context.new_page()
        page.goto(url)
        page.wait_for_load_state("domcontentloaded")
        # Give dynamic plugins (like Xray/Zephyr) time to load their tables
        page.wait_for_timeout(5000)

        summary = ""
        for sum_sel in ["#summary-val", "h1#summary-val", "h1.item-summary", "h1"]:
            if page.locator(sum_sel).count() > 0 and page.locator(sum_sel).first.is_visible():
                summary = page.locator(sum_sel).first.inner_text().strip()
                break

        tc_data = {}
        page_num = 1
        while True:
            print(f"  -> Scraping page {page_num}...")
            prev_len = len(tc_data)
            
            links = page.locator("a[href*='/browse/']").all()
            for link in links:
                try:
                    href = link.get_attribute("href") or ""
                    match = re.search(r'/browse/([A-Za-z0-9]+-\d+)', href)
                    if match:
                        key = match.group(1).upper()
                        if key != te_key.upper():
                            text = link.inner_text().strip()
                            if key not in tc_data:
                                tc_data[key] = text
                            elif len(text) > len(tc_data[key]):
                                tc_data[key] = text
                except Exception:
                    pass

            if page_num > 1 and len(tc_data) == prev_len:
                print("  -> No new test cases found on this page. Reached the end.")
                break

            # Check for 'Next' button
            next_btn = None
            for sel in [
                "a.icon-next:not([disabled]):not([aria-disabled='true']):not(.disabled)", 
                ".aui-nav-next a:not([disabled]):not([aria-disabled='true']):not(.disabled)", 
                "#exec-entries-table_next:not(.disabled):not([disabled]):not([aria-disabled='true'])",
                ".paginate_button.next:not(.disabled):not([disabled]):not([aria-disabled='true'])"
            ]:
                loc = page.locator(sel)
                if loc.count() > 0 and loc.first.is_visible():
                    next_btn = loc.first
                    break
            
            if next_btn:
                print("  -> Found 'Next' page. Clicking...")
                try:
                    next_btn.click(timeout=3000)
                    page.wait_for_timeout(3000)
                    page_num += 1
                except Exception as e:
                    print(f"  -> Could not click 'Next' button: {e}")
                    break
            else:
                break
                
        # Convert tc_data dict to a list of dicts
        tcs_list = [{"key": k, "name": v} for k, v in tc_data.items()]
        tcs_list = sorted(tcs_list, key=lambda x: x["key"])

        browser.close()
        return {
            "te_key": te_key,
            "summary": summary,
            "test_cases": tcs_list,
            "url": url
        }


if __name__ == "__main__":
    login_and_save_session()
