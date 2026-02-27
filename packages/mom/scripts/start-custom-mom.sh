#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	echo "Usage: $(basename "$0") [workspace-dir]"
	echo
	echo "Optional env vars:"
	echo "  MOM_ENV_FILE   Path to env file (default: ~/.config/mom/slack.env)"
	echo "  MOM_SANDBOX    Sandbox mode (default: vibesilo)"
	echo "  MOM_RPC_SOCKET RPC socket path (default: <workspace>/.mom.sock)"
	exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

WORKSPACE_DIR="${1:-$HOME/Projects/mom-workspace}"
MOM_ENV_FILE="${MOM_ENV_FILE:-$HOME/.config/mom/slack.env}"
MOM_SANDBOX="${MOM_SANDBOX:-vibesilo}"
MOM_RPC_SOCKET="${MOM_RPC_SOCKET:-$WORKSPACE_DIR/.mom.sock}"

if [[ -f "$MOM_ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$MOM_ENV_FILE"
	set +a
else
	echo "Warning: env file not found: $MOM_ENV_FILE" >&2
fi

if [[ ! -f "$REPO_ROOT/packages/mom/dist/main.js" ]]; then
	echo "Error: missing build output: $REPO_ROOT/packages/mom/dist/main.js" >&2
	echo "Run: cd $REPO_ROOT/packages/mom && npm run build" >&2
	exit 1
fi

cd "$REPO_ROOT"
exec node packages/mom/dist/main.js --sandbox="$MOM_SANDBOX" --rpc-socket "$MOM_RPC_SOCKET" "$WORKSPACE_DIR"
