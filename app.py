import os
import json
import time
import threading
from flask import Flask, request, jsonify, send_file, send_from_directory, render_template
from pathlib import Path

import config
import jira_actions
import defect_draft
import poc_doc
import db

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB upload limit

@app.after_request
def add_cors_headers(response):
    origin = request.headers.get('Origin', '')
    if origin.startswith('http://localhost') or origin.startswith('http://127.0.0.1'):
        response.headers['Access-Control-Allow-Origin'] = origin
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS, PUT, DELETE'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/login', methods=['POST'])
def api_login():
    res = jira_actions.start_login_session()
    return jsonify(res)

@app.route('/api/save-session', methods=['POST'])
def api_save_session():
    res = jira_actions.save_login_session()
    return jsonify(res)

@app.route('/api/session-status', methods=['GET'])
def api_session_status():
    res = jira_actions.get_login_status()
    return jsonify(res)

@app.route('/api/settings', methods=['GET', 'POST'])
def api_settings():
    if request.method == 'GET':
        all_settings = config.get_all_settings()
        all_settings.pop('gemini_api_key', None)
        all_settings.pop('gemini_model', None)
        return jsonify(all_settings)

    data = request.json or {}
    config.set_overrides(data)
    return jsonify({"status": "updated"})

# --- Screenshot handling with expected vs actual categories ---
@app.route('/api/upload-screenshots', methods=['POST'])
def api_upload_screenshots():
    te_key = request.form.get('te_key')
    tc_key = request.form.get('tc_key')
    category = request.form.get('category', 'actual')  # 'expected' or 'actual'
    files = request.files.getlist('screenshots')

    if not te_key or not tc_key:
        return jsonify({"error": "Missing te_key or tc_key"}), 400

    save_dir = os.path.join(os.path.abspath(config.EXECUTIONS_DIR), te_key, tc_key, category)
    if not os.path.realpath(save_dir).startswith(os.path.realpath(config.EXECUTIONS_DIR)):
        return jsonify({"error": "Invalid path"}), 400
    os.makedirs(save_dir, exist_ok=True)

    saved_files = []
    for i, file in enumerate(files):
        if file.filename:
            ext = os.path.splitext(file.filename)[1] or '.png'
            timestamp = int(time.time() * 1000)
            filename = f"shot_{timestamp}_{i}{ext}"
            filepath = os.path.join(save_dir, filename)
            file.save(filepath)
            saved_files.append({
                "name": filename,
                "path": os.path.abspath(filepath),
                "url": f"/api/screenshot-file/{te_key}/{tc_key}/{category}/{filename}",
                "category": category
            })

    return jsonify({"files": saved_files})

@app.route('/api/screenshots/<te_key>/<tc_key>', methods=['GET'])
def api_get_screenshots(te_key, tc_key):
    tc_dir = os.path.join(os.path.abspath(config.EXECUTIONS_DIR), te_key, tc_key)
    if not os.path.realpath(tc_dir).startswith(os.path.realpath(config.EXECUTIONS_DIR)):
        return jsonify({"error": "Invalid path"}), 400
    result = {"expected": [], "actual": []}

    for cat in ["expected", "actual"]:
        cat_dir = os.path.join(tc_dir, cat)
        if os.path.exists(cat_dir):
            filenames = [f for f in os.listdir(cat_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))]
            for f in sorted(filenames):
                result[cat].append({
                    "name": f,
                    "url": f"/api/screenshot-file/{te_key}/{tc_key}/{cat}/{f}",
                    "path": os.path.abspath(os.path.join(cat_dir, f)),
                    "category": cat
                })

    return jsonify(result)

@app.route('/api/screenshot-file/<te_key>/<tc_key>/<category>/<filename>', methods=['GET'])
def api_screenshot_file(te_key, tc_key, category, filename):
    save_dir = os.path.join(os.path.abspath(config.EXECUTIONS_DIR), te_key, tc_key, category)
    filepath = os.path.join(save_dir, filename)
    if not os.path.realpath(filepath).startswith(os.path.realpath(save_dir)):
        return jsonify({"error": "Invalid path"}), 400
    return send_from_directory(save_dir, filename)

@app.route('/api/delete-screenshot', methods=['POST'])
def api_delete_screenshot():
    try:
        data = request.json or {}
        te_key = data.get('te_key')
        tc_key = data.get('tc_key')
        category = data.get('category')
        filename = data.get('filename')

        if not te_key or not tc_key or not category or not filename:
            return jsonify({"error": "Missing parameters"}), 400

        save_dir = os.path.join(os.path.abspath(config.EXECUTIONS_DIR), te_key, tc_key, category)
        filepath = os.path.abspath(os.path.join(save_dir, os.path.basename(filename)))

        if filepath.startswith(save_dir) and os.path.exists(filepath):
            os.remove(filepath)
            return jsonify({"status": "deleted", "filename": filename})

        return jsonify({"error": "File not found"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- AI Generation ---
@app.route('/api/generate-defect', methods=['POST'])
def api_generate_defect():
    try:
        data = request.json or {}
        notes = data.get('notes', '')
        tc_key = data.get('tc_key', '')
        te_key = data.get('te_key', '')
        expected_shots = data.get('expected_shots', [])
        actual_shots = data.get('actual_shots', [])

        # Check AI screenshot sharing setting
        if not config.get('share_screenshots_with_ai', True):
            expected_shots = []
            actual_shots = []

        # AI Title
        title_res = defect_draft.generate_defect_title(
            notes=notes,
            tc_key=tc_key,
            te_key=te_key,
            expected_shots=expected_shots,
            actual_shots=actual_shots,
        )

        ai_error = None
        if isinstance(title_res, dict) and "error" in title_res:
            ai_error = title_res["error"]
            print(f"[!] AI Title error: {ai_error}")
            prefix = config.get("defect_title_prefix", "LightMode_SIT_Android_")
            title = f"{prefix}{notes[:60]}"
        else:
            title = title_res

        # AI Sections
        sections = defect_draft.draft_defect_sections(
            notes=notes,
            expected_shots=expected_shots,
            actual_shots=actual_shots,
        )

        if isinstance(sections, dict) and "error" in sections:
            ai_error = sections["error"]
            print(f"[!] AI Sections error: {ai_error}")
            sections = {}

        return jsonify({
            "title": title,
            "scenario": sections.get("scenario") or f"Executing scenario for {tc_key}",
            "steps": sections.get("steps") or "1. Open app\n2. Perform steps",
            "expected": sections.get("expected") or "Title and layout should match Figma designs",
            "actual": sections.get("actual") or notes,
            "raw": sections.get("raw", ""),
            "ai_error": ai_error
        })
    except Exception as e:
        print(f"[!] API Generate Defect error: {e}")
        return jsonify({"error": str(e)}), 500

# --- Save to POT manually or on Pass/Fail ---
@app.route('/api/save-pot', methods=['POST'])
def api_save_pot():
    try:
        data = request.json or {}
        tc_key = data.get('tc_key')
        tc_name = data.get('tc_name') or tc_key
        te_key = data.get('te_key')
        status = data.get('status', 'PASS')
        summary = data.get('summary', '')
        defect_key = data.get('defect_key', None)
        expected_shots = data.get('expected_shots', [])
        actual_shots = data.get('actual_shots', [])
        blocked_tcs = data.get('blocked_tcs', '')

        doc_path = poc_doc.append_tc_pot(
            tc_number=tc_name,
            status=status,
            te_key=te_key,
            summary=summary,
            expected_shots=expected_shots,
            actual_shots=actual_shots,
            defect_key=defect_key,
            blocked_tcs=blocked_tcs
        )
        return jsonify({"status": "success", "doc_path": doc_path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/pass-tc', methods=['POST'])
def api_pass_tc():
    try:
        data = request.json or {}
        tc_key = data.get('tc_key')
        tc_name = data.get('tc_name') or tc_key
        tc_number = data.get('tc_number')
        te_key = data.get('te_key')
        expected_shots = data.get('expected_shots', [])
        actual_shots = data.get('actual_shots', [])

        saved_pot = False
        # Auto append to POT only if auto_save_pot is enabled
        if config.get('auto_save_pot', False):
            poc_doc.append_tc_pot(
                tc_number=tc_name,
                status="PASS",
                te_key=te_key,
                summary=data.get('summary', 'Test Case Passed'),
                expected_shots=expected_shots,
                actual_shots=actual_shots
            )
            saved_pot = True

        target_jira_key = tc_number or tc_key
        if target_jira_key and ("-" in str(target_jira_key) or str(target_jira_key).startswith("QA-") or str(target_jira_key).startswith("TC-")):
            try:
                jira_actions.transition_tc(target_jira_key, config.get('transition_pass', 'Pass'))
            except Exception as e:
                print(f"[!] Transition warning: {e}")
        else:
            print(f"[!] Skipping Jira transition: '{target_jira_key}' is not a valid Jira TC number.")

        return jsonify({"status": "success", "saved_pot": saved_pot})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/fail-tc', methods=['POST'])
def api_fail_tc():
    try:
        data = request.json or {}
        tc_key = data.get('tc_key')
        tc_name = data.get('tc_name') or tc_key
        tc_number = data.get('tc_number')
        te_key = data.get('te_key')
        title = data.get('defect_title')
        
        # Build full description from fields
        description = defect_draft.build_full_defect_description(
            scenario=data.get('scenario', ''),
            steps=data.get('steps', ''),
            expected=data.get('expected', ''),
            actual=data.get('actual', ''),
            test_data=data.get('test_data', ''),
            qa_analysis=data.get('qa_analysis', '')
        )

        all_shots = data.get('expected_shots', []) + data.get('actual_shots', [])

        issue_key = jira_actions.create_defect(
            summary=title,
            description=description,
            screenshot_paths=all_shots,
            assignee=data.get('assignee'),
            priority=data.get('severity', '1-Low'),
            data=data
        )

        saved_pot = False
        return jsonify({"issue_key": issue_key, "saved_pot": saved_pot})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/rebuild-pot', methods=['POST'])
def api_rebuild_pot():
    try:
        data = request.json or {}
        te_key = data.get('te_key')
        if not te_key:
            return jsonify({"error": "Missing te_key"}), 400

        te_data = db.get_te(te_key)
        test_cases = te_data.get('test_cases', [])

        # Gather screenshot paths for each TC
        for tc in test_cases:
            tc_key = tc.get('key', '') or tc.get('name', '')
            tc_dir = os.path.join(os.path.abspath(config.EXECUTIONS_DIR), te_key, tc_key)
            tc['expected_shots'] = []
            tc['actual_shots'] = []
            for cat in ['expected', 'actual']:
                cat_dir = os.path.join(tc_dir, cat)
                if os.path.exists(cat_dir):
                    for f in sorted(os.listdir(cat_dir)):
                        if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')):
                            tc[f'{cat}_shots'].append(os.path.abspath(os.path.join(cat_dir, f)))

        doc_path = poc_doc.rebuild_pot(te_key, test_cases)
        return jsonify({"status": "success", "doc_path": doc_path, "tc_count": len(test_cases)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/download-poc/<te_key>', methods=['GET'])
def api_download_poc(te_key):
    try:
        poc_path = poc_doc.get_te_doc_path(te_key)
        if not os.path.exists(poc_path):
            return jsonify({"error": "POT document not found. Process at least one TC first."}), 404
        return send_file(os.path.abspath(poc_path), as_attachment=True)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- Central JSON DB Endpoints ---
@app.route('/api/db', methods=['GET', 'POST'])
def api_database():
    try:
        if request.method == 'GET':
            return jsonify(db.read_db())

        data = request.json or {}
        db.write_db(data)
        return jsonify({"status": "updated", "message": "db.json updated successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/te-list', methods=['GET'])
def api_te_list():
    try:
        return jsonify(db.get_all_tes())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/te/<te_key>', methods=['DELETE'])
def api_delete_te(te_key):
    try:
        exec_dir = os.path.abspath(config.EXECUTIONS_DIR)
        target_dir = os.path.abspath(os.path.join(exec_dir, te_key))
        if not target_dir.startswith(exec_dir):
            return jsonify({"error": "Invalid te_key path"}), 400

        success = db.delete_te(te_key)
        
        # Clean up physical directory from disk (screenshots, word report, state)
        if os.path.exists(target_dir):
            import shutil
            shutil.rmtree(target_dir, ignore_errors=True)
            success = True

        return jsonify({"status": "deleted" if success else "not_found"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/fetch-jira-te', methods=['POST'])
def api_fetch_jira_te():
    try:
        data = request.json or {}
        raw_input = data.get('te_key', '').strip()
        # Extract key from URL if a full Jira URL was pasted
        if '/browse/' in raw_input:
            te_key = raw_input.split('/browse/')[-1].split('?')[0].split('#')[0].strip()
        else:
            te_key = raw_input
        if not te_key:
            return jsonify({"error": "Missing te_key"}), 400

        result = jira_actions.fetch_te_from_jira(te_key)

        if result.get("test_cases"):
            existing_te = db.get_te(te_key)
            existing_tcs = existing_te.get("test_cases", [])
            # Also check existing tc_number to avoid duplicates
            existing_keys = {tc.get("key") for tc in existing_tcs}
            existing_keys.update({tc.get("tc_number") for tc in existing_tcs if tc.get("tc_number")})

            for new_tc_dict in result["test_cases"]:
                tc_id = new_tc_dict["key"]
                tc_title = new_tc_dict["name"]
                
                final_name = tc_title if tc_title != tc_id else tc_id

                if tc_id not in existing_keys and final_name not in existing_keys:
                    existing_tcs.append({
                        "key": final_name, 
                        "name": final_name,
                        "tc_number": tc_id,
                        "summary": "", 
                        "status": "pending"
                    })

            db.save_te(te_key, existing_tcs)

        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/execution-state/<te_key>', methods=['GET', 'POST'])
def api_execution_state(te_key):
    try:
        if request.method == 'GET':
            te_data = db.get_te(te_key)
            return jsonify({"test_cases": te_data.get("test_cases", [])})

        data = request.json or {}
        test_cases = data.get("test_cases", [])
        db.save_te(te_key, test_cases)
        return jsonify({"status": "saved"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/delete-tc', methods=['POST'])
def api_delete_tc():
    try:
        data = request.json or {}
        te_key = data.get('te_key')
        tc_key = data.get('tc_key')
        if not te_key or not tc_key:
            return jsonify({"error": "Missing te_key or tc_key"}), 400

        te_data = db.get_te(te_key)
        tcs = te_data.get('test_cases', [])
        updated_tcs = [tc for tc in tcs if tc.get('key') != tc_key]
        db.save_te(te_key, updated_tcs)

        # Cleanup physical TC folder if it exists
        tc_dir = os.path.join(os.path.abspath(config.EXECUTIONS_DIR), te_key, tc_key)
        if os.path.exists(tc_dir):
            import shutil
            shutil.rmtree(tc_dir, ignore_errors=True)

        return jsonify({"status": "deleted", "tc_key": tc_key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
