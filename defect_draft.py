import os
from PIL import Image
from google import genai
from google.genai import types

import config

SYSTEM_PROMPT = """You are helping a QA engineer write a Jira defect from
rough shorthand notes taken while manually testing. Given the notes (and
optionally screenshot images), produce exactly three sections, plainly labeled,
in clear professional QA language. Do not invent details the notes don't
support — if something is unclear, phrase it as observed rather than assumed.

Scenario: what steps were being executed
Expected: what should have happened
Actual: what actually happened

Keep each section to 1-3 sentences. No preamble, no markdown headers with
'#', just the three labeled sections."""


def _get_gemini_client():
    api_key = config.GEMINI_API_KEY or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("\n[!] Warning: GEMINI_API_KEY not found in environment or config.py / .env")
        print("    Set GEMINI_API_KEY to enable AI defect drafting.\n")
    return genai.Client(api_key=api_key) if api_key else genai.Client()


def generate_defect_title(notes: str, tc_key: str = "", te_key: str = "", screenshot_paths: list[str] | str | None = None) -> str:
    """
    Generates a concise 4-8 word AI summary title from notes/screenshots,
    formatted using config.DEFECT_TITLE_PATTERN (e.g. '[TE-101][TC-123] Login fails on click').
    """
    client = _get_gemini_client()
    contents = []

    paths = [screenshot_paths] if isinstance(screenshot_paths, str) else (screenshot_paths or [])
    for path in paths:
        if path and os.path.exists(path):
            try:
                contents.append(Image.open(path))
            except Exception:
                pass

    contents.append(f"Generate a single, concise 4-8 word QA bug summary for these notes: {notes}")

    ai_title = notes[:60]
    try:
        response = client.models.generate_content(
            model=config.GEMINI_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction="You write concise, professional bug titles for software Jira issues. Return ONLY the title text, max 8 words, no punctuation at the end.",
                temperature=0.2,
                max_output_tokens=30,
            ),
        )
        if response.text:
            ai_title = response.text.strip().strip('"').strip("'")
    except Exception as e:
        print(f"[!] AI Title generation error: {e}")

    # Format using configured pattern
    pattern = getattr(config, "DEFECT_TITLE_PATTERN", "[{TE_KEY}][{TC_KEY}] {AI_TITLE}")
    formatted_title = pattern.format(TE_KEY=te_key, TC_KEY=tc_key, AI_TITLE=ai_title)
    return formatted_title


def draft_defect(notes: str, screenshot_paths: list[str] | str | None = None) -> str:
    """
    Generates a defect draft using Google Gemini AI model.
    Accepts single or multiple screenshot paths.
    """
    client = _get_gemini_client()
    contents = []

    paths = [screenshot_paths] if isinstance(screenshot_paths, str) else (screenshot_paths or [])
    for path in paths:
        if path and os.path.exists(path):
            try:
                img = Image.open(path)
                contents.append(img)
            except Exception as e:
                print(f"[!] Could not load screenshot '{path}' for Gemini: {e}")

    contents.append(f"Notes: {notes}")

    try:
        response = client.models.generate_content(
            model=config.GEMINI_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                temperature=0.2,
                max_output_tokens=500,
            ),
        )
        return response.text.strip()
    except Exception as e:
        print(f"[!] Gemini generation error: {e}")
        return (
            f"Scenario: Executed test scenario based on user notes.\n"
            f"Expected: System operates cleanly without errors.\n"
            f"Actual: {notes}"
        )


def review_and_edit(summary: str, description: str) -> tuple[str, str]:
    """
    Displays proposed Summary Title and Description, allowing interactive review/edit
    before submitting to Jira.
    """
    current_summary = summary
    current_description = description

    while True:
        print("\n=================== DEFECT REVIEW ===================")
        print(f"SUMMARY TITLE: {current_summary}")
        print("-----------------------------------------------------")
        print("DESCRIPTION BODY:")
        print(current_description)
        print("=====================================================")
        print("Options: [y] Accept & File | [t] Edit Title | [d] Edit Description | [q] Cancel")
        
        choice = input("Select option [Y/t/d/q]: ").strip().lower()

        if choice in ("", "y", "yes"):
            return current_summary, current_description
        elif choice == "t":
            new_title = input(f"Enter new title [{current_summary}]: ").strip()
            if new_title:
                current_summary = new_title
        elif choice == "d":
            print("Paste replacement description text below, followed by an empty line:")
            lines = []
            while True:
                line = input()
                if line == "":
                    break
                lines.append(line)
            if lines:
                current_description = "\n".join(lines)
        elif choice in ("q", "quit", "cancel"):
            raise KeyboardInterrupt("Defect creation cancelled by user.")
        else:
            print("Invalid option. Type 'y' to accept, 't' to edit title, 'd' to edit description, or 'q' to cancel.")


