# Headway

A live progress pane for Claude Code. Headway sits beside the chat and shows
where your work stands — the session's plan, each step, the subagents working
on those steps, and your other sessions — as progress bars that move when
scope moves. No more asking a session "where are we at?"

```
THIS SESSION
headway                                    3/7  52%
████████████████▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
● On track            ~9–14 min left · calibrated ⓘ
Plan grew from 5 to 7 steps · 1 change, last 4m ago ⓘ

STEPS                                1 done in Archive
▾ ● Build the pane                          ~3m left
    ━━━━━━━━━━━━━━━━━━━━━━━━┅┅┅┅┅┅────────────────
    2/4 parts · Drawing the bars
      Started 12m ago · last sign of work just now
      ✓ Layout                                   done
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      ● Bars                                      40%
      ━━━━━━━━━━━━━━━━──────────────────────────
      ○ Buttons                           not started
      ○ Tests                             not started
      ◐ Survey render props           Explore · 2m
       +0s  Read · register.tsx                 0s
      +41s  Edit · register.tsx                 1s
     +4m2s  Bash · claude plugin test          12s
      [ Add context ]
▸ ◌ Write the docs                       stale? · 14m
    No sign of work for 14m: it may be done but never checked off.
▸ ○ Test it                                      ~3m
    ──────────────────────────────────────────────

BACKGROUND TASKS                             1 running
▸ ◐ Build the release                              6m
    ✓ 412 modules transformed

OTHER SESSIONS
▸ scope-creep                              7/10  70%
  ██████████████████████████████████░░░░░░░░░░░░░░
  Slower than usual · ~6–11 min left · Fix the login redirect

▸ ARCHIVE · 6
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

The pane opens on its own in each new session. `/headway` reopens it, at
once, even in the middle of a turn; `/headway clear` resets the current
session's board.

## What it shows

- **Nested progress.** The session's bar, then a bar per step, each with its
  own ETA. Click a step's name (or ▸) to open it, and again to close it: its
  parts, each with a bar of its own, the subagents and background tasks
  working on it, and its order of operations: every tool call in sequence,
  with how long each took.
- **Live work up top, the rest in the Archive.** Finished steps, steps a
  rewritten plan dropped (*superseded*), finished subagents and background
  tasks, and other sessions that are done or quiet move to an **Archive**
  section a couple of minutes after they end. It's collapsed until you click
  it.
- **Status from evidence.** A step, subagent or task ends when something
  says so: the plan checks it off, a report says 100% or every part done, the
  agent's report reaches its parent, a task notification arrives, a turn's
  end no longer lists the task, or the engine stops listing the agent. A step
  still marked in progress with nothing working on it for 10 minutes (the
  `staleMinutes` option) reads **stale?** instead, so you can tell work that
  is running from work that never got an end status.
- **ETAs that say what they rest on.** Every estimate is labelled with its
  basis: *measured* (this session's finished steps), *calibrated* (the
  session's own step sizes, checked against how long finished steps really
  took), *session's estimate* (minutes it reported for the step in
  progress), *past sessions* (how long similar steps took before), or
  *unchecked guess* (sizes nothing has checked yet). With nothing to go on,
  it says **no estimate yet** instead of inventing a number.
- **Working time only.** The clock runs while the session works, not while
  it waits for your reply or a permission prompt, so a paused session's
  estimate doesn't slip.
- **Honest overruns.** A step past its estimate shows *over by 7m* (never a
  fake "1 minute left"), the range widens, and when the projected finish
  keeps moving the pane says how far (*finish moved +12m in the last 20m, 3
  slips*) and offers **Ask for a new estimate**.
- **Measured vs. inferred.** The solid part of a bar is real progress:
  finished steps, or what the session reported. The pale part is inferred
  from working time. Hover over a bar or any ⓘ for what it rests on;
  tooltips are sized to the room above them, so they're never cut off.
- **Health in plain words.** *On track*, *Slower than usual* (twice the
  typical step), *Quiet* (no tool call for 3 minutes), *Needs you* (a
  permission prompt or question is waiting), *Paused* (turn over, steps
  left), *Failed*.
- **Background tasks.** Background shell commands, monitors and workflows
  get rows of their own, even outside any plan, with their latest output
  line and a warning when they go quiet.
- **Your other sessions,** each by its title, with its bar, health, ETA and current step.

## Steering from the pane

Open a row (▸) for its actions. Headway shows at most two, and only the ones
that fit what the row is doing:

| Row | When | Actions |
| --- | --- | --- |
| Step in progress | On track | Add context |
| | Quiet (no tool call for 3 min) | Status check · Add context |
| | Slower than usual | Wrap up · Add context |
| | Needs you | none: answer in the chat |
| Step not started | | Do next · Skip |
| Subagent | Working | Add context |
| | Quiet or slow | Status check · Stop |
| Background task | Running | Stop |
| | Failed or stopped | Retry |
| Another session | | Add context, plus Status check when it is quiet, slow or stale |

A note reaches a working session **before its next action**: Headway
attaches it to the next tool result, so the model can change course
mid-turn. When the session isn't working, the note arrives as a new message.
Other sessions get it as a message between sessions. The pane shows whether
each note is waiting, sent, or refused.

## How it works

Headway never asks the model for status. It watches what sessions already
do: their task lists (`update_plan` in the desktop app, `TodoWrite` in the
CLI), every tool call, subagent starts and reports, task notifications, and
background tasks. It also gives
the model one cheap tool, `report_progress`: right after writing its plan it
sizes each step (S, M, L, XL or minutes), and as it works it can report a
step's parts, a rough percent, minutes left and blockers. Steps checked off
in a batch are left out of the timings, and finished steps' working times are
kept by kind (tests, builds, research, …) to seed estimates in later
sessions.

Reports name steps loosely and still land: "the tests" finds *Run the test
suite*, "step 3" the third step, and a plan rewritten with a step reworded
keeps that step's time and parts. A subagent with no plan of its own gets its
reports on its own row.

Sessions share summaries through Headway's store (a JSON file under your
Claude config directory). Nothing leaves your machine.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `staleMinutes` | 10 | Minutes with no sign of work before a step in progress reads *stale?* |

Set it with `/config` in a terminal session, or as
`pluginConfigs.headway.options.staleMinutes` in `settings.json`.

## Changes

**0.4.0**

- **The pane reopens.** `/headway` runs at once, mid-turn too; before, it
  waited for the turn to end, so in a long turn a closed pane seemed not to
  come back. It also says why when the pane can't be drawn yet. A board the
  pane can't draw now shows a way out (*Clear the board*) instead of closing
  the pane, which every reopen used to repeat.
- **No more lost updates.** Every write to the board goes through one queue.
  Before, under a burst of parallel subagents and background jobs, a write
  could lose the race for the board's version eight times and be dropped.
  Reports match their step tolerantly, rewritten plans keep reworded steps,
  and agent reports, task notifications and subagents' turn ends close work
  as it happens. None of this asks the model for more calls.
- **An Archive section** for finished, superseded and old work, collapsed
  by default; click to open or close it.
- **Closure from evidence**, with *stale?* in place of a stuck
  "in progress" (see *Status from evidence* above). Subagents the engine no
  longer lists end instead of running forever.
- **Steps open on click**, name and all, into their parts with a bar each,
  from the parts' and the step's reported percent.

## Limits

- Only sessions started after Headway is installed appear, and it can't
  see work from before it started.
- A plugin's stop is subject to your permission rules. If they refuse it,
  Headway asks the session to stop the task instead, and says so.
- Tooltips (ⓘ) need a pointer, so they show on desktop and in the IDE, not
  in the terminal.

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
