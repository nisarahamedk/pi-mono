#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	echo "Usage: $(basename "$0") [workspace-dir]"
	echo
	echo "Optional env vars:"
	echo "  MOM_ENV_FILE     Path to env file (default: ~/.config/mom/slack.env)"
	echo "  MOM_SANDBOX      Sandbox mode (default: vibesilo)"
	echo "  MOM_RPC_SOCKET   RPC socket path (default: <workspace>/.mom.sock)"
	echo "  MOM_SKIP_CLEAN   Set to 1 to skip pre-launch cleanup"
	exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

WORKSPACE_DIR="${1:-$HOME/Projects/mom-workspace}"
MOM_ENV_FILE="${MOM_ENV_FILE:-$HOME/.config/mom/slack.env}"
MOM_SANDBOX="${MOM_SANDBOX:-vibesilo}"
MOM_RPC_SOCKET="${MOM_RPC_SOCKET:-$WORKSPACE_DIR/.mom.sock}"
MOM_SKIP_CLEAN="${MOM_SKIP_CLEAN:-0}"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"

if [[ -f "$MOM_ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$MOM_ENV_FILE"
	set +a
else
	echo "Warning: env file not found: $MOM_ENV_FILE" >&2
fi

if [[ ! -x "$TSX_BIN" ]]; then
	echo "Error: missing tsx executable: $TSX_BIN" >&2
	echo "Run: cd $REPO_ROOT && npm install" >&2
	exit 1
fi

cleanup_existing_runtime() {
	echo "Cleaning existing mom runtime for socket: $MOM_RPC_SOCKET"

	local pids browser_pids
	pids="$({ ps -Ao pid=,command= | grep -F -- "$MOM_RPC_SOCKET" | grep -F -- "packages/mom/" | grep -v grep; } || true)"
	if [[ -n "$pids" ]]; then
		echo "$pids" | awk '{print $1}' | xargs kill 2>/dev/null || true
		sleep 2
		pids="$({ ps -Ao pid=,command= | grep -F -- "$MOM_RPC_SOCKET" | grep -F -- "packages/mom/" | grep -v grep; } || true)"
		if [[ -n "$pids" ]]; then
			echo "$pids" | awk '{print $1}' | xargs kill -9 2>/dev/null || true
		fi
	fi

	browser_pids="$({ ps -Ao pid=,command= | grep -F -- "$HOME/.mom-upwork-cdp-profile" | grep -F -- "Google Chrome" | grep -v grep; } || true)"
	if [[ -n "$browser_pids" ]]; then
		echo "Killing dedicated host CDP browser using $HOME/.mom-upwork-cdp-profile"
		echo "$browser_pids" | awk '{print $1}' | xargs kill 2>/dev/null || true
		sleep 2
		browser_pids="$({ ps -Ao pid=,command= | grep -F -- "$HOME/.mom-upwork-cdp-profile" | grep -F -- "Google Chrome" | grep -v grep; } || true)"
		if [[ -n "$browser_pids" ]]; then
			echo "$browser_pids" | awk '{print $1}' | xargs kill -9 2>/dev/null || true
		fi
	fi

	rm -f "$MOM_RPC_SOCKET"

	if [[ "$MOM_SANDBOX" == "vibesilo" ]]; then
		echo "Removing existing vibesilo sandbox containers/networks"
		local containers networks
		containers="$(docker ps -aq --filter 'name=agent-sandbox' || true)"
		if [[ -n "$containers" ]]; then
			docker rm -f $containers >/dev/null 2>&1 || true
		fi
		networks="$(docker network ls --format '{{.Name}}' | grep '^agent-sandbox-net-' || true)"
		if [[ -n "$networks" ]]; then
			docker network rm $networks >/dev/null 2>&1 || true
		fi
	fi
}

if [[ "$MOM_SKIP_CLEAN" != "1" ]]; then
	cleanup_existing_runtime
fi

cd "$REPO_ROOT"
exec "$TSX_BIN" packages/mom/src/main.ts \
  --sandbox="$MOM_SANDBOX" \
  --rpc-socket "$MOM_RPC_SOCKET" \
  --extension /Users/rootclaw/Projects/mom-workspace/.pi/extensions/minimax-m3.ts \
  --extension /Users/rootclaw/Projects/mom-workspace/.pi/extensions/upwork-coach.ts \
  --extension /Users/rootclaw/Projects/mom-workspace/.pi/extensions/mcp-path-bridge.ts \
  "$WORKSPACE_DIR"
