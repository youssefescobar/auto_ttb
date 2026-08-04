"""
Maintains a Word file per Test Execution (TE), appending one section per Pass
rather than regenerating the whole doc each time.
Stores PoC doc at: executions/<TE_KEY>/poc_report_<TE_KEY>.docx
"""
import os

from docx import Document
from docx.shared import Inches

import config


def get_te_doc_path(te_key: str) -> str:
    """Returns absolute/relative path to the PoC docx file for a specific TE."""
    te_dir = os.path.join(config.EXECUTIONS_DIR, te_key)
    os.makedirs(te_dir, exist_ok=True)
    return os.path.join(te_dir, f"poc_report_{te_key}.docx")


def _get_or_create_doc(doc_path: str, te_key: str):
    if os.path.exists(doc_path):
        return Document(doc_path)
    doc = Document()
    doc.add_heading(f"Test Execution Report: {te_key} — Proof of Completion", level=0)
    return doc


def append_pass(tc_number: str, screenshot_paths: list[str], te_key: str = None, note: str = ""):
    """
    Adds a new section to the TE's PoC doc: TC number as a heading, an optional
    one-line note, then every screenshot in order.
    """
    if not te_key:
        te_key = config.DEFAULT_TE_KEY

    doc_path = get_te_doc_path(te_key)
    doc = _get_or_create_doc(doc_path, te_key)

    doc.add_heading(f"Test Case: {tc_number}", level=1)
    if note:
        doc.add_paragraph(note)

    for path in screenshot_paths:
        if not os.path.exists(path):
            continue
        doc.add_picture(path, width=Inches(6))

    doc.add_paragraph()  # spacer before the next TC section
    doc.save(doc_path)
    print(f"  -> {tc_number} PoC appended to {doc_path}")


if __name__ == "__main__":
    # quick smoke test with no real screenshots
    append_pass("TC-DEMO-001", [], te_key="TE-TEST", note="Smoke test of the doc-append logic.")
    print("OK — check executions/TE-TEST/poc_report_TE-TEST.docx")

