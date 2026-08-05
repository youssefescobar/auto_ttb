"""
Interactive Step-by-Step CLI Wizard for QA Test Execution & Jira Defect Logging.

Usage:
    python main.py
    (or double click start.bat)
"""
import argparse
import os
import sys

import config
import jira_actions
import poc_doc
import screenshot
from defect_draft import (
    build_full_defect_description,
    draft_defect_sections,
    generate_defect_title,
    review_and_edit,
)


def check_session():
    """Ensure Jira session exists before running workflow."""
    if not os.path.exists(config.BROWSER_STATE_PATH):
        print(f"\n[!] Jira session file '{config.BROWSER_STATE_PATH}' not found.")
        print("    Running initial Jira browser login sequence...\n")
        jira_actions.login_and_save_session()


def print_banner():
    print("\n" + "=" * 60)
    print("      B2B Digital Revamp (BDR) - QA Test Execution Wizard    ")
    print("=" * 60)
    print(f" Project Key      : {config.PROJECT_KEY}")
    print(f" Technical Project: {config.TECHNICAL_PROJECT}")
    print(f" Demo             : {config.DEMO_NAME}")
    print(f" Defect Prefix    : {config.DEFECT_TITLE_PREFIX}")
    print(f" Defect Label     : {config.DEFECT_BOILERPLATE.get('labels', ['Lightmode'])}")
    print("=" * 60 + "\n")


def run_interactive_wizard(tc_key: str = None, te_key: str = None):
    check_session()
    print_banner()

    # Step 1: Test Execution Key
    if not te_key:
        default_te = getattr(config, "DEFAULT_TE_KEY", "TE-001")
        entered_te = input(f"[Step 1/4] Enter Test Execution (TE) key [Default: {default_te}]: ").strip()
        te_key = entered_te if entered_te else default_te

    # Step 2: Test Case Key
    if not tc_key:
        tc_key = input(f"[Step 2/4] Enter Test Case (TC) key (e.g. TC-123): ").strip()
        while not tc_key:
            print("  [!] Test Case key is required.")
            tc_key = input(f"[Step 2/4] Enter Test Case (TC) key (e.g. TC-123): ").strip()

    print(f"\n---> Execution Context: TE = {te_key} | TC = {tc_key}\n")

    # Ensure execution directories exist
    tc_dir = os.path.join(config.EXECUTIONS_DIR, te_key, tc_key)
    os.makedirs(tc_dir, exist_ok=True)

    try:
        jira_actions.transition_tc(tc_key, config.TRANSITION_EXECUTING)
    except Exception as e:
        print(f"  [!] Note on transition to executing: {e}")

    # Step 3: Pass or Fail decision
    result = input(f"[Step 3/4] Did {tc_key} PASS or FAIL? [p=Pass / f=Fail / q=Quit]: ").strip().lower()

    if result in ("q", "quit", "cancel"):
        print("\n[!] Execution cancelled by user.")
        return

    # PASS WORKFLOW
    if result in ("p", "pass"):
        print("\n--- Screenshot Collection for PASS ---")
        shots = screenshot.collect_screenshots(te_key=te_key, tc_key=tc_key)
        poc_doc.append_pass(tc_key=tc_key, screenshot_paths=shots, te_key=te_key)
        try:
            jira_actions.transition_tc(tc_key, config.TRANSITION_PASS)
        except Exception as e:
            print(f"  [!] Note on transition to pass: {e}")

        poc_path = poc_doc.get_te_doc_path(te_key)
        print(f"\n=======================================================")
        print(f" [SUCCESS] {tc_key} PASSED!")
        print(f" Proof of Concept (PoC) updated at: {poc_path}")
        print(f"=======================================================\n")

    # FAIL WORKFLOW
    elif result in ("f", "fail"):
        print("\n--- [Step 4/4] Interactive Defect Information Gathering ---")
        
        notes = input("1. Shorthand notes on what failed / bug description: ").strip()
        while not notes:
            notes = input("   Notes are required. Please describe what failed: ").strip()

        severity = input("2. Defect Severity [e.g. Critical / Major / Medium / Minor] [Default: Medium]: ").strip()
        if not severity:
            severity = "Medium"

        blocked_tcs = input("3. Number of test cases blocked [Default: 1]: ").strip()
        if not blocked_tcs:
            blocked_tcs = "1"

        assignee = input("4. Assignee Name (e.g. John Doe / username): ").strip()

        test_data = input("5. Test Data used (press Enter if none): ").strip()

        qa_analysis = input("6. QA Analysis / Root cause notes (press Enter if none): ").strip()

        print("\n--- Screenshot Collection for DEFECT ---")
        shots = screenshot.collect_screenshots(te_key=te_key, tc_key=tc_key)

        print("\nGenerating AI Defect Title & Structured Content with Gemini...")
        
        # Title starts with LightMode_SIT_Android_
        proposed_summary = generate_defect_title(notes, tc_key=tc_key, te_key=te_key, screenshot_paths=shots)
        
        # AI generates Scenario, Steps to Recreate, Expected Result, Actual Result
        ai_sections = draft_defect_sections(notes, screenshot_paths=shots)

        # Assemble full body including Demo 1, Technical Project, Severity, Blocked TCs, Assignee, Test Data, QA Analysis
        full_description = build_full_defect_description(
            severity=severity,
            blocked_tcs=blocked_tcs,
            assignee=assignee,
            test_data=test_data,
            qa_analysis=qa_analysis,
            ai_sections=ai_sections,
        )

        try:
            final_summary, final_body = review_and_edit(proposed_summary, full_description)
        except KeyboardInterrupt:
            print("\n[!] Defect filing cancelled by user.")
            return

        print("\nSubmitting defect to Jira...")
        try:
            issue_key = jira_actions.create_defect(
                summary=final_summary,
                description=final_body,
                screenshot_paths=shots,
                assignee=assignee,
                priority=severity
            )
            jira_actions.add_comment_with_screenshots(issue_key, final_body, shots)
            jira_actions.transition_tc(tc_key, config.TRANSITION_FAIL)

            print(f"\n=======================================================")
            print(f" [SUCCESS] {tc_key} FAILED")
            print(f" Defect '{issue_key}' filed in Jira with summary:")
            print(f"   {final_summary}")
            print(f"=======================================================\n")
        except Exception as e:
            print(f"\n[!] Error submitting defect to Jira: {e}")
            print("Your draft text was:")
            print(f"SUMMARY: {final_summary}")
            print(f"BODY:\n{final_body}")

    else:
        print("Invalid choice. Please enter 'p' for Pass or 'f' for Fail.")


def main():
    parser = argparse.ArgumentParser(description="Interactive Step-by-Step QA Test Execution CLI")
    parser.add_argument("tc_key", nargs="?", help="Optional Test Case Key (e.g. TC-123)")
    parser.add_argument("--te", dest="te_key", help="Optional Test Execution Key (e.g. TE-101)")

    args = parser.parse_args()
    run_interactive_wizard(tc_key=args.tc_key, te_key=args.te_key)


if __name__ == "__main__":
    main()
