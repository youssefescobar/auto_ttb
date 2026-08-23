import json
import os

DB_FILE = 'db.json'

def backfill():
    if not os.path.exists(DB_FILE):
        print("No db.json found.")
        return

    with open(DB_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    tes = data.get("test_executions", {})
    updated = False

    for te_key, te_data in tes.items():
        if "environment" not in te_data:
            # Try to infer from submitted defects
            inferred_env = "SIT" # Defaulting to SIT based on observation
            for tc in te_data.get("test_cases", []):
                if "submitted_defect" in tc:
                    title = tc["submitted_defect"].get("title", "")
                    if "_SIT_" in title:
                        inferred_env = "SIT"
                        break
                    elif "_PP_" in title:
                        inferred_env = "PP"
                        break
                    elif "_UAT_" in title:
                        inferred_env = "UAT"
                        break
                    elif "_Prod_" in title:
                        inferred_env = "Prod"
                        break
            
            te_data["environment"] = inferred_env
            print(f"Backfilled {te_key} with environment: {inferred_env}")
            updated = True
            
            # Update state.json as well
            state_file = os.path.join("executions", te_key, "state.json")
            if os.path.exists(state_file):
                with open(state_file, 'r', encoding='utf-8') as sf:
                    try:
                        sdata = json.load(sf)
                        sdata["environment"] = inferred_env
                        with open(state_file, 'w', encoding='utf-8') as sw:
                            json.dump(sdata, sw, indent=2)
                    except:
                        pass

    if updated:
        with open(DB_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print("db.json updated.")
    else:
        print("No updates needed.")

if __name__ == '__main__':
    backfill()
