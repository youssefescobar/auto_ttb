"""
Daily driver for test case execution automation.

Usage:
    python main.py TC-123
    python main.py --te TE-101 TC-123

Walks you through Pass or Fail, grabs your clipboard screenshots into
executions/<TE_KEY>/<TC_KEY>/, generates PoC docx per TE, and files defects to Jira.
"""
import argparse
import os
import sys

import config
import jira_actions
import poc_doc
import screenshot
from defect_draft import draft_defect, generate_defect_title, review_and_edit


def check_session():
    """Ensure Jira session exists before running workflow."""
    if not os.path.exists(config.BROWSER_STATE_PATH):
        print(f"\n[!] Jira session file '{config.BROWSER_STATE_PATH}' not found.")
        print("    Running initial Jira login sequence...\n")
        jira_actions.login_and_save_session()


def run(tc_key: str, te_key: str = None):
    check_session()

    # Prompt for TE key if not supplied
    if not te_key:
        default_te = getattr(config, "DEFAULT_TE_KEY", "TE-001")
        entered_te = input(f"Enter Test Execution (TE) key [Default: {default_te}]: ").strip()
        te_key = entered_te if entered_te else default_te

    print(f"\n========================================")
    print(f" Test Execution : {te_key}")
    print(f" Test Case       : {tc_key}")
    print(f"========================================\n")

    # Ensure execution directories exist
    tc_dir = os.path.join(config.EXECUTIONS_DIR, te_key, tc_key)
    os.makedirs(tc_dir, exist_ok=True)

    jira_actions.transition_tc(tc_key, config.TRANSITION_EXECUTING)

    result = input(f"\n{tc_key} — Pass or Fail? [p/f/q (quit)]: ").strip().lower()

    if result in ("q", "quit", "cancel"):
        print("Execution cancelled.")
        return

    if result == "p":
        print("\nAttach your PoC screenshot(s):")
        shots = screenshot.collect_screenshots(te_key=te_key, tc_key=tc_key)
        poc_doc.append_pass(tc_key=tc_key, screenshot_paths=shots, te_key=te_key)
        jira_actions.transition_tc(tc_key, config.TRANSITION_PASS)
        poc_path = poc_doc.get_te_doc_path(te_key)
        print(f"\n[SUCCESS] {tc_key} passed! PoC updated at: {poc_path}")

    elif result == "f":
        notes = input("Quick shorthand notes on what's wrong: ").strip()
        print("\nAttach screenshot(s) of the defect:")
        shots = screenshot.collect_screenshots(te_key=te_key, tc_key=tc_key)

        print("\nGenerating AI defect title and description with Gemini...")
        draft_body = draft_defect(notes, shots)
        proposed_summary = generate_defect_title(notes, tc_key=tc_key, te_key=te_key, screenshot_paths=shots)

        try:
            final_summary, final_body = review_and_edit(proposed_summary, draft_body)
        except KeyboardInterrupt:
            print("\nDefect filing cancelled.")
            return

        issue_key = jira_actions.create_defect(final_summary, final_body, shots)
        jira_actions.add_comment_with_screenshots(issue_key, final_body, shots)
        jira_actions.transition_tc(tc_key, config.TRANSITION_FAIL)

        print(f"\n[SUCCESS] {tc_key} failed — Defect {issue_key} filed successfully in Jira.")

    else:
        print("Invalid input. Type 'p' for Pass or 'f' for Fail.")


def main():
    parser = argparse.ArgumentParser(description="QA Test Case Execution CLI")
    parser.add_argument("tc_key", nargs="?", help="Test Case Key (e.g. TC-123)")
    parser.add_argument("--te", dest="te_key", help="Test Execution Key (e.g. TE-101)")

    args = parser.parse_args()

    tc_key = args.tc_key
    if not tc_key:
        tc_key = input("Enter Test Case key (e.g. TC-123): ").strip()
        if not tc_key:
            print("Test Case key is required.")
            sys.exit(1)

    run(tc_key=tc_key, te_key=args.te_key)


if __name__ == "__main__":
    main()


