/**
 * WindowsShellSession — One cmd.exe (or PowerShell) instance, per terminal.
 *
 * Mirrors the design of LinuxShellSession (terminal_gap.md §6). Each
 * Windows terminal allocates one. The session owns the cwd, the
 * environment block, the per-drive cwd map, and a per-shell command
 * history — all the fields that mutate as the user types and which a
 * real CMD.exe would keep independent from any other cmd.exe instance.
 *
 * Real Windows: each `cmd.exe` process holds its own current directory
 * (per drive), its own environment block (inherited from the parent but
 * isolated), and its own DOSKEY history. Multiple consoles on the same
 * machine never share these — opening a second console at the same time
 * starts at `%USERPROFILE%`, not at the other console's `cd /d D:\foo`.
 */

let nextSessionSeq = 1;

export interface WindowsShellSessionInit {
  user: string;
  cwd: string;
  /** Initial environment block (the session takes a defensive copy). */
  env: Map<string, string>;
  comSpec?: string;
}

export class WindowsShellSession {
  readonly id: string;

  // ── Identity ────────────────────────────────────────────────────
  readonly user: string;
  /** Path to the cmd.exe binary, exposed as %ComSpec%. */
  readonly comSpec: string;
  /** PID-like opaque identifier. Not registered with a process manager
   *  yet — Windows process table support is partial — but kept as a
   *  forward-compatible field. */
  readonly shellPid: number = Math.floor(Math.random() * 60000 + 1024);

  // ── Mutable state ───────────────────────────────────────────────
  cwd: string;
  env: Map<string, string>;
  /**
   * Per-drive last-visited cwd (e.g. { 'C': 'C:\\Users\\User', 'D': 'D:\\work' }).
   * `cd /d D:` on Windows positions at the drive's last cwd, not at
   * `D:\` — we keep the map even if commands do not yet consult it, so
   * future enhancements can wire it without reshaping the data model.
   */
  driveCwd: Map<string, string> = new Map();
  /** DOSKEY-style history (bounded). */
  history: string[] = [];
  lastExitCode: number = 0;
  /** Whether ECHO is on (`@echo off` toggles this in batch). */
  echoOn: boolean = true;
  /** Active code page (chcp 437 by default; 65001 if user calls chcp 65001). */
  codePage: number = 437;
  /** Whether the shell has been disposed. */
  disposed: boolean = false;

  constructor(init: WindowsShellSessionInit) {
    this.id = `wshell-${nextSessionSeq++}`;
    this.user = init.user;
    this.cwd = init.cwd;
    this.env = new Map(init.env);
    this.comSpec = init.comSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    // Seed driveCwd with the initial drive.
    const drive = init.cwd.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
    if (drive) this.driveCwd.set(drive, init.cwd);
  }

  pushHistory(cmd: string): void {
    if (!cmd) return;
    this.history.push(cmd);
    if (this.history.length > 2000) {
      this.history.splice(0, this.history.length - 2000);
    }
  }

  dispose(): void { this.disposed = true; }
}
