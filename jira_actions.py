"""
Playwright driving your actual Jira Server/DC UI — same as a human clicking,
just scripted. Logs in once, saves the session, reuses it after that so you
don't SSO every run.

*** IMPORTANT — READ THIS BEFORE RUNNING ***
The selectors below (#summary, #description, etc.) are the standard IDs
Jira Server/DC ships with, but your instance may be customized. If a step
fails, the fastest fix is NOT guessing — record the real selectors yourself:

    playwright codegen https://jira.yourcompany.com

Click through "create a defect" and "transition a TC" once in the recorder
window. It spits out working code with your instance's actual selectors —
paste the relevant lines in over the TODOs below.
"""
import os
import sys
from playwright.sync_api import sync_playwright

import config


def login_and_save_session():
    """
    Run this once (or whenever your session expires). Opens a real browser
    window, you log in manually (SSO/2FA/whatever your company requires),
    then press Enter in the terminal — it saves the session so future runs
    are headless and don't need you to log in again.
    """
    print(f"Opening browser to {config.JIRA_BASE_URL}...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        page.goto(config.JIRA_BASE_URL)
        input("\n--> Log in manually in the opened browser window, then press Enter here to save session...")
        page.context.storage_state(path=config.BROWSER_STATE_PATH)
        browser.close()
    print(f"Session saved successfully to '{config.BROWSER_STATE_PATH}'.")


def _get_context(p):
    headless_setting = getattr(config, "HEADLESS_BROWSER", True)
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

        # TODO verify with codegen — classic Jira Server puts transitions
        # under a "Workflow" dropdown when there are >2 options
        more_button = page.locator("#opsbar-transitions_more")
        if more_button.is_visible():
            more_button.click()
        page.get_by_text(transition_name, exact=True).click()

        # most transitions open a confirm screen with its own submit button
        submit = page.locator("#issue-workflow-transition-submit")
        if submit.is_visible():
            submit.click()

        print(f"  -> {tc_key} transitioned to '{transition_name}'")
        browser.close()


def create_defect(summary: str, description: str, screenshot_paths: list[str]) -> str:
    """
    Files a new defect using config.DEFECT_BOILERPLATE for the fixed fields
    plus the summary/description you pass in. Returns the created issue key.
    """
    with sync_playwright() as p:
        browser, context = _get_context(p)
        page = context.new_page()
        page.goto(f"{config.JIRA_BASE_URL}/secure/CreateIssue.jspa")

        # TODO verify with codegen — project/issue-type pickers are often
        # custom autocomplete widgets rather than plain <select>
        page.select_option("#project-field", label=config.PROJECT_KEY)
        page.select_option("#issuetype-field", label=config.DEFECT_ISSUE_TYPE)
        page.click("#issue-create-submit")  # "Next" on the project/type step

        page.fill("#summary", summary)
        page.fill("#description", description)

        if config.DEFECT_BOILERPLATE.get("priority"):
            page.select_option("#priority-field", label=config.DEFECT_BOILERPLATE["priority"])
        for label in config.DEFECT_BOILERPLATE.get("labels", []):
            page.fill("#labels-textarea", label)
            page.keyboard.press("Enter")

        for path in screenshot_paths:
            if os.path.exists(path):
                page.set_input_files("input[type='file']", path)

        page.click("#issue-create-submit")
        page.wait_for_selector(".aui-message-success, #key-val")

        # TODO verify with codegen — this grabs the created issue key off
        # the success banner / redirected issue page
        issue_key = page.locator("#key-val").inner_text().strip()
        print(f"  -> Defect {issue_key} created successfully")
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

        print(f"  -> Comment attached to {issue_key}")
        browser.close()


if __name__ == "__main__":
    login_and_save_session()

