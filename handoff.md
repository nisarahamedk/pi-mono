# Handoff: pi-mom thread-scoped sessions + thread-first replies

Date: 2026-02-06
Branch: `feat/mom-thread-context`

## Goal / UX Spec (agreed)

- **Mentions only**: mom only engages on explicit `@mom …` in channels (and DMs behave as before).
- **Thread-first replies (channels)**: when you mention mom in a channel, mom posts/updates her main response as a **thread reply** under the Slack thread root (your message if top-level, or the existing thread root if you mention in a thread).
- **Per-thread context window**: each Slack thread gets its own `context.jsonl`, so follow-ups in that thread keep the same LLM context.
- **Cron/events**: each scheduled event run creates a top-level “Starting event …” message (thread root), then all subsequent output goes into that thread.

## What was implemented

### Thread identity + logging
- `SlackEvent` now includes optional `threadTs`.
- `log.jsonl` entries now include a normalized `threadTs` key:
  - DMs: `threadTs = "dm"`
  - Channel thread replies: Slack `thread_ts`
  - Channel top-level messages: their own `ts` (becomes thread root)

### Thread-scoped contexts
- Runner/session cache key changed from **per-channel** to **per (channelId, threadTs)**.
- Context file location:
  - Channels: `data/<channelId>/threads/<threadTs>/context.jsonl`
  - DMs: `data/<dmChannelId>/context.jsonl` (kept as-is via `threadTs === "dm"` special-case)

### Slack reply routing
- In channels, `SlackContext.respond()` / `replaceMessage()` now post/update a **thread reply** (via `chat.postMessage({thread_ts: …})`) instead of posting top-level.
- For events, mom posts a single top-level root message first and then responds in that thread.

### Context sync filtering
- `syncLogToSessionManager()` now takes `threadTs` and only syncs log lines belonging to that thread.

## Files changed

- `packages/mom/src/slack.ts`
- `packages/mom/src/main.ts`
- `packages/mom/src/agent.ts`
- `packages/mom/src/context.ts`
- `packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json` (bumped `@anthropic-ai/sdk` to `^0.73.0` to match workspace)
- `package-lock.json` (after `npm install`)
- `handoff.md` (this file)

## Checks run

- `npm install`
- `npm run check` (repo root)

## How to manually verify (next session)

1. Run mom against a Slack workspace.
2. In a channel:
   - Post a top-level message: `@mom say hi`.
   - Expected: mom does **not** post a top-level response; she posts and continuously updates a **thread reply** under your message.
3. Reply inside that thread with `@mom continue`.
   - Expected: mom continues in the same thread; context persists.
4. Create a periodic/one-shot event file.
   - Expected: mom posts a top-level “Starting event …” root message; all details go into its thread.

## Known limitations / follow-ups

- There is currently no automated end-to-end harness that simulates Slack (Fake SlackBot + event fixtures). This would be the next step to reliably test threading and context behavior.
- DMs still trigger on any DM message (current behavior); the new thread-scoped logic uses a single `"dm"` key.

## Notes on design decisions

- Kept “mentions-only” (no auto-trigger on non-mention thread replies) to simplify Slack behavior.
- For events, we explicitly create the thread root message ourselves to guarantee a stable thread context.
