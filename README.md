# dsh-claude-bridge

Lets Claude Code use [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) agents as subagents.

It has two parts:

- **`plugin/`**: a Host plugin for the `dsh web` profile. It adds a small loopback-only HTTP API under
  `/claude-bridge/v1/` that can start a session, send follow-up messages, report status and the last answer, give
  a compact progress feed, cancel, and list sessions. Sessions are created inside the running web Host, the same way
  the web UI creates them, so they show up live in its sidebar under their workspace. You can watch, or take over,
  everything the calling agent starts.
- **`dsb.py`**: a dependency-free Python client for that API, meant to be called by the agent.

The plugin also gives the DeepSeek agent an `ask_claude(question)` tool, which queues a question for the calling
agent (`dsb.py outbox`); the answer goes back with `dsb.py say`.

Tested with dsh 0.2.1-rc.2 on Linux.

## Install

Once per machine; the plugin serves every workspace of the `web` profile.

```bash
git clone https://github.com/Magnetesim/dsh-claude-bridge.git
cd dsh-claude-bridge
npm install -g pnpm                               # dsh's plugin manager needs pnpm on PATH
dsh plugin --profile web add "$PWD/plugin"        # links this directory into ~/.dsh/profiles/web
```

Then restart `dsh web`. The first start creates `~/.dsh/claude-bridge.token` (mode 600). Check it with:

```bash
python3 dsb.py health
```

Updating is `git pull` plus a `dsh web` restart: the profile links `plugin/`, so the checkout is the installed code.
Uninstall with `dsh plugin --profile web remove dsh-claude-bridge`.

`plugin/package.json` pins `engines.dsh` to the tested version. After upgrading dsh, check that the bridge still
works and bump it.

## Use

Run `dsb.py` from the project directory. Sessions go into the dsh workspace of that directory, which is created if
it does not exist yet.

```bash
dsb.py start "Summarise src/ in five bullets" --title "summary" --wait
dsb.py job refactor-plan --wait     # sends: please read ./refactor-plan.md and complete the task inside ...
dsb.py events refactor-plan --follow
dsb.py say refactor-plan "Also list the risky files." --wait
dsb.py status refactor-plan
dsb.py outbox                       # questions the DeepSeek agent asked with ask_claude
```

`job` reads task documents from `$DSB_JOB_DIR` (default `.`), and `$DSB_JOB_PROMPT` overrides the message
template (`{path}` and `{tag}` are filled in). Sessions can be named by full id, by a job tag, or by a fragment of
an id. Job tags and started ids are remembered in `~/.dsh/claude-bridge/dsb_sessions.json`.

A line like this in a project's `CLAUDE.md` / `AGENTS.md` is enough for an agent to pick it up:

```text
DeepSeek subagents: write the task to docs/jobs/<tag>.md, then `DSB_JOB_DIR=docs/jobs python3 ~/src/dsh-claude-bridge/dsb.py job <tag> --wait`
(the user watches it live in dsh web at http://127.0.0.1:3080).
```

## API

Base `http://127.0.0.1:<web port>/claude-bridge/v1`. JSON in and out. Every request needs the header
`X-Claude-Bridge-Token: <contents of ~/.dsh/claude-bridge.token>`.

| Method and path | Purpose |
|---|---|
| `GET /health` | `{ ok, version, webUrl }` |
| `POST /sessions` | `{ cwd, prompt, title?, agentPreset?, model?, reasoningEffort?, provider?, sessionId? }` → `{ sessionId, webUrl }`. Creates the session in the workspace that owns `cwd` and sends the first prompt; returns while the turn runs. |
| `POST /sessions/:id/prompt` | `{ text, delivery?: "queue" \| "steer" }` → `{ accepted }`. Queued while the session is running, as in the UI. |
| `GET /sessions/:id` | `{ sessionId, title, cwd, running, turnCount, lastSeq, updatedAt, lastAssistantText }`. `lastAssistantText` is the final answer of the latest completed turn. |
| `GET /sessions/:id/events?afterSeq=N&limit=M` | Compact feed: `user`, `assistant`, `tool_call` (arguments truncated to 300 chars), `tool_result` (truncated to 500 chars), `turn_start`, `turn_end`; plus `nextSeq` and `hasMore`. |
| `POST /sessions/:id/cancel` | `{ cancelled }` |
| `GET /sessions?cwd=…&limit=N` | Recent sessions of the workspace that owns `cwd`. |
| `GET /outbox?after=TS` | Questions queued by the `ask_claude` tool. |

## Security

The bridge accepts a request only if it comes from a loopback socket, with a loopback `Host` header, no
cross-site `Origin` or `sec-fetch-site`, and the right token (compared in constant time). It sends no CORS headers,
and it does not change the web server's bind address or the trust checks on dsh's own `/api`.

The token gives full control of your dsh agents, which can run commands with whatever permissions your dsh setup
allows. Treat it like a password.

## Notes

- The web UI has no per-session URLs, so `webUrl` is the UI root; the session is in the sidebar.
- `lastAssistantText` does not stream. Use `events` to follow a running turn.
- The plugin was written by a DeepSeek agent in dsh's Creator mode, from a spec written by Claude Code, and
  reviewed by Claude Code.

## License

MIT
