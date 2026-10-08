export type DhcpDebugApplication = 'dhcps' | 'dhcpc' | 'dhcprelay' | 'ike';

export const DHCP_DEBUG_APPLICATIONS: readonly DhcpDebugApplication[] = ['dhcps', 'dhcpc', 'dhcprelay', 'ike'];

const HISTORY_LIMIT = 500;

export function isDhcpDebugApplication(name: string): name is DhcpDebugApplication {
  return (DHCP_DEBUG_APPLICATIONS as readonly string[]).includes(name);
}

export class DhcpDebug {
  private readonly levels = new Map<DhcpDebugApplication, number>();
  private readonly history: string[] = [];
  private readonly listeners = new Set<(line: string) => void>();
  private enabledFlag = false;
  private timestampFlag = false;

  constructor(private readonly clockMs: () => number) {}

  setLevel(application: DhcpDebugApplication, level: number): void {
    if (level === 0) this.levels.delete(application);
    else this.levels.set(application, level);
  }

  level(application: DhcpDebugApplication): number { return this.levels.get(application) ?? 0; }

  active(): boolean { return this.enabledFlag && this.levels.size > 0; }

  hasLevels(): boolean { return this.levels.size > 0; }

  setEnabled(on: boolean): void { this.enabledFlag = on; }

  setTimestamp(on: boolean): void { this.timestampFlag = on; }

  reset(): void {
    this.levels.clear();
    this.enabledFlag = false;
    this.timestampFlag = false;
  }

  emit(application: DhcpDebugApplication, text: string): void {
    if (!this.enabledFlag || this.level(application) === 0) return;
    const stamp = this.timestampFlag ? `${formatStamp(this.clockMs())} ` : '';
    this.record(`${stamp}[note]${text}`);
  }

  emitRaw(application: DhcpDebugApplication, text: string): void {
    if (!this.enabledFlag || this.level(application) === 0) return;
    const stamp = this.timestampFlag ? `${formatStamp(this.clockMs())} ` : '';
    this.record(`${stamp}${text}`);
  }

  private record(line: string): void {
    this.history.push(line);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    for (const listener of this.listeners) listener(line);
  }

  lines(): readonly string[] { return this.history; }

  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

function formatStamp(ms: number): string {
  const date = new Date(ms);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} `
    + `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
}
