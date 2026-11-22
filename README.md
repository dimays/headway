# Headway

A live progress pane for Claude Code. Headway sits beside the chat and shows
where your work stands — the session's plan, each step, the subagents working
on those steps, and your other sessions — as progress bars that move when
scope moves. No more asking a session "where are we at?"

```
This session
████████▓░░░░░░░░░░░ 2/5 40%
scope 4 → 5 · 1 change, last 3m ago (+1)

✓ Read the API docs
✓ Design the data model
▸ Write the pane
  ↳ ◐ Survey render props (Explore)
○ Test it
○ Ship it

Other sessions
scope-creep · 1m ago · 2 agents
██████████████░░░░░░ 7/10 70%
▸ Fix the login redirect
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install headway --marketplace dimays/headway
```

From a shell:

```bash
claude plugin install headway --marketplace dimays/headway
```

In the Claude desktop app: click **+** next to the prompt box → **Plugins** →
**Add marketplace** with `dimays/headway`, then **Add plugin**.

The pane opens on its own in each new session. `/headway` reopens it;
`/headway clear` resets the current session's board.

## How it works

Headway never asks the model for status. It watches what sessions already do:

- **Plans.** Every call to the desktop app's task list (`update_plan`) or the
  CLI's `TodoWrite` is captured as it happens, at no token cost. The bar is
  completed steps over total steps; the step in progress is drawn in its own
  colour.
- **Scope changes.** When a plan is rewritten with steps added or dropped,
  Headway records the change (`scope 4 → 6`). The bar is allowed to move
  backwards — a bar that never drops would hide the discoveries you want to
  see.
- **Subagents.** Each subagent is nested under the step its parent was on when
  it spawned, with its live status (◐ running, ◷ waiting, ✓ done, ✗ failed)
  and its own bar if it keeps a plan.
- **Other sessions.** Each session publishes a small summary to Headway's
  store (a JSON file under your Claude config directory), and every pane reads
  the others every few seconds. Sessions quiet for 15 minutes dim; after 7
  days they are forgotten.

Nothing leaves your machine.

## Limits (v0.1)

- Only sessions with Headway installed appear under *Other sessions*.
- Progress counts steps equally; a long step weighs the same as a short one.
- A session that never writes a task list shows no bar.

## Developing

```bash
claude plugin validate .
claude plugin test .
```

Run them with a Claude Code build at least as new as the one the mod targets
(2.1.321); older builds refuse the hooks module. To run it from this folder
while you edit:

```bash
claude --plugin-dir .
```

## License

MIT
