#!/usr/bin/env bash
#
# Creates the classifier virtualenv and verifies it can actually classify.
#
# Run once after cloning:  pnpm setup:python
#
# The app finds this venv by convention (<repo>/venv-classifier) or via the
# LUMA_PYTHON environment variable, so there is nothing to wire up afterwards.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PATH="$REPO_ROOT/venv-classifier"
REQUIREMENTS="$REPO_ROOT/sidecar/classifier/requirements.txt"
WORKER="$REPO_ROOT/sidecar/classifier/classify_worker.py"

# 3.12 first: onnxruntime and opencv ship wheels for it on every platform we
# care about. 3.14 is deliberately last — at the time of writing several of
# these packages have no 3.14 wheel and would try to build from source.
PYTHON_BIN=""
for candidate in python3.12 python3.13 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    version="$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
    case "$version" in
      3.11|3.12|3.13) PYTHON_BIN="$candidate"; break ;;
    esac
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo "error: need Python 3.11, 3.12 or 3.13 on PATH (found none)." >&2
  echo "       macOS:  brew install python@3.12" >&2
  echo "       Debian: sudo apt install python3.12 python3.12-venv" >&2
  exit 1
fi

echo "==> Using $PYTHON_BIN ($("$PYTHON_BIN" -V 2>&1))"

# Recreate the venv if it was built with a different interpreter version —
# a mismatched venv fails at import time with an unhelpful error.
if [ -d "$VENV_PATH" ]; then
  existing="$("$VENV_PATH/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo none)"
  wanted="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  if [ "$existing" != "$wanted" ]; then
    echo "==> Existing venv is Python $existing, want $wanted — recreating"
    rm -rf "$VENV_PATH"
  fi
fi

if [ ! -d "$VENV_PATH" ]; then
  echo "==> Creating venv at $VENV_PATH"
  "$PYTHON_BIN" -m venv "$VENV_PATH"
fi

echo "==> Installing pinned requirements"
"$VENV_PATH/bin/python" -m pip install --upgrade pip --quiet
"$VENV_PATH/bin/python" -m pip install -r "$REQUIREMENTS" --quiet

# ffmpeg is not a Python dependency, but nothing about video works without it,
# so failing here is far friendlier than failing mid-scan on the first video.
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo ""
  echo "warning: ffmpeg/ffprobe not found on PATH — videos cannot be scanned." >&2
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "         brew install ffmpeg" >&2
  else
    echo "         sudo apt install ffmpeg   (or your distro's equivalent)" >&2
  fi
  echo ""
fi

echo "==> Verifying the classifier can load its model"
if "$VENV_PATH/bin/python" "$WORKER" --check; then
  echo ""
  echo "Classifier ready:  $VENV_PATH/bin/python"
  echo "Point the app elsewhere with LUMA_PYTHON=/path/to/python if you need to."
else
  echo "error: the classifier failed its self-check (see the JSON above)." >&2
  exit 1
fi
