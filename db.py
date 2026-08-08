"""
Simple JSON Database manager for Auto TTB.
Stores all Test Executions (TEs) and Test Cases (TCs) in a central db.json file.
Supports direct manual reading/writing, automatic saving, and sync.
"""
import os
import json
import threading
import shutil
import time
from datetime import datetime

import config

DB_FILE = os.path.abspath("db.json")
_db_lock = threading.Lock()

def _default_db_structure():
    return {
        "meta": {
            "version": "2.0",
            "description": "Auto TTB Test Executions & Test Cases Database",
            "last_updated": datetime.now().isoformat()
        },
        "test_executions": {}
    }

def _read_db_unlocked() -> dict:
    if not os.path.exists(DB_FILE):
        data = _default_db_structure()
        _write_db_unlocked(data)
        return data

    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[!] Error reading db.json: {e}")
        if os.path.exists(DB_FILE):
            backup_file = f"{DB_FILE}.corrupt.{int(time.time())}"
            shutil.copy2(DB_FILE, backup_file)
        data = _default_db_structure()
        _write_db_unlocked(data)
        return data

def read_db() -> dict:
    """Reads and returns the complete db.json content."""
    with _db_lock:
        return _read_db_unlocked()

def write_db(data: dict):
    """Writes data dictionary directly to db.json."""
    with _db_lock:
        _write_db_unlocked(data)

def _write_db_unlocked(data: dict):
    if "meta" not in data:
        data["meta"] = {}
    data["meta"]["last_updated"] = datetime.now().isoformat()
    try:
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[!] Error writing db.json: {e}")

def get_te(te_key: str) -> dict:
    """Returns data for a specific TE key."""
    sync_from_executions_dir()
    db = read_db()
    tes = db.get("test_executions", {})
    return tes.get(te_key, {"te_key": te_key, "test_cases": []})

def save_te(te_key: str, test_cases: list):
    """Saves or updates a Test Execution and its Test Cases in db.json."""
    with _db_lock:
        db = _read_db_unlocked()
        if "test_executions" not in db:
            db["test_executions"] = {}
        
        tes = db["test_executions"]
        existing = tes.get(te_key, {})
        
        tes[te_key] = {
            "te_key": te_key,
            "created_at": existing.get("created_at", datetime.now().isoformat()),
            "updated_at": datetime.now().isoformat(),
            "tc_count": len(test_cases),
            "test_cases": test_cases
        }
        
        _write_db_unlocked(db)
        saved_te = tes[te_key]

    # Also sync to individual execution state.json for backward compatibility
    try:
        te_dir = os.path.join(os.path.abspath(config.EXECUTIONS_DIR), te_key)
        os.makedirs(te_dir, exist_ok=True)
        state_file = os.path.join(te_dir, "state.json")
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump({"test_cases": test_cases}, f, indent=2)
    except Exception as e:
        print(f"[!] Warning syncing state file: {e}")

    return saved_te

def get_all_tes() -> list:
    """Returns a summary list of all TEs stored in db.json."""
    sync_from_executions_dir()
    db = read_db()
    tes = db.get("test_executions", {})
    result = []
    for te_key, data in tes.items():
        tcs = data.get("test_cases", [])
        result.append({
            "te_key": te_key,
            "created_at": data.get("created_at"),
            "updated_at": data.get("updated_at"),
            "tc_count": len(tcs),
            "pass_count": sum(1 for tc in tcs if tc.get("status") == "pass"),
            "fail_count": sum(1 for tc in tcs if tc.get("status") == "fail"),
            "pending_count": sum(1 for tc in tcs if tc.get("status") == "pending")
        })
    return sorted(result, key=lambda x: x.get("updated_at", ""), reverse=True)

def delete_te(te_key: str):
    """Deletes a TE entry from db.json."""
    with _db_lock:
        db = _read_db_unlocked()
        if "test_executions" in db and te_key in db["test_executions"]:
            del db["test_executions"][te_key]
            _write_db_unlocked(db)
            return True
    return False

def sync_from_executions_dir():
    """Scans executions/ folder and populates db.json if needed."""
    with _db_lock:
        db = _read_db_unlocked()
        tes = db.get("test_executions", {})
        changed = False

        exec_dir = os.path.abspath(config.EXECUTIONS_DIR)
        if os.path.exists(exec_dir):
            for item in os.listdir(exec_dir):
                item_path = os.path.join(exec_dir, item)
                if os.path.isdir(item_path):
                    state_file = os.path.join(item_path, "state.json")
                    if os.path.exists(state_file) and item not in tes:
                        try:
                            with open(state_file, "r", encoding="utf-8") as f:
                                st_data = json.load(f)
                                tcs = st_data.get("test_cases", [])
                                if "test_executions" not in db:
                                    db["test_executions"] = {}
                                db["test_executions"][item] = {
                                    "te_key": item,
                                    "created_at": datetime.now().isoformat(),
                                    "updated_at": datetime.now().isoformat(),
                                    "tc_count": len(tcs),
                                    "test_cases": tcs
                                }
                                changed = True
                        except Exception as e:
                            print(f"[!] Error syncing execution {item}: {e}")
        if changed:
            _write_db_unlocked(db)

# Auto sync on import
sync_from_executions_dir()
