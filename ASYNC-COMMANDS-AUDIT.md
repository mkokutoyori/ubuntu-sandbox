# Async Command Emulation — Audit & Journal

## Status: BLOCKED on a branch decision (see bottom)

This document is the journal for the "async command emulation across all
device types" iteration. Work could not proceed to implementation because of
a branch conflict described at the end. It records the audit so no effort is
lost when the decision is made.

## Where the work must happen

The task targets branch `mandeng`. On the remote, `mandeng` is **1568 commits
ahead of `main`** and holds the entire relevant codebase (DNS phases,
Linux/Windows command implementations, Oracle work, and — critically — the
async command runtime described below).

The branch this session is authorised to push to
(`claude/blissful-faraday-w2i3vx`) is currently **identical to `main`** and
contains none of that infrastructure. Implementing here would build on the
wrong base: unmergeable into `mandeng` and duplicating work that already
exists there.

## Audit of async / streaming command execution on `mandeng`

The "architecture socle" (unified async pipeline) the task asks for is
**already substantially built and wired** on `mandeng`. It is not greenfield.

### What already exists

- **`src/terminal/async/`** — a complete per-session async job runtime:
  - `types.ts` — the exact contracts the task names:
    `AsyncCommand = StreamingOutput | BackgroundProcess | EventSubscription`,
    plus `AsyncJobSink` (`line/lines/write/warn/error`), `AsyncJobContext`
    (`sink`, `signal: AbortSignal`, `cancelled()`, `onCancel()`, `delay()`),
    `AsyncJobSpec { mode: foreground|background; kind: streaming|background|subscription; run(ctx); onInterrupt?(ctx) }`,
    and `AsyncJobHandle`.
  - `TerminalAsyncRuntime.ts` — the engine: `start(spec)` (rejects a 2nd
    foreground job), `interruptForeground()`, `cancel(id)`, `cancelWhere()`,
    `cancelAll()`, `listJobs()`; one `AbortController` per job; abortable delay.
  - `LineAssembler.ts` — buffers partial `write()` chunks, splits on `\n`.
- **`src/terminal/sessions/TerminalSession.ts`** — base session owns the
  runtime and exposes `startAsyncCommand(spec)`, `startScrollingMonitor(...)`
  (repeated-frame poller), `startFollowStream(...)` (subscription bridge),
  `listAsyncJobs()`, `cancelAsyncJob(id)`, `hasForegroundAsyncJob`,
  `hasBackgroundAsyncJobs`. Output is imperative append (`addLine`/`addLines`),
  React subscribes via `useSyncExternalStore`.
- **Ctrl+C / cancellation** — `AbortController`/`AbortSignal` throughout;
  `onCtrlC()` → `interruptForeground()`, flushes assembler, prints `^C`, runs
  `spec.onInterrupt(ctx)` (e.g. ping/tcpdump summaries). Dispose →
  `cancelAll()`.
- **UI** — `TerminalView.tsx` hides input while a foreground stream holds the
  tty; `InfoBar` shows a background-jobs pill.
- **Event bus** — `src/events/` (`EventBus`, `Signal`, `Scheduler`,
  `TimerSet`, `waitForEvent`). `debug`/`terminal monitor` subscribe through
  `src/network/devices/diag/DebugBroadcast.ts` +
  `src/network/devices/router/diag/RouterDebugService.ts`
  (`TerminalDebugSource`), which translate protocol domain events into IOS log
  lines.
- **Broad real streaming coverage already implemented** (genuinely streaming,
  not one-shot dumps):
  - Linux (`LinuxTerminalSession.ts`): `tail -f`, `ping`, `traceroute`, `mtr`,
    `watch`, `top`, `journalctl -f`, `ip monitor`, `dmesg -w`, `netstat -c`,
    `vmstat/free/mpstat/pidstat/iostat/dstat`, `tcpdump`.
  - Windows (`WindowsTerminalSession.ts`): `ping`/`ping -t`, `tracert`,
    `netstat <interval>`, `pathping`.
  - Cisco (`CiscoTerminalSession.ts`): streaming `ping`, IOS `debug`
    (background subscription), `terminal monitor` (background subscription).
  - Huawei (`HuaweiTerminalSession.ts`): same `debug` + `terminal monitor`.

### What is clearly still missing (the real remaining work)

1. **Command/shell return contract is batch-only.** `IShell.processLine`
   returns `ShellLineResult { output: string[] }`; device
   `executeCommand(): Promise<string>`. Streaming is done by *bypassing* the
   return value and pushing into `AsyncJobSink`. Every streaming command is a
   bespoke `tryStart*` interceptor in a session subclass, matched by ad-hoc
   `commandLine.split(/\s+/)` + pipe/redirect guards, duplicated across
   Linux/Windows/Cisco/Huawei. **No command → `AsyncJobSpec` registry.**
2. **Two parallel streaming abstractions** coexist: the newer
   `AsyncJobSink`/runtime and the older `InputHost.attachStream` /
   `StreamAttachment` / `StreamSink` (`src/shell/input/types.ts`). Not unified.
3. **No genuine bash job control.** `&` (`TokenType.AMP`) is lexed but the
   parser treats it as a plain separator like `;`; there is no `jobs`/`fg`/`bg`
   backgrounding tied to the runtime. PowerShell `Start-Job` (`JobProvider`) is
   a synchronous simulation disconnected from `TerminalAsyncRuntime`.
4. **Streaming commands can't be piped/redirected** (explicitly bailed out) and
   don't integrate with the bash interpreter.
5. No POSIX signal model; interruption is only `AbortController` +
   `onInterrupt`.

### Recommended shape for the remaining work

Rather than a new socle, *converge on the existing one*:
- Extend `TerminalAsyncRuntime` as the single execution surface.
- Add a streaming variant to the shell command contract (let `processLine`
  optionally return an `AsyncCommand`/spec instead of `output[]`).
- Replace the per-session `tryStart*` chains with a
  command → `AsyncJobSpec` registry.
- Collapse `InputHost.attachStream` into the runtime's foreground-stream path.
- Wire bash `&`/`jobs`/`kill` and PowerShell `Start-Job` onto the runtime.

## Branch decision needed

I am authorised to push only to `claude/blissful-faraday-w2i3vx` and am
instructed never to push to a different branch without explicit permission.
The task requires `mandeng`. To proceed, I need one of:

1. **Explicit permission to develop on and push to `mandeng`** (the correct
   base — everything above lives there), or
2. Confirmation to work on `claude/blissful-faraday-w2i3vx` **rebased onto
   `mandeng`** (so the async runtime is present), with a PR merging back into
   `mandeng`.

Option 1 or 2 is required because option "work on the current main-based
branch" would produce unmergeable, duplicate work.
