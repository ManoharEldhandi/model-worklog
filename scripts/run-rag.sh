#!/usr/bin/env bash
# Local, non-root bootstrap for the SDK logger + RAG demo (macOS / glibc Linux).
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash scripts/run-rag.sh [--check | --no-open | --cli | --no-chat | --setup-only]

  default       Install missing dependencies, build and open the browser RAG demo.
  --no-open     Start the browser demo and print its URL without opening a tab.
  --cli         Use the optional terminal evidence inspector.
  --no-chat     Run the sample and a cited answer, then stop the local services.
  --check       Run live integration, precision/recall and HNSW accuracy checks.
  --setup-only  Install dependencies and build without starting local services.

No API key or VS Code is needed. First use downloads CPU model weights.
Installs stay in .cache/rag-tools, .venv-rag and node_modules; no sudo or shell
profile changes. Requires Bash, tar, and curl or wget. Windows: use WSL2.
HELP
}

mode="${1:-demo}"
case "$mode" in demo|--check|--no-open|--cli|--no-chat|--setup-only) ;; -h|--help) usage; exit 0 ;; *) usage >&2; exit 2 ;; esac
if [ "$#" -gt 1 ]; then usage >&2; exit 2; fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
if [ ! -f "$root/.env" ]; then
  (umask 077; cp "$root/.env.example" "$root/.env")
fi
tools="$root/.cache/rag-tools"
mkdir -p "$tools" "$root/output/rag"
printf 'Repository: %s\n' "$root"
if command -v git >/dev/null 2>&1; then
  branch="$(git branch --show-current 2>/dev/null || true)"
  printf 'Branch: %s (%s)\n' "${branch:-detached validation checkout}" "$(git rev-parse --short HEAD 2>/dev/null || true)"
fi

download() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 600 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --timeout=60 --tries=3 "$1" -O "$2"
  else
    printf 'Install curl or wget, then rerun this command.\n' >&2; return 1
  fi
}
digest() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else printf 'Install shasum or sha256sum to verify downloads.\n' >&2; return 1; fi
}
usable_node() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 13 ? 0 : 1)' >/dev/null 2>&1
}
install_node() {
  local platform arch manifest archive expected actual staging
  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) printf 'Use macOS or glibc Linux (Windows: WSL2).\n' >&2; return 1 ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) printf 'Supported CPU architectures: arm64 and x64.\n' >&2; return 1 ;; esac
  printf 'Installing a private Node.js 22 runtime from nodejs.org...\n'
  manifest="$tools/SHASUMS256.txt"
  download 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' "$manifest"
  archive="$(awk -v suffix="-$platform-$arch\\.tar\\.gz$" '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-/ && $2 ~ suffix {print $2; exit}' "$manifest")"
  [ -n "$archive" ] || { printf 'No compatible Node.js archive was found.\n' >&2; return 1; }
  expected="$(awk -v file="$archive" '$2 == file {print $1}' "$manifest")"
  download "https://nodejs.org/dist/latest-v22.x/$archive" "$tools/node.tar.gz"
  actual="$(digest "$tools/node.tar.gz")"
  [ "$actual" = "$expected" ] || { printf 'Node.js checksum mismatch; refusing installation.\n' >&2; return 1; }
  staging="$(mktemp -d "$tools/node-install.XXXXXX")"
  tar -xzf "$tools/node.tar.gz" -C "$staging" --strip-components=1
  # Only replace this script's private runtime after a complete extraction.
  rm -rf "$tools/node"
  mv "$staging" "$tools/node"
  rm -f "$tools/node.tar.gz"
}
if ! usable_node; then
  export PATH="$tools/node/bin:$PATH"
  if ! usable_node; then install_node; fi
fi
usable_node || { printf 'Node.js >=22.13 and npm could not start on this system.\n' >&2; exit 1; }
printf 'Node: %s; npm: %s\n' "$(node --version)" "$(npm --version)"

# Keep Python/uv downloads local; never rewrite the user's shell profile.
export UV_PYTHON_INSTALL_DIR="$tools/python"
export UV_PYTHON_BIN_DIR="$tools/python-bin"
export UV_CACHE_DIR="$tools/uv-cache"
ensure_uv() {
  if command -v uv >/dev/null 2>&1; then rag_uv="$(command -v uv)"
  elif [ -x "$tools/uv/uv" ]; then rag_uv="$tools/uv/uv"
  else
    printf 'Installing private uv to provision Python 3.13...\n'
    download 'https://astral.sh/uv/install.sh' "$tools/install-uv.sh"
    UV_UNMANAGED_INSTALL="$tools/uv" sh "$tools/install-uv.sh"
    rag_uv="$tools/uv/uv"
  fi
}
python_313() { "$1" -c 'import sys; sys.exit(sys.version_info[:2] != (3, 13))' >/dev/null 2>&1; }
if [ -n "${MODEL_WORKLOG_RAG_PYTHON:-}" ]; then
  rag_python="$MODEL_WORKLOG_RAG_PYTHON"
  python_313 "$rag_python" || { printf 'MODEL_WORKLOG_RAG_PYTHON must name a working Python 3.13 executable.\n' >&2; exit 1; }
else
  rag_python="$root/.venv-rag/bin/python"
  if ! python_313 "$rag_python"; then
    if [ -e "$root/.venv-rag" ]; then mv "$root/.venv-rag" "$root/.venv-rag.backup-$(date +%s)"; fi
    if command -v python3.13 >/dev/null 2>&1 && python_313 "$(command -v python3.13)"; then
      if ! python3.13 -m venv "$root/.venv-rag"; then
        ensure_uv
        "$rag_uv" venv --python "$(command -v python3.13)" --seed --clear "$root/.venv-rag"
      fi
    else
      ensure_uv
      "$rag_uv" python install 3.13
      "$rag_uv" venv --python 3.13 --managed-python --seed "$root/.venv-rag"
    fi
  fi
fi
export MODEL_WORKLOG_RAG_PYTHON="$rag_python"
printf 'Python: %s\n' "$("$rag_python" --version)"
python_ready() {
  "$rag_python" - "$root/examples/rag/requirements.txt" <<'PY'
import importlib.metadata, pathlib, sys
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    name, version = line.split('==')
    if importlib.metadata.version(name) != version:
        sys.exit(1)
import chromadb, fastembed, flashrank, onnxruntime
PY
}
if ! python_ready 2>/dev/null; then
  printf 'Installing pinned Chroma, FastEmbed and FlashRank dependencies...\n'
  if "$rag_python" -m pip --version >/dev/null 2>&1; then
    "$rag_python" -m pip install --disable-pip-version-check -r examples/rag/requirements.txt
  else
    ensure_uv
    "$rag_uv" pip install --python "$rag_python" -r examples/rag/requirements.txt
  fi
fi
python_ready

signature="$(digest package-lock.json)-$(node --version)"
previous="$(cat "$tools/npm.ready" 2>/dev/null || true)"
if [ "$signature" != "$previous" ] || ! npm ls --all --include=dev >/dev/null 2>&1; then
  printf 'Installing locked JavaScript dependencies...\n'
  npm ci --no-audit --no-fund
  printf '%s' "$signature" > "$tools/npm.ready"
fi
if [ "$mode" != '--check' ]; then npm run build; fi
case "$mode" in
  --setup-only) printf 'SDK RAG dependencies and build are ready.\n' ;;
  --check) npx playwright install chromium; npm run test:rag:browser ;;
  *) exec node scripts/run-rag.mjs "$mode" ;;
esac
