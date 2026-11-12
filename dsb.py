#!/usr/bin/env python3
"""dsb: start and follow DeepSeek Harness sessions from another agent, through the dsh-claude-bridge plugin.

Sessions run inside the user's `dsh web` Host and appear live in its sidebar, in the workspace of --cwd
(default: the current directory).

  dsb.py job TAG [--wait]          # send "please read <DSB_JOB_DIR>/TAG.md and complete the task inside."
  dsb.py start "prompt" [--title T] [--cwd DIR] [--file prompt.md] [--wait]
  dsb.py say SESSION "follow-up" [--steer] [--wait]
  dsb.py status SESSION            # running / turns / last answer
  dsb.py wait SESSION [--timeout S]  # block until the current turn ends, print the answer
  dsb.py events SESSION [--after SEQ] [--follow]   # compact progress feed
  dsb.py cancel SESSION
  dsb.py list [--cwd DIR]
  dsb.py outbox [--after TS]       # questions the DeepSeek agent asked with its ask_claude tool
  dsb.py health

SESSION is a full id, a job tag or id fragment remembered from `job`/`start` (~/.dsh/claude-bridge/dsb_sessions.json),
or a unique fragment of an id in the --cwd workspace. The token is read from ~/.dsh/claude-bridge.token, never printed.
Env: DSB_URL (default http://127.0.0.1:3080/claude-bridge/v1), DSB_JOB_DIR (job docs, relative to the cwd;
default "."), DSB_JOB_PROMPT (template with {path}; default below).
"""
import argparse, json, os, sys, time, urllib.error, urllib.request

CWD = os.getcwd()
BASE = os.environ.get("DSB_URL", "http://127.0.0.1:3080/claude-bridge/v1").rstrip("/")
TOKEN_FILE = os.path.expanduser("~/.dsh/claude-bridge.token")
STATE = os.path.expanduser("~/.dsh/claude-bridge/dsb_sessions.json")
JOB_DIR = os.environ.get("DSB_JOB_DIR", ".")
HARNESS_INJECTED = ("Current runtime context", "<system-reminder>", "Time sampled while preparing")
JOB_PROMPT = os.environ.get("DSB_JOB_PROMPT",
                            "please read {path} and complete the task inside. lmk if you need anything.")


def call(method, path, body=None, timeout=30):
    try:
        token = open(TOKEN_FILE).read().strip()
    except OSError:
        sys.exit(f"no bridge token at {TOKEN_FILE}: is the dsh-claude-bridge plugin installed in the web profile?")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"X-Claude-Bridge-Token": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"bridge {method} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:500]}")
    except urllib.error.URLError as e:
        sys.exit(f"bridge unreachable at {BASE} ({e.reason}): is `dsh web` running?")


def load_state():
    try:
        return json.load(open(STATE))
    except (OSError, ValueError):
        return {}


def remember(tag, sid):
    """Job tags and started ids (key = id) so `say`/`wait` can find them by fragment from any cwd."""
    st = load_state()
    st[tag] = sid
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(st, open(STATE, "w"), indent=1)


def resolve(ref, cwd=CWD):
    """Full id, a job tag from `job`, or a unique fragment of an id in this repo's workspace (or --cwd's)."""
    if ref.startswith("session-") and len(ref) > 40:
        return ref
    st = load_state()
    if ref in st:
        return st[ref]
    ids = [s["sessionId"] for s in call("GET", f"/sessions?cwd={urllib.parse.quote(cwd)}&limit=200")["sessions"]]
    ids += [v for v in st.values() if v not in ids]
    hits = [i for i in ids if ref in i]
    if len(hits) != 1:
        sys.exit(f"session '{ref}' matches {len(hits)} sessions")
    return hits[0]


def status(sid):
    return call("GET", f"/sessions/{sid}")


def wait(sid, base_turns, timeout, quiet=False):
    """Until a turn beyond base_turns has finished. Prints the answer."""
    t0, last = time.time(), None
    while True:
        s = status(sid)
        if not s["running"] and s["turnCount"] > base_turns:
            print(s.get("lastAssistantText") or "(no assistant text)")
            return s
        if time.time() - t0 > timeout:
            sys.exit(f"timeout after {timeout} s: {sid} still running (turns {s['turnCount']})")
        if not quiet and s["lastSeq"] != last:
            last = s["lastSeq"]
            print(f"  ... {int(time.time() - t0)} s, seq {last}, running={s['running']}", file=sys.stderr)
        time.sleep(10)


def show_events(sid, after, follow):
    while True:
        page = call("GET", f"/sessions/{sid}/events?afterSeq={after}&limit=500")
        for e in page["events"]:
            t = e["type"]
            if t in ("user", "assistant"):
                txt = e.get("text", "").strip()
                if not txt:
                    continue
                if t == "user" and txt.startswith(HARNESS_INJECTED):   # runtime context, skills, clock
                    print(f"[{e['seq']}] (harness context: {txt.splitlines()[0][:60]})")
                    continue
                txt = txt.replace("\n", "\n      ")
                print(f"[{e['seq']}] {t}: {txt[:2000]}")
            elif t == "tool_call":
                print(f"[{e['seq']}] tool {e.get('name')}: {str(e.get('arguments', ''))[:200]}")
            elif t == "tool_result":
                print(f"[{e['seq']}]   -> {'ERROR ' if e.get('error') else ''}{str(e.get('text', ''))[:200]}")
            else:
                print(f"[{e['seq']}] {t} {e.get('status', '')} {e.get('error', '')}".rstrip())
        after = page["nextSeq"]
        if not follow:
            print(f"(next --after {after})", file=sys.stderr)
            return
        if not page["hasMore"]:
            if not status(sid)["running"]:
                return
            time.sleep(10)


def main():
    import urllib.parse  # noqa: F401 (used by resolve)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("job"); p.add_argument("tag"); p.add_argument("--wait", action="store_true")
    p.add_argument("--timeout", type=int, default=7200)
    p = sub.add_parser("start"); p.add_argument("prompt", nargs="?"); p.add_argument("--file")
    p.add_argument("--title"); p.add_argument("--cwd", default=CWD); p.add_argument("--wait", action="store_true")
    p.add_argument("--timeout", type=int, default=7200)
    p = sub.add_parser("say"); p.add_argument("session"); p.add_argument("text")
    p.add_argument("--steer", action="store_true"); p.add_argument("--wait", action="store_true")
    p.add_argument("--timeout", type=int, default=7200)
    p = sub.add_parser("status"); p.add_argument("session")
    p = sub.add_parser("wait"); p.add_argument("session"); p.add_argument("--timeout", type=int, default=7200)
    p = sub.add_parser("events"); p.add_argument("session"); p.add_argument("--after", type=int, default=0)
    p.add_argument("--follow", action="store_true")
    p = sub.add_parser("cancel"); p.add_argument("session")
    p = sub.add_parser("list"); p.add_argument("--cwd", default=CWD); p.add_argument("--limit", type=int, default=15)
    p = sub.add_parser("outbox"); p.add_argument("--after", type=int, default=0)
    p = sub.add_parser("health")
    a = ap.parse_args()

    if a.cmd == "health":
        print(call("GET", "/health"))
    elif a.cmd in ("job", "start"):
        if a.cmd == "job":
            path = os.path.normpath(os.path.join(JOB_DIR, a.tag + ".md"))
            if not os.path.exists(os.path.join(CWD, path)):
                sys.exit(f"no job doc {path} (DSB_JOB_DIR={JOB_DIR}, cwd {CWD})")
            prompt, title, cwd = JOB_PROMPT.format(path=path, tag=a.tag), f"Complete {a.tag} task", CWD
        else:
            prompt = open(a.file).read() if a.file else a.prompt
            if not prompt:
                sys.exit("give a prompt or --file")
            title, cwd = a.title, os.path.abspath(a.cwd)
        body = {"cwd": cwd, "prompt": prompt}
        if title:
            body["title"] = title
        sid = call("POST", "/sessions", body)["sessionId"]
        remember(a.tag if a.cmd == "job" else sid, sid)
        print(sid)
        if a.wait:
            wait(sid, 0, a.timeout)
    elif a.cmd == "say":
        sid = resolve(a.session)
        base = status(sid)["turnCount"]
        call("POST", f"/sessions/{sid}/prompt", {"text": a.text, "delivery": "steer" if a.steer else "queue"})
        print("accepted")
        if a.wait:
            wait(sid, base, a.timeout)
    elif a.cmd == "status":
        print(json.dumps(status(resolve(a.session)), indent=1))
    elif a.cmd == "wait":
        sid = resolve(a.session)
        s = status(sid)
        wait(sid, s["turnCount"] - 1, a.timeout)   # the current (or last) turn
    elif a.cmd == "events":
        show_events(resolve(a.session), a.after, a.follow)
    elif a.cmd == "cancel":
        print(call("POST", f"/sessions/{resolve(a.session)}/cancel"))
    elif a.cmd == "list":
        for s in call("GET", f"/sessions?cwd={urllib.parse.quote(os.path.abspath(a.cwd))}&limit={a.limit}")["sessions"]:
            when = time.strftime("%m-%d %H:%M", time.localtime(s["updatedAt"] / 1000))
            print(f"{s['sessionId']}  {when}  {'RUNNING ' if s['running'] else ''}{s['title']}")
    elif a.cmd == "outbox":
        r = call("GET", f"/outbox?after={a.after}")
        for it in r["items"]:
            print(f"{it['ts']}  {it['sessionId']}\n  {it['question']}")
        print(f"(next --after {r['next']})", file=sys.stderr)


if __name__ == "__main__":
    import urllib.parse
    main()
