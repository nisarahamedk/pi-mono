---
name: mom-smoke
description: End-to-end smoke testing framework for mom (vibesilo) using mom-cli via the optional RPC socket; includes how to drive, observe, and verify behavior.
---

# mom-smoke

End-to-end smoke testing for this repo’s `mom` agent **without Slack**.

This skill is designed for coding agents working on `pi-mono` to quickly validate changes by:

1) **Driving** mom via `mom-cli` in a fresh thread/session (vibesilo sandbox).
2) **Observing** tool calls + final response.
3) **Verifying** ground truth via vibesilo proxy config/logs + mom artifacts (`context.jsonl`, `last_prompt.jsonl`).
4) **Resetting** the sandbox when needed.

## What this skill provides

This skill is intentionally **documentation-only**. It provides a repeatable framework and the key commands/locations a coding agent should use to do an end-to-end smoke test.

## Framework

### 1) Drive mom (no Slack)

For smoke testing, start `mom` with an RPC socket enabled, then use `mom-cli` to drive sessions.

Recommended: run `mom` in tmux so it stays up while you drive with `mom-cli` and inspect proxy logs.

Start mom (tmux):

```bash
tmux new -s mom-gateway
mom --sandbox=vibesilo --rpc-socket ~/mom-workspace/.mom.sock ~/mom-workspace
```

If you don’t want tmux, you can run the same `mom ...` command in a dedicated terminal.

Create a new session id:

```bash
SESSION=$(mom-cli --workspace ~/mom-workspace new-session)
echo "$SESSION"
```

Send a message (repeatable; uses the same session/thread):

```bash
mom-cli --workspace ~/mom-workspace send --session "$SESSION" --text "Run: echo ok"
```

Send a follow-up in the same session:

```bash
mom-cli --workspace ~/mom-workspace send --session "$SESSION" --text "What did you do?"
```

### 2) Observe

- Check the terminal output for `↳ bash:` tool invocations and `✓ bash` results.
- Confirm the agent attempted the intended behavior (e.g. it actually ran `agent-browser`, not just described it).

### 3) Verify ground truth (vibesilo)

Locate the active sandbox + proxy containers:

```bash
docker ps --filter "name=agent-sandbox" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
```

Inspect the authoritative allowNet / secret *metadata* (proxy-side).

Do **not** `cat /config/secrets.json` in environments where real secrets are configured: it contains secret values.

Instead, print just the allowlist and secret names/hosts:

```bash
PROXY=<agent-sandbox-proxy-...>

docker exec "$PROXY" python - <<'PY'
import json
cfg = json.load(open('/config/secrets.json', 'r'))
print('allowNet:', cfg.get('allowNet', []))
secrets = cfg.get('secrets', {})
print('secrets:', {k: {'hosts': v.get('hosts', [])} for k, v in secrets.items()})
PY
```

Inspect proxy logs (blocked hosts, TLS errors, etc.):

```bash
docker logs --tail 200 "$PROXY"
```

### 4) Verify mom artifacts (what the model saw)

The `mom-cli --session <id>` value maps to mom’s thread/session id and is used as the thread directory name.

Artifacts live under:

```
~/mom-workspace/CLOCAL/threads/<session>/
  context.jsonl
  last_prompt.jsonl
```

Inspect:

```bash
SESSION=<session>
ls -la ~/mom-workspace/CLOCAL/threads/$SESSION

tail -200 ~/mom-workspace/CLOCAL/threads/$SESSION/context.jsonl
cat ~/mom-workspace/CLOCAL/threads/$SESSION/last_prompt.jsonl
```

## Common scenarios (behavioral)

These prompts are intentionally *behavioral* (not “run this exact command”), so you can see whether the model chooses the right tools on its own and where the system prompt/skills need nudges.

### Network policy (allowed vs blocked)

Drive:

```bash
SESSION=$(mom-cli --workspace ~/mom-workspace new-session)

mom-cli --workspace ~/mom-workspace send --session "$SESSION" --text \
  "From this sandbox, check whether you can reach https://github.com and https://openai.com. Try both and report the result (status code or the exact error text)."
```

Observe:
- Did mom actually try network requests via tools?
- Did it correctly interpret a vibesilo block (HTTP 403 with text like "blocked by agent-sandbox allowNet")?

Verify:
- Proxy logs should show attempted hosts.
- Proxy config (`/config/secrets.json`) should show `allowNet`.

### Browser navigation (agent-browser)

Drive (first attempt):

```bash
SESSION=$(mom-cli --workspace ~/mom-workspace new-session)

mom-cli --workspace ~/mom-workspace send --session "$SESSION" --text \
  "Open https://github.com and give me a compact list of interactive elements with stable refs I can use for follow-ups (e.g., the kind of output you’d use for ‘click ref=e12’)."
```

Observe:
- Did mom choose `agent-browser` (or another browser tool) and produce a snapshot-like output?
- If it failed, what was the *first* failure mode (e.g. cert error, allowNet block, missing binary)?

If it fails due to cert / MITM, send a *minimal nudge* follow-up:

```bash
mom-cli --workspace ~/mom-workspace send --session "$SESSION" --text \
  "If you hit ERR_CERT_AUTHORITY_INVALID due to the sandbox proxy, retry with agent-browser configured to ignore HTTPS errors, then produce the interactive snapshot."
```

## Reset

To fully reset a vibesilo run (force re-read of settings + new containers):

```bash
# Stop mom (Ctrl+C), then:
docker rm -f $(docker ps -aq --filter "name=agent-sandbox") 2>/dev/null || true
```

## Notes

- `mom` is the unified gateway. `mom-cli` is just a messaging surface that talks to a running `mom` process started with `--rpc-socket`.
- The `--session` id is the thread/session key and maps to:
  `WORKSPACE/CHANNEL/threads/<session>/context.jsonl`.
- vibesilo sandbox config is read at sandbox creation time; if you change `settings.json`, restart mom (and remove `agent-sandbox*` containers if you want a fully clean sandbox).
