#!/bin/sh
set -eu

PACKAGE_NAME="mullgate"
PACKAGE_SPEC="$PACKAGE_NAME"

if [ -n "${MULLGATE_VERSION:-}" ]; then
  PACKAGE_SPEC="${PACKAGE_NAME}@${MULLGATE_VERSION}"
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "mullgate installer: Node.js 22+ is required, but \`node\` was not found." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "mullgate installer: npm is required, but \`npm\` was not found." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf '%s\n' "mullgate installer: Node.js 22+ is required. Found $(node -v)." >&2
  exit 1
fi

printf '%s\n' "Installing ${PACKAGE_SPEC}..."

if npm install --global "$PACKAGE_SPEC"; then
  printf '\n%s\n' "mullgate installed successfully."
  printf '%s\n' "Run: mullgate --help"
  exit 0
fi

USER_PREFIX="${MULLGATE_NPM_PREFIX:-$HOME/.local}"
BIN_DIR="${USER_PREFIX}/bin"

printf '\n%s\n' "Global install failed, retrying with a user prefix at ${USER_PREFIX}."
if ! npm install --global --prefix "$USER_PREFIX" "$PACKAGE_SPEC"; then
  printf '\n%s\n' "mullgate installer: npm installation failed."
  printf '%s\n' "If the package has not been published yet, install from the GitHub release .tgz asset or from a source checkout."
  exit 1
fi

printf '\n%s\n' "mullgate installed successfully."
printf '%s\n' "Binary path: ${BIN_DIR}/mullgate"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    printf '%s\n' "Run: mullgate --help"
    ;;
  *)
    printf '%s\n' "Add ${BIN_DIR} to PATH, then run: mullgate --help"
    ;;
esac
