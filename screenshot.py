"""
Grabs whatever image is currently on the Windows clipboard — i.e. exactly
what you have after Snipping Tool -> mark up -> Ctrl+C.

Saves captured screenshots inside:
    executions/<TE_KEY>/<TC_KEY>/shot_<timestamp>.png
"""
import io
import os
import time

from PIL import ImageGrab

import config


def grab_clipboard_image(save_dir: str):
    """
    Returns the path to a saved PNG of the current clipboard image, or None
    if the clipboard doesn't contain an image.
    """
    os.makedirs(save_dir, exist_ok=True)
    img = ImageGrab.grabclipboard()

    if img is None:
        return None

    # grabclipboard() can return a list of file paths (if files were copied)
    # instead of an image — handle both cases.
    if isinstance(img, list):
        if img and os.path.isfile(img[0]):
            return img[0]
        return None

    filename = os.path.join(save_dir, f"shot_{int(time.time() * 1000)}.png")
    img.save(filename, "PNG")
    return filename


def collect_screenshots(te_key: str = None, tc_key: str = None) -> list[str]:
    """
    Interactive loop: prompts you to snip + copy, press Enter to capture,
    or type 'done' when you've attached everything for this TC.
    Saves files to executions/<TE_KEY>/<TC_KEY>/ folder.
    """
    if not te_key:
        te_key = config.DEFAULT_TE_KEY
    if not tc_key:
        tc_key = "GENERAL"

    save_dir = os.path.join(config.EXECUTIONS_DIR, te_key, tc_key)

    shots = []
    while True:
        cmd = input(
            f"  [{len(shots)} captured] Snip + Ctrl+C, then press Enter to grab it "
            f"(or type 'done'): "
        ).strip().lower()
        if cmd == "done":
            break
        path = grab_clipboard_image(save_dir)
        if path:
            shots.append(path)
            print(f"  -> captured screenshot: {path}")
        else:
            print("  -> nothing image-shaped on the clipboard, copy an image and try again")
    return shots

