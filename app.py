import os
import json
import time
import threading
from flask import Flask, request, jsonify, send_file, send_from_directory, render_template
from pathlib import Path
from datetime import datetime

import config
import jira_actions
import defect_draft
import poc_doc
import db
import secret_store

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB upload limit

import re
def get_tc_dir(te_key, tc_key):
    """Returns a safe, truncated path for a TC folder to avoid Windows MAX_PATH errors."""
    safe_tc = re.sub(r'[\\/*?:"<>|]', "_", tc_key)
    safe_tc = safe_tc[:100].strip()
    return os.path.join(os.path.abspath(config.EXECUTIONS_DIR), te_key, safe_tc)

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
        all_settings.pop('jira_pat', None)
        all_settings['jira_token_set'] = bool(secret_store.get_secret('jira_pat'))
        all_settings.pop('gemini_model', None)
        return jsonify(all_settings)

    data = request.json or {}
    # Secrets go to the OS credential store, never to settings_overrides.json
    for secret_key in secret_store.SECRETS:
        if secret_key in data:
            value = data.pop(secret_key)
            if not secret_store.set_secret(secret_key, value):
                return jsonify({"error": f"Cannot store {secret_key}: install 'keyring' or set it in .env"}), 400
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

    save_dir = os.path.join(get_tc_dir(te_key, tc_key), category)
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
            import urllib.parse
            saved_files.append({
                "name": filename,
                "path": os.path.abspath(filepath),
                "url": f"/api/screenshot-file/{urllib.parse.quote(te_key)}/{urllib.parse.quote(tc_key)}/{category}/{urllib.parse.quote(filename)}",
                "category": category
            })

    return jsonify({"files": saved_files})

@app.route('/api/screenshots/<te_key>/<path:tc_key>', methods=['GET'])
def api_get_screenshots(te_key, tc_key):
    tc_dir = get_tc_dir(te_key, tc_key)
    if not os.path.realpath(tc_dir).startswith(os.path.realpath(config.EXECUTIONS_DIR)):
        return jsonify({"error": "Invalid path"}), 400
    result = {"expected": [], "actual": []}

    for cat in ["expected", "actual"]:
        cat_dir = os.path.join(tc_dir, cat)
        if os.path.exists(cat_dir):
            filenames = [f for f in os.listdir(cat_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))]
            import urllib.parse
            for f in sorted(filenames):
                tc_key_encoded = urllib.parse.quote(tc_key, safe='')
                te_key_encoded = urllib.parse.quote(te_key, safe='')
                f_encoded = urllib.parse.quote(f, safe='')
                result[cat].append({
                    "name": f,
                    "url": f"/api/screenshot-file/{te_key_encoded}/{tc_key_encoded}/{cat}/{f_encoded}",
                    "path": os.path.abspath(os.path.join(cat_dir, f)),
                    "category": cat
                })

    return jsonify(result)

@app.route('/api/screenshot-file/<te_key>/<path:tc_key>/<category>/<filename>', methods=['GET'])
def api_screenshot_file(te_key, tc_key, category, filename):
    save_dir = os.path.join(get_tc_dir(te_key, tc_key), category)
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

        save_dir = os.path.join(get_tc_dir(te_key, tc_key), category)
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

        expected_shots = []
        actual_shots = []
        
        # Check AI screenshot sharing setting (UI option remains, but functionality is disabled)
        # if not config.get('share_screenshots_with_ai', True):
        #     expected_shots = []
        #     actual_shots = []

        # AI Title
        title_res = defect_draft.generate_defect_title(
            notes=notes,
            tc_key=tc_key,
            te_key=te_key,
            expected_shots=expected_shots,
            actual_shots=actual_shots,
        )

        if isinstance(title_res, dict) and "error" in title_res:
            ai_error = title_res["error"]
            print(f"[!] AI Title error: {ai_error}")
            return jsonify({"error": ai_error}), 500
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
            return jsonify({"error": ai_error}), 500

        return jsonify({
            "title": title,
            "scenario": sections.get("scenario") or f"Executing scenario for {tc_key}",
            "steps": sections.get("steps") or "1. Open app\n2. Perform steps",
            "expected": sections.get("expected") or "Title and layout should match Figma designs",
            "actual": sections.get("actual") or notes,
            "raw": sections.get("raw", "")
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
        primary_lang = te_data.get('language', 'English')
        
        def populate_shots(target_te, tcs, lang_label):
            populated = []
            for tc in tcs:
                # Create a copy so we don't mutate DB state in memory
                tc_copy = dict(tc)
                tc_copy['name'] = f"[{lang_label[:2].upper()}] {tc_copy.get('name', '')}"
                
                tc_key = tc.get('key', '') or tc.get('name', '')
                tc_dir = get_tc_dir(target_te, tc_key)
                tc_copy['expected_shots'] = []
                tc_copy['actual_shots'] = []
                for cat in ['expected', 'actual']:
                    cat_dir = os.path.join(tc_dir, cat)
                    if os.path.exists(cat_dir):
                        for f in sorted(os.listdir(cat_dir)):
                            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp')):
                                tc_copy[f'{cat}_shots'].append(os.path.abspath(os.path.join(cat_dir, f)))
                populated.append(tc_copy)
            return populated

        combined_tcs = populate_shots(te_key, test_cases, primary_lang)
        
        linked_te = te_data.get('linked_te')
        if te_data.get('linked_te_enabled') and linked_te:
            linked_te_data = db.get_te(linked_te)
            linked_test_cases = linked_te_data.get('test_cases', [])
            linked_lang = linked_te_data.get('language', 'Arabic')
            
            linked_populated = populate_shots(linked_te, linked_test_cases, linked_lang)
            
            # Interleave them by tc_number so EN/AR for the same TC are grouped together
            # First, group by tc_number or key
            groups = {}
            for tc in combined_tcs:
                match_key = tc.get('tc_number') or tc.get('key') or tc.get('name')
                groups[match_key] = [tc]
                
            for ltc in linked_populated:
                match_key = ltc.get('tc_number') or ltc.get('key') or ltc.get('name')
                # Try finding matching group by original key without language tag
                original_key = ltc.get('key', '')
                
                found_group_key = match_key
                if original_key and original_key not in groups:
                    # check if there is a primary TC with matching original_key
                    for k, v in groups.items():
                        if any(ptc.get('key') == original_key for ptc in v):
                            found_group_key = k
                            break
                
                if found_group_key in groups:
                    groups[found_group_key].append(ltc)
                else:
                    groups[found_group_key] = [ltc]
            
            combined_tcs = []
            for k in groups:
                combined_tcs.extend(groups[k])

        doc_path = poc_doc.rebuild_pot(te_key, combined_tcs)
        return jsonify({"status": "success", "doc_path": doc_path, "tc_count": len(combined_tcs)})
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
            return jsonify({
                "test_cases": te_data.get("test_cases", []),
                "environment": te_data.get("environment", "Unknown"),
                "language": te_data.get("language", "English"),
                "linked_te": te_data.get("linked_te", ""),
                "linked_te_enabled": te_data.get("linked_te_enabled", False)
            })

        data = request.json or {}
        test_cases = data.get("test_cases", [])
        db.save_te(te_key, test_cases)
        return jsonify({"status": "saved"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/update-te-env', methods=['POST'])
def api_update_te_env():
    try:
        data = request.json or {}
        te_key = data.get("te_key")
        env = data.get("environment")
        if not te_key or not env:
            return jsonify({"error": "Missing te_key or environment"}), 400
        
        te_data = db.get_te(te_key)
        db.save_te(te_key, te_data.get("test_cases", []), environment=env)
        return jsonify({"status": "success", "environment": env})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/update-te-lang', methods=['POST'])
def api_update_te_lang():
    try:
        data = request.json or {}
        te_key = data.get("te_key")
        lang = data.get("language")
        if not te_key or not lang:
            return jsonify({"error": "Missing te_key or language"}), 400
        
        te_data = db.get_te(te_key)
        db.save_te(te_key, te_data.get("test_cases", []), language=lang)
        return jsonify({"status": "success", "language": lang})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/update-te-link', methods=['POST'])
def api_update_te_link():
    try:
        data = request.json or {}
        te_key = data.get("te_key")
        linked_te = data.get("linked_te")
        linked_te_enabled = data.get("linked_te_enabled")
        if not te_key:
            return jsonify({"error": "Missing te_key"}), 400
        
        te_data = db.get_te(te_key)
        db.save_te(te_key, te_data.get("test_cases", []), linked_te=linked_te, linked_te_enabled=linked_te_enabled)
        return jsonify({"status": "success", "linked_te": linked_te, "linked_te_enabled": linked_te_enabled})
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
        tc_dir = get_tc_dir(te_key, tc_key)
        if os.path.exists(tc_dir):
            import shutil
            shutil.rmtree(tc_dir, ignore_errors=True)

        return jsonify({"status": "deleted", "tc_key": tc_key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- AI Test Guidance ---
@app.route('/api/upload-user-story', methods=['POST'])
def api_upload_user_story():
    """Disabled user story functionality."""
    return jsonify({"status": "success", "user_story": {"filename": "Functionality Disabled", "row_count": 0, "content": ""}})

@app.route('/api/user-story/<te_key>', methods=['GET'])
def api_get_user_story(te_key):
    """Disabled user story functionality."""
    return jsonify({})

@app.route('/api/generate-guide', methods=['POST'])
def api_generate_guide():
    """Disabled user story functionality."""
    guide = {
        "what_to_test": "User story functionality has been disabled.",
        "steps": "1. N/A",
        "look_for": "- N/A",
        "story_excerpt": "Disabled.",
        "generated_at": datetime.now().isoformat()
    }
    return jsonify({"status": "success", "guide": guide})

# --- Draft Defect Queue ---
@app.route('/api/save-draft', methods=['POST'])
def api_save_draft():
    """Save a defect as a draft — AI work done, but not submitted to Jira yet."""
    try:
        data = request.json or {}
        te_key = data.get('te_key')
        tc_key = data.get('tc_key')
        if not te_key or not tc_key:
            return jsonify({"error": "Missing te_key or tc_key"}), 400

        draft = {
            'title': data.get('defect_title', ''),
            'scenario': data.get('scenario', ''),
            'steps': data.get('steps', ''),
            'expected': data.get('expected', ''),
            'actual': data.get('actual', ''),
            'test_data': data.get('test_data', ''),
            'qa_analysis': data.get('qa_analysis', ''),
            'severity': data.get('severity', '1-Low'),
            'blocked_tcs': data.get('blocked_tcs', ''),
            'assignee': data.get('assignee', ''),
            'expected_shots': data.get('expected_shots', []),
            'actual_shots': data.get('actual_shots', []),
            'drafted_at': data.get('drafted_at', ''),
        }

        te_data = db.get_te(te_key)
        tcs = te_data.get('test_cases', [])
        for tc in tcs:
            if tc.get('key') == tc_key:
                tc['draft_defect'] = draft
                tc['status'] = 'fail'
                break
        db.save_te(te_key, tcs)
        return jsonify({"status": "saved", "tc_key": tc_key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/drafts/<te_key>', methods=['GET'])
def api_get_drafts(te_key):
    """List all draft defects for a TE."""
    try:
        te_data = db.get_te(te_key)
        tcs = te_data.get('test_cases', [])
        drafts = []
        for tc in tcs:
            if tc.get('draft_defect') and not tc.get('defect_key'):
                drafts.append({
                    'tc_key': tc.get('key', ''),
                    'tc_name': tc.get('name', tc.get('key', '')),
                    'tc_number': tc.get('tc_number', ''),
                    'draft': tc['draft_defect'],
                    'status': tc.get('status', 'fail'),
                })
        return jsonify({"drafts": drafts, "count": len(drafts)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/delete-draft', methods=['POST'])
def api_delete_draft():
    """Discard a draft defect."""
    try:
        data = request.json or {}
        te_key = data.get('te_key')
        tc_key = data.get('tc_key')
        if not te_key or not tc_key:
            return jsonify({"error": "Missing te_key or tc_key"}), 400

        te_data = db.get_te(te_key)
        tcs = te_data.get('test_cases', [])
        for tc in tcs:
            if tc.get('key') == tc_key:
                tc.pop('draft_defect', None)
                break
        db.save_te(te_key, tcs)
        return jsonify({"status": "deleted", "tc_key": tc_key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/submit-draft', methods=['POST'])
def api_submit_draft():
    """Submit a single draft defect to Jira."""
    try:
        data = request.json or {}
        te_key = data.get('te_key')
        tc_key = data.get('tc_key')
        if not te_key or not tc_key:
            return jsonify({"error": "Missing te_key or tc_key"}), 400

        te_data = db.get_te(te_key)
        tcs = te_data.get('test_cases', [])
        tc = None
        for t in tcs:
            if t.get('key') == tc_key:
                tc = t
                break
        if not tc or not tc.get('draft_defect'):
            return jsonify({"error": "No draft found for this TC"}), 404

        draft = tc['draft_defect']
        description = defect_draft.build_full_defect_description(
            scenario=draft.get('scenario', ''),
            steps=draft.get('steps', ''),
            expected=draft.get('expected', ''),
            actual=draft.get('actual', ''),
            test_data=draft.get('test_data', ''),
            qa_analysis=draft.get('qa_analysis', ''),
        )
        all_shots = draft.get('expected_shots', []) + draft.get('actual_shots', [])

        issue_key = jira_actions.create_defect(
            summary=draft.get('title', ''),
            description=description,
            screenshot_paths=all_shots,
            assignee=draft.get('assignee'),
            priority=draft.get('severity', '1-Low'),
            data=draft,
        )

        # Update TC in db
        tc['defect_key'] = issue_key
        tc['submitted_defect'] = draft
        tc.pop('draft_defect', None)
        tc['status'] = 'fail'
        db.save_te(te_key, tcs)

        return jsonify({"status": "submitted", "issue_key": issue_key, "tc_key": tc_key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# Background batch submission state
_batch_state = {
    'running': False,
    'te_key': '',
    'total': 0,
    'completed': 0,
    'current_tc': '',
    'results': [],
    'errors': [],
}

@app.route('/api/submit-all-drafts', methods=['POST'])
def api_submit_all_drafts():
    """Batch submit all drafts for a TE with randomized delays between submissions."""
    import random

    if _batch_state['running']:
        return jsonify({"error": "A batch submission is already in progress"}), 409

    data = request.json or {}
    te_key = data.get('te_key')
    min_delay = data.get('min_delay_seconds', 120)
    max_delay = data.get('max_delay_seconds', 300)
    if not te_key:
        return jsonify({"error": "Missing te_key"}), 400

    te_data = db.get_te(te_key)
    tcs = te_data.get('test_cases', [])
    draft_tcs = [tc for tc in tcs if tc.get('draft_defect') and not tc.get('defect_key')]
    if not draft_tcs:
        return jsonify({"error": "No drafts to submit"}), 400

    _batch_state.update({
        'running': True,
        'te_key': te_key,
        'total': len(draft_tcs),
        'completed': 0,
        'current_tc': '',
        'results': [],
        'errors': [],
    })

    def batch_worker():
        try:
            for i, tc in enumerate(draft_tcs):
                tc_key = tc.get('key', '')
                _batch_state['current_tc'] = tc_key
                try:
                    draft = tc['draft_defect']
                    description = defect_draft.build_full_defect_description(
                        scenario=draft.get('scenario', ''),
                        steps=draft.get('steps', ''),
                        expected=draft.get('expected', ''),
                        actual=draft.get('actual', ''),
                        test_data=draft.get('test_data', ''),
                        qa_analysis=draft.get('qa_analysis', ''),
                    )
                    all_shots = draft.get('expected_shots', []) + draft.get('actual_shots', [])
                    issue_key = jira_actions.create_defect(
                        summary=draft.get('title', ''),
                        description=description,
                        screenshot_paths=all_shots,
                        assignee=draft.get('assignee'),
                        priority=draft.get('severity', '1-Low'),
                        data=draft,
                    )
                    # Update TC in the live list
                    tc['defect_key'] = issue_key
                    tc['submitted_defect'] = draft
                    tc.pop('draft_defect', None)
                    tc['status'] = 'fail'
                    _batch_state['results'].append({'tc_key': tc_key, 'issue_key': issue_key})
                except Exception as e:
                    _batch_state['errors'].append({'tc_key': tc_key, 'error': str(e)})

                _batch_state['completed'] = i + 1

                # Save progress after each submission
                try:
                    db.save_te(te_key, tcs)
                except Exception:
                    pass

                # Wait with randomized delay (skip after last one)
                if i < len(draft_tcs) - 1:
                    delay = random.uniform(min_delay, max_delay)
                    time.sleep(delay)
        finally:
            _batch_state['running'] = False
            _batch_state['current_tc'] = ''

    thread = threading.Thread(target=batch_worker, daemon=True)
    thread.start()
    return jsonify({
        "status": "started",
        "total": len(draft_tcs),
        "min_delay": min_delay,
        "max_delay": max_delay,
    })

@app.route('/api/batch-status', methods=['GET'])
def api_batch_status():
    """Check progress of batch draft submission."""
    return jsonify(_batch_state)

@app.route('/api/cancel-batch', methods=['POST'])
def api_cancel_batch():
    """Cancel running batch submission (stops after current defect finishes)."""
    if _batch_state['running']:
        _batch_state['running'] = False
        return jsonify({"status": "cancelling"})
    return jsonify({"status": "not_running"})

# --- Settings History (Dropdown Presets) ---
@app.route('/api/settings-history', methods=['GET', 'POST'])
def api_settings_history():
    """GET: Return saved option history for settings fields.
    POST: Add a new option to the history for a specific field."""
    import json as json_mod
    history_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'settings_history.json')

    if request.method == 'GET':
        try:
            if os.path.exists(history_file):
                with open(history_file, 'r', encoding='utf-8') as f:
                    return jsonify(json_mod.load(f))
            return jsonify({})
        except Exception:
            return jsonify({})

    # POST — save the current settings values as history options
    try:
        data = request.json or {}
        history = {}
        if os.path.exists(history_file):
            try:
                with open(history_file, 'r', encoding='utf-8') as f:
                    history = json_mod.load(f)
            except Exception:
                history = {}

        for field_name, value in data.items():
            if not value or not str(value).strip():
                continue
            val_str = str(value).strip()
            if field_name not in history:
                history[field_name] = []
            if val_str not in history[field_name]:
                history[field_name].append(val_str)

        with open(history_file, 'w', encoding='utf-8') as f:
            json_mod.dump(history, f, indent=2)

        return jsonify({"status": "saved"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    # The Werkzeug debugger allows running code from the browser; only enable it explicitly.
    debug = os.getenv("FLASK_DEBUG", "").lower() in ("1", "true")
    app.run(host='127.0.0.1', port=5000, debug=debug)
