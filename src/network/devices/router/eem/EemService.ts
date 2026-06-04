export type EemTrigger =
  | { kind: 'none' }
  | { kind: 'syslog'; pattern: string }
  | { kind: 'timer.cron'; cronEntry: string }
  | { kind: 'timer.watchdog'; intervalSec: number }
  | { kind: 'timer.countdown'; intervalSec: number }
  | { kind: 'snmp-notification'; oid: string }
  | { kind: 'snmp-object'; oid: string; op: string; value: string }
  | { kind: 'cli'; pattern: string };

export type EemAction =
  | { id: string; kind: 'cli'; command: string }
  | { id: string; kind: 'syslog'; severity?: number; message: string }
  | { id: string; kind: 'mail'; to: string; subject: string; body: string }
  | { id: string; kind: 'snmp-trap'; oid: string }
  | { id: string; kind: 'puts'; message: string }
  | { id: string; kind: 'wait'; seconds: number };

export interface EemApplet {
  name: string;
  description?: string;
  triggers: EemTrigger[];
  actions: EemAction[];
  authorization?: string;
  authBypass?: boolean;
  notifySyslog?: { content: 'plaintext' | 'xml' };
  recordTriggerCount: number;
  lastTriggeredAtMs?: number;
}

export interface EemEnvironmentVariable {
  name: string;
  value: string;
}

export class EemService {
  private readonly applets: Map<string, EemApplet> = new Map();
  private readonly environment: Map<string, EemEnvironmentVariable> = new Map();

  ensureApplet(name: string): EemApplet {
    let a = this.applets.get(name);
    if (!a) {
      a = { name, triggers: [], actions: [], recordTriggerCount: 0 };
      this.applets.set(name, a);
    }
    return a;
  }

  removeApplet(name: string): boolean { return this.applets.delete(name); }
  getApplet(name: string): EemApplet | undefined { return this.applets.get(name); }
  listApplets(): readonly EemApplet[] { return [...this.applets.values()]; }

  setEnvironment(name: string, value: string): void {
    this.environment.set(name, { name, value });
  }
  unsetEnvironment(name: string): void { this.environment.delete(name); }
  getEnvironment(): ReadonlyMap<string, EemEnvironmentVariable> { return this.environment; }

  triggerByName(appletName: string): boolean {
    const a = this.applets.get(appletName);
    if (!a) return false;
    a.recordTriggerCount++;
    a.lastTriggeredAtMs = Date.now();
    return true;
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    for (const env of this.environment.values()) {
      lines.push(`event manager environment ${env.name} ${env.value}`);
    }
    for (const a of this.applets.values()) {
      let header = `event manager applet ${a.name}`;
      if (a.authorization) header += ` authorization ${a.authorization}`;
      lines.push(header);
      if (a.description) lines.push(` description ${a.description}`);
      for (const t of a.triggers) lines.push(' ' + this.renderTrigger(t));
      for (const act of a.actions) lines.push(' ' + this.renderAction(act));
      if (a.notifySyslog) lines.push(` notify syslog contenttype ${a.notifySyslog.content}`);
    }
    return lines;
  }

  private renderTrigger(t: EemTrigger): string {
    switch (t.kind) {
      case 'syslog': return `event syslog pattern "${t.pattern}"`;
      case 'timer.cron': return `event timer cron cron-entry "${t.cronEntry}"`;
      case 'timer.watchdog': return `event timer watchdog time ${t.intervalSec}`;
      case 'timer.countdown': return `event timer countdown time ${t.intervalSec}`;
      case 'snmp-notification': return `event snmp-notification oid ${t.oid}`;
      case 'snmp-object': return `event snmp oid ${t.oid} get-type ${t.op} entry-val ${t.value}`;
      case 'cli': return `event cli pattern "${t.pattern}"`;
      default: return '';
    }
  }

  private renderAction(a: EemAction): string {
    switch (a.kind) {
      case 'cli': return `action ${a.id} cli command "${a.command}"`;
      case 'syslog': return `action ${a.id} syslog ${a.severity !== undefined ? 'msg-severity ' + a.severity + ' ' : ''}msg "${a.message}"`;
      case 'mail': return `action ${a.id} mail to "${a.to}" subject "${a.subject}" body "${a.body}"`;
      case 'snmp-trap': return `action ${a.id} snmp-trap intdata1 0 strdata "${a.oid}"`;
      case 'puts': return `action ${a.id} puts "${a.message}"`;
      case 'wait': return `action ${a.id} wait ${a.seconds}`;
      default: return '';
    }
  }
}
