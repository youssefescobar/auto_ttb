"""
Reads and writes secrets (Jira token, Gemini key) via the OS credential store
(Windows Credential Manager / macOS Keychain) when the `keyring` package is
installed, falling back to environment variables / .env.

Keeping secrets here means they are never written to settings_overrides.json.
"""
import os

SERVICE = "auto_ttb"

# Secret name -> environment variable fallback
SECRETS = {
    "jira_pat": "JIRA_PAT",
    "gemini_api_key": "GEMINI_API_KEY",
}

try:
    import keyring
except ImportError:  # keyring is optional
    keyring = None


def get_secret(name: str) -> str:
    if keyring is not None:
        try:
            val = keyring.get_password(SERVICE, name)
            if val:
                return val
        except Exception:
            pass
    return os.getenv(SECRETS.get(name, name.upper()), "")


def set_secret(name: str, value: str) -> bool:
    """Stores a secret in the OS credential store. Returns False if unavailable."""
    if keyring is None:
        return False
    try:
        if value:
            keyring.set_password(SERVICE, name, value)
        else:
            try:
                keyring.delete_password(SERVICE, name)
            except Exception:
                pass
        return True
    except Exception as e:
        print(f"[!] Could not save '{name}' to the OS credential store: {e}")
        return False


def has_keyring() -> bool:
    return keyring is not None
