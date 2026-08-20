import { RdpSessionTable } from './server/rdp/RdpSession';

/** Remote Desktop toggle (PRD-Windows-Server-Advanced.md §5 P17) — disabled by default, matching real Windows' `fDenyTSConnections=1` out of the box (and this codebase's own `WindowsWinRmConfig` convention). */
export class WindowsRdpConfig {
  enabled = false;
  readonly sessions = new RdpSessionTable();

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
}
