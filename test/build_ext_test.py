"""Build the test copy of the extension used by the Playwright suite.

`src/` is the shipped tree; the harness needs `TEST_HOOK = true` in
main-world.js (it exposes pure helpers on window.__umingTest). Copying keeps
the shipped file clean.

Run before `test/test_extension.py`.
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT
DST = ROOT / "test" / ".build"
NEEDLE = b"const TEST_HOOK = false; // UTK_TEST_HOOK"
PATCHED = b"const TEST_HOOK = true; // UTK_TEST_HOOK"
SKIP = ("test", "docs", ".github", "*.md", "LICENSE", ".gitignore",
        ".git", ".impeccable", "dist", "node_modules")


def main():
    if not (SRC / "manifest.json").is_file():
        print("FATAL: manifest.json not found")
        return 2
    if DST.exists():
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST, ignore=shutil.ignore_patterns(*SKIP))
    target = DST / "src" / "main-world.js"
    raw = target.read_bytes()
    if NEEDLE not in raw:
        print("FATAL: TEST_HOOK marker missing in main-world.js")
        return 2
    target.write_bytes(raw.replace(NEEDLE, PATCHED))
    print("built", DST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
