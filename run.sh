#!/bin/sh
# Hollowreach launcher for Linux and macOS.
#
# Starts the tiny local Python server (ES modules can't load over file://) and
# your browser opens automatically. Double-click it in a file manager that runs
# scripts in a terminal, or from a shell:  ./run.sh
#
# Requires Python 3 (preinstalled on most Linux distros and on macOS via the
# developer tools). No packages are installed; the server is stdlib-only.

cd "$(dirname "$0")" || exit 1

for PY in python3 python; do
    if command -v "$PY" >/dev/null 2>&1; then
        if "$PY" -c 'import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)' 2>/dev/null; then
            exec "$PY" server.py
        fi
    fi
done

echo "============================================================"
echo " Python 3 was not found on your system."
echo "  Linux: install it with your package manager,"
echo "         e.g.  sudo apt install python3"
echo "  macOS: run  xcode-select --install  or get it from"
echo "         https://www.python.org/downloads/"
echo " Then run this script again."
echo "============================================================"
exit 1
