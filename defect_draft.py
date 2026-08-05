import os
from PIL import Image
from google import genai
from google.genai import types

import config

def _build_system_prompt() -> str:
    env = config.get("environment", "Integration (SIT Android)")
    return f"""You are helping a QA engineer write a structured Jira defect for {env} testing.
Given the notes and images (both Expected Result/Figma designs and Actual Result/Bug screenshots), produce clean, professional QA content.

Produce:
1. Scenario: What test scenario was being executed.
2. Steps to Recreate: Step-by-step numbers.
3. Expected Result: What should have happened according to requirements or Figma specs.
4. Actual Result: What actually happened/observed in the bug screenshot.

Keep each section clear, professional, and concise. No markdown headers with '#'."""

def _get_gemini_client():
    api_key = config.get('gemini_api_key') or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {"error": "GEMINI_API_KEY not found in environment or config.py / .env"}

    http_proxy = config.get('https_proxy') or config.get('http_proxy') or os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or os.environ.get("https_proxy") or os.environ.get("http_proxy")

    try:
        if http_proxy:
            client_options = types.HttpOptions(proxy=http_proxy)
            return genai.Client(api_key=api_key, http_options=client_options)
        return genai.Client(api_key=api_key)
    except Exception as e:
        return {"error": f"Failed to initialize Gemini Client: {e}"}

def generate_defect_title(notes: str, tc_key: str = "", te_key: str = "", expected_shots: list[str] = None, actual_shots: list[str] = None) -> str | dict:
    client_result = _get_gemini_client()
    if isinstance(client_result, dict) and "error" in client_result:
        return client_result

    client = client_result
    contents = []

    all_paths = (expected_shots or []) + (actual_shots or [])
    for path in all_paths:
        if path and os.path.exists(path):
            try:
                contents.append(Image.open(path))
            except Exception:
                pass

    contents.append(f"Generate a single, concise 4-8 word QA bug summary for these notes: {notes}")

    ai_title = notes[:60]
    try:
        response = client.models.generate_content(
            model=config.get('gemini_model', "gemini-2.5-flash"),
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction="You write concise, professional bug titles for software Jira issues. Return ONLY the title details text, max 8 words, no punctuation at the end.",
                temperature=0.2,
                max_output_tokens=30,
            ),
        )
        if response.text:
            ai_title = response.text.strip().strip('"').strip("'")
    except Exception as e:
        return {"error": f"AI Title generation error: {e}"}

    prefix = config.get("defect_title_prefix", "LightMode_SIT_Android_")
    pattern = config.get("defect_title_pattern", "LightMode_SIT_Android_{AI_TITLE}")
    
    if "{AI_TITLE}" in pattern:
        formatted_title = pattern.format(TE_KEY=te_key, TC_KEY=tc_key, AI_TITLE=ai_title)
    else:
        formatted_title = f"{prefix}{ai_title}"

    if not formatted_title.startswith(prefix):
        formatted_title = f"{prefix}{formatted_title}"

    return formatted_title

def draft_defect_sections(notes: str, expected_shots: list[str] = None, actual_shots: list[str] = None) -> dict:
    client_result = _get_gemini_client()
    if isinstance(client_result, dict) and "error" in client_result:
        return client_result

    client = client_result
    contents = []

    if expected_shots:
        contents.append("Below are EXPECTED RESULT / FIGMA DESIGN images:")
        for path in expected_shots:
            if path and os.path.exists(path):
                try: contents.append(Image.open(path))
                except Exception: pass

    if actual_shots:
        contents.append("Below are ACTUAL BUG RESULT images:")
        for path in actual_shots:
            if path and os.path.exists(path):
                try: contents.append(Image.open(path))
                except Exception: pass

    contents.append(f"QA Notes: {notes}")

    try:
        response = client.models.generate_content(
            model=config.get('gemini_model', "gemini-2.5-flash"),
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=_build_system_prompt(),
                temperature=0.2,
                max_output_tokens=800,
            ),
        )
        raw_text = response.text.strip()
        
        # Parse into sections if possible or return raw
        return {
            "raw": raw_text,
            "scenario": _extract_section(raw_text, "Scenario"),
            "steps": _extract_section(raw_text, "Steps to Recreate"),
            "expected": _extract_section(raw_text, "Expected Result"),
            "actual": _extract_section(raw_text, "Actual Result"),
        }
    except Exception as e:
        return {"error": f"Gemini generation error: {e}"}

def _extract_section(text: str, header: str) -> str:
    lines = text.split("\n")
    capturing = False
    captured_lines = []
    headers = ["Scenario:", "Steps to Recreate:", "Expected Result:", "Actual Result:"]
    
    for line in lines:
        if line.strip().startswith(header):
            capturing = True
            continue
        if capturing:
            if any(line.strip().startswith(h) for h in headers if h != header):
                break
            captured_lines.append(line)
    
    return "\n".join(captured_lines).strip()

def build_full_defect_description(
    scenario: str,
    steps: str,
    expected: str,
    actual: str,
    test_data: str = "",
    qa_analysis: str = "",
) -> str:
    parts = []
    if scenario:
        parts.append(f"Scenario:\n{scenario}")
    if steps:
        parts.append(f"\nSteps to Recreate:\n{steps}")
    if expected:
        parts.append(f"\nExpected Result:\n{expected}")
    if actual:
        parts.append(f"\nActual Result:\n{actual}")
    if test_data and test_data.strip():
        parts.append(f"\nTest Data:\n{test_data}")
    if qa_analysis and qa_analysis.strip():
        parts.append(f"\nQA Analysis:\n{qa_analysis}")

    return "\n".join(parts).strip()
