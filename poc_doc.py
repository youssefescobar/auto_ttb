"""
Maintains a Word file per Test Execution (TE), appending section per TC.
Stores PoC doc at: executions/<TE_KEY>/poc_report_<TE_KEY>.docx
"""
import os
import datetime
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn, nsdecls

import config

def set_cell_background(cell, hex_color: str):
    """Sets background fill color of a docx table cell."""
    tcPr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{hex_color}"/>')
    tcPr.append(shd)

def set_cell_margins(cell, top=120, bottom=120, left=180, right=180):
    """Sets internal padding (dxa) for a table cell."""
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = OxmlElement('w:tcMar')
    for m_name, m_val in [('top', top), ('bottom', bottom), ('left', left), ('right', right)]:
        node = OxmlElement(f'w:{m_name}')
        node.set(qn('w:w'), str(m_val))
        node.set(qn('w:type'), 'dxa')
        tcMar.append(node)
    tcPr.append(tcMar)

def set_table_borders(table, color="CBD5E1", sz="4", val="single"):
    """Sets subtle borders around a table."""
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>\n'
        f'  <w:top w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'  <w:left w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'  <w:bottom w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'  <w:right w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'  <w:insideH w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'  <w:insideV w:val="{val}" w:sz="{sz}" w:space="0" w:color="{color}"/>\n'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

def get_te_doc_path(te_key: str) -> str:
    """Returns absolute/relative path to the PoC docx file for a specific TE."""
    te_dir = os.path.join(config.EXECUTIONS_DIR, te_key)
    os.makedirs(te_dir, exist_ok=True)
    return os.path.join(te_dir, f"poc_report_{te_key}.docx")

def _get_or_create_doc(doc_path: str, te_key: str):
    if os.path.exists(doc_path):
        return Document(doc_path)
    
    doc = Document()
    
    # Page Margins: 0.75 inch (54 pt) all around
    for section in doc.sections:
        section.top_margin = Inches(0.75)
        section.bottom_margin = Inches(0.75)
        section.left_margin = Inches(0.75)
        section.right_margin = Inches(0.75)

    # Document Header Table (Clean Header Banner)
    header_tbl = doc.add_table(rows=1, cols=1)
    header_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = header_tbl.cell(0, 0)
    set_cell_background(cell, "1E293B")  # Dark Slate background
    set_cell_margins(cell, top=200, bottom=200, left=240, right=240)

    p1 = cell.paragraphs[0]
    p1.alignment = WD_ALIGN_PARAGRAPH.LEFT
    r1 = p1.add_run("PROOF OF TESTING (POT) REPORT")
    r1.font.name = 'Calibri'
    r1.font.size = Pt(18)
    r1.font.bold = True
    r1.font.color.rgb = RGBColor(255, 255, 255)

    p2 = cell.add_paragraph()
    r2 = p2.add_run(f"Test Execution Key: {te_key}  |  Generated: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    r2.font.name = 'Calibri'
    r2.font.size = Pt(10)
    r2.font.color.rgb = RGBColor(148, 163, 184)

    # Spacing after document title
    p_spacer = doc.add_paragraph()
    p_spacer.paragraph_format.space_after = Pt(12)

    return doc

def append_tc_pot(
    tc_number: str, 
    status: str, 
    te_key: str = None, 
    summary: str = "", 
    expected_shots: list[str] = None, 
    actual_shots: list[str] = None,
    defect_key: str = None
):
    """
    Appends a TC result to the POT doc with side-by-side small, readable images.
    """
    if not te_key:
        te_key = config.DEFAULT_TE_KEY

    expected_shots = [p for p in (expected_shots or []) if os.path.exists(p)]
    actual_shots = [p for p in (actual_shots or []) if os.path.exists(p)]

    doc_path = get_te_doc_path(te_key)
    doc = _get_or_create_doc(doc_path, te_key)

    status_str = (status or "PASS").upper()
    
    # Status colors
    if status_str == 'PASS':
        status_bg = "DCFCE7"
        status_fg = RGBColor(22, 101, 52)
    elif status_str == 'FAIL':
        status_bg = "FEE2E2"
        status_fg = RGBColor(153, 27, 27)
    else:
        status_bg = "FEF3C7"
        status_fg = RGBColor(146, 64, 14)

    # TC Banner Table (1 row, 2 cells)
    tbl = doc.add_table(rows=1, cols=2)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(tbl, color="CBD5E1", sz="4", val="single")

    cell_left = tbl.cell(0, 0)
    cell_right = tbl.cell(0, 1)

    cell_left.width = Inches(5.2)
    cell_right.width = Inches(1.8)

    set_cell_background(cell_left, "F8FAFC")
    set_cell_background(cell_right, status_bg)
    set_cell_margins(cell_left, top=120, bottom=120, left=160, right=160)
    set_cell_margins(cell_right, top=120, bottom=120, left=160, right=160)

    # TC Title & Info
    p_tc = cell_left.paragraphs[0]
    r_tc = p_tc.add_run(f"Test Case: {tc_number}")
    r_tc.font.name = 'Calibri'
    r_tc.font.size = Pt(13)
    r_tc.font.bold = True
    r_tc.font.color.rgb = RGBColor(15, 23, 42)

    if summary:
        p_sum = cell_left.add_paragraph()
        r_sum_lbl = p_sum.add_run("Summary: ")
        r_sum_lbl.font.bold = True
        r_sum_lbl.font.size = Pt(9.5)
        r_sum_lbl.font.color.rgb = RGBColor(71, 85, 105)
        r_sum_txt = p_sum.add_run(summary)
        r_sum_txt.font.size = Pt(9.5)
        r_sum_txt.font.color.rgb = RGBColor(51, 65, 85)

    if defect_key:
        p_def = cell_left.add_paragraph()
        r_def_lbl = p_def.add_run("Linked Defect: ")
        r_def_lbl.font.bold = True
        r_def_lbl.font.size = Pt(9.5)
        r_def_lbl.font.color.rgb = RGBColor(185, 28, 28)
        r_def_txt = p_def.add_run(defect_key)
        r_def_txt.font.bold = True
        r_def_txt.font.size = Pt(9.5)
        r_def_txt.font.color.rgb = RGBColor(185, 28, 28)

    # Status Pill
    p_st = cell_right.paragraphs[0]
    p_st.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r_st = p_st.add_run(f"[ {status_str} ]")
    r_st.font.name = 'Calibri'
    r_st.font.size = Pt(12)
    r_st.font.bold = True
    r_st.font.color.rgb = status_fg

    # Spacing between banner and images
    p_gap = doc.add_paragraph()
    p_gap.paragraph_format.space_before = Pt(4)
    p_gap.paragraph_format.space_after = Pt(4)

    # Image Section — Side by side layout
    has_exp = len(expected_shots) > 0
    has_act = len(actual_shots) > 0

    if has_exp and has_act:
        # 2-column side-by-side table comparing Expected vs Actual
        img_tbl = doc.add_table(rows=2, cols=2)
        img_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        set_table_borders(img_tbl, color="E2E8F0", sz="4", val="single")

        # Headers
        c_hdr_exp = img_tbl.cell(0, 0)
        c_hdr_act = img_tbl.cell(0, 1)

        c_hdr_exp.width = Inches(3.4)
        c_hdr_act.width = Inches(3.4)

        set_cell_background(c_hdr_exp, "F1F5F9")
        set_cell_background(c_hdr_act, "F1F5F9")
        set_cell_margins(c_hdr_exp, top=80, bottom=80, left=120, right=120)
        set_cell_margins(c_hdr_act, top=80, bottom=80, left=120, right=120)

        p_h1 = c_hdr_exp.paragraphs[0]
        r_h1 = p_h1.add_run("Expected Result (Figma / Design)")
        r_h1.font.bold = True
        r_h1.font.size = Pt(10)
        r_h1.font.color.rgb = RGBColor(30, 41, 59)

        p_h2 = c_hdr_act.paragraphs[0]
        r_h2 = p_h2.add_run("Actual Result (Test Evidence)")
        r_h2.font.bold = True
        r_h2.font.size = Pt(10)
        r_h2.font.color.rgb = RGBColor(30, 41, 59)

        # Image Cells
        c_img_exp = img_tbl.cell(1, 0)
        c_img_act = img_tbl.cell(1, 1)
        c_img_exp.width = Inches(3.4)
        c_img_act.width = Inches(3.4)
        set_cell_margins(c_img_exp, top=100, bottom=100, left=100, right=100)
        set_cell_margins(c_img_act, top=100, bottom=100, left=100, right=100)

        IMAGE_WIDTH = Inches(2.2)

        # Populate Expected images
        for idx, img_path in enumerate(expected_shots):
            p_exp = c_img_exp.paragraphs[0] if idx == 0 else c_img_exp.add_paragraph()
            p_exp.alignment = WD_ALIGN_PARAGRAPH.CENTER
            try:
                run = p_exp.add_run()
                run.add_picture(img_path, width=IMAGE_WIDTH)
            except Exception as e:
                p_exp.add_run(f"[Image load error: {e}]")

        # Populate Actual images
        for idx, img_path in enumerate(actual_shots):
            p_act = c_img_act.paragraphs[0] if idx == 0 else c_img_act.add_paragraph()
            p_act.alignment = WD_ALIGN_PARAGRAPH.CENTER
            try:
                run = p_act.add_run()
                run.add_picture(img_path, width=IMAGE_WIDTH)
            except Exception as e:
                p_act.add_run(f"[Image load error: {e}]")

    elif has_exp or has_act:
        IMAGE_WIDTH = Inches(2.2)
        # Only one category of images exists (Expected or Actual)
        shots = expected_shots if has_exp else actual_shots
        title_text = "Expected Result (Figma / Design)" if has_exp else "Actual Result (Test Evidence)"

        p_lbl = doc.add_paragraph()
        r_lbl = p_lbl.add_run(title_text)
        r_lbl.font.bold = True
        r_lbl.font.size = Pt(10.5)
        r_lbl.font.color.rgb = RGBColor(30, 41, 59)

        # Lay images out in a 3-column grid side-by-side
        num_cols = 3 if len(shots) >= 3 else len(shots)
        num_rows = (len(shots) + num_cols - 1) // num_cols if num_cols > 0 else 1
        grid_tbl = doc.add_table(rows=num_rows, cols=max(1, num_cols))
        grid_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        set_table_borders(grid_tbl, color="E2E8F0", sz="4", val="single")

        for idx, img_path in enumerate(shots):
            r_i = idx // num_cols
            c_i = idx % num_cols
            c = grid_tbl.cell(r_i, c_i)
            c.width = Inches(2.3)
            set_cell_margins(c, top=80, bottom=80, left=80, right=80)
            p = c.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            try:
                run = p.add_run()
                run.add_picture(img_path, width=IMAGE_WIDTH)
            except Exception as e:
                p.add_run(f"[Image error: {e}]")

    # Divider spacing after TC entry
    p_div = doc.add_paragraph()
    p_div.paragraph_format.space_before = Pt(12)
    p_div.paragraph_format.space_after = Pt(12)

    doc.save(doc_path)
    print(f"  -> {tc_number} POT entry saved to {doc_path}")
    return doc_path

def append_pass(tc_key: str, screenshot_paths: list[str] = None, te_key: str = None, summary: str = ""):
    """Helper for pass workflow in CLI/main.py."""
    return append_tc_pot(
        tc_number=tc_key,
        status="PASS",
        te_key=te_key,
        summary=summary or "Test Case Passed",
        actual_shots=screenshot_paths
    )

