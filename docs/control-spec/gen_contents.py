#!/usr/bin/env python3
from pathlib import Path
import json
ROOT = Path(__file__).resolve().parent
files = {}
for p in sorted((ROOT / "md").rglob("*.md")):
    rel = p.relative_to(ROOT).as_posix()
    files[rel] = p.read_text(encoding="utf-8")
text = "window.MD_FILES = " + json.dumps(files, ensure_ascii=False) + ";" + chr(10)
(ROOT / "contents.js").write_text(text, encoding="utf-8")
print("wrote contents.js", len(files), "markdown files")
