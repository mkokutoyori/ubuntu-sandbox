/**
 * WindowsWsusClientConfig — Windows Update client redirection toward a
 * WSUS server (PRD-Windows-Server-Advanced.md §5 P19, §2.1.18):
 * `Set-WUSettings -WUServer <address> -TargetGroup <name>`. Ships on every
 * Windows SKU, not just servers — mirrors `WindowsRdpConfig`'s own
 * unconditional-config convention.
 */
export class WindowsWsusClientConfig {
  wuServer: string | null = null;
  targetGroup: string | null = null;

  setWuServer(address: string): void { this.wuServer = address; }
  setTargetGroup(name: string): void { this.targetGroup = name; }
}
