import { getDefaultEventBus, type IEventBus, type Unsubscribe } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { CronSchedule } from '../../linux/LinuxCronManager';
import type { SnmpAgent } from '../../../snmp/SnmpAgent';
import { EemService, type EemAction, type EemApplet, type EemTrigger } from './EemService';

const SYSLOG_SEVERITY_NAMES = [
  'emergencies', 'alerts', 'critical', 'errors',
  'warnings', 'notifications', 'informational', 'debugging',
] as const;

const POLL_INTERVAL_MS = 1000;

export interface EemHost {
  readonly id: string;
  getHostname(): string;
  executeCommand(command: string): Promise<string>;
  getSnmpAgent?(): SnmpAgent | undefined;
}

interface TimerTriggerState {
  nextDueMs?: number;
  fired?: boolean;
  lastCronMinuteKey?: string;
}

function severityName(n: number | undefined): typeof SYSLOG_SEVERITY_NAMES[number] {
  if (n === undefined || n < 0 || n > 7) return 'informational';
  return SYSLOG_SEVERITY_NAMES[n];
}

function compareActionIds(a: string, b: string): number {
  const na = Number.parseFloat(a);
  const nb = Number.parseFloat(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

export class EemEngine {
  private readonly timerStates = new Map<string, TimerTriggerState>();
  private readonly runningApplets = new Set<string>();
  private subs: Unsubscribe[] = [];
  private pollHandle: TimerHandle | null = null;
  private running = false;

  constructor(
    private readonly host: EemHost,
    private readonly service: EemService,
    private readonly getBus: () => IEventBus = () => getDefaultEventBus(),
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const bus = this.getBus();
    this.subs.push(
      bus.subscribeWhere(
        'device.syslog.entry',
        (p) => p.deviceId === this.host.id,
        (e) => this.onSyslogEntry(e.payload.message),
      ),
    );
    this.subs.push(
      bus.subscribeWhere(
        'snmp.trap.sent',
        (p) => p.deviceId === this.host.id,
        (e) => this.onSnmpTrapSent(e.payload.trapOid),
      ),
    );
    this.pollHandle = this.getScheduler().setInterval(() => this.evaluateTimers(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const off of this.subs) off();
    this.subs = [];
    if (this.pollHandle !== null) {
      this.getScheduler().clear(this.pollHandle);
      this.pollHandle = null;
    }
    this.timerStates.clear();
  }

  async runApplet(applet: EemApplet): Promise<void> {
    if (this.runningApplets.has(applet.name)) return;
    this.runningApplets.add(applet.name);
    try {
      applet.recordTriggerCount++;
      applet.lastTriggeredAtMs = Date.now();
      const ordered = [...applet.actions].sort((a, b) => compareActionIds(a.id, b.id));
      for (const action of ordered) {
        await this.executeAction(applet, action);
      }
    } finally {
      this.runningApplets.delete(applet.name);
    }
  }

  async runByName(appletName: string): Promise<boolean> {
    const applet = this.service.getApplet(appletName);
    if (!applet) return false;
    await this.runApplet(applet);
    return true;
  }

  private onSyslogEntry(message: string): void {
    for (const applet of this.service.listApplets()) {
      if (this.runningApplets.has(applet.name)) continue;
      for (const trig of applet.triggers) {
        if (trig.kind !== 'syslog') continue;
        if (this.matchesPattern(trig.pattern, message)) {
          void this.runApplet(applet);
          break;
        }
      }
    }
  }

  private onSnmpTrapSent(trapOid: string): void {
    for (const applet of this.service.listApplets()) {
      if (this.runningApplets.has(applet.name)) continue;
      for (const trig of applet.triggers) {
        if (trig.kind !== 'snmp-notification') continue;
        if (trig.oid === trapOid) {
          void this.runApplet(applet);
          break;
        }
      }
    }
  }

  private evaluateTimers(): void {
    const now = Date.now();
    for (const applet of this.service.listApplets()) {
      applet.triggers.forEach((trig, index) => {
        if (trig.kind === 'timer.watchdog' || trig.kind === 'timer.countdown') {
          this.evaluateIntervalTimer(applet, trig, index, now);
        } else if (trig.kind === 'timer.cron') {
          this.evaluateCronTimer(applet, trig, index, now);
        } else if (trig.kind === 'snmp-object') {
          this.evaluateSnmpObjectTrigger(applet, trig);
        }
      });
    }
  }

  private timerKey(applet: EemApplet, index: number): string {
    return `${applet.name}#${index}`;
  }

  private evaluateIntervalTimer(
    applet: EemApplet,
    trig: Extract<EemTrigger, { kind: 'timer.watchdog' | 'timer.countdown' }>,
    index: number,
    now: number,
  ): void {
    const key = this.timerKey(applet, index);
    let st = this.timerStates.get(key);
    if (!st) {
      st = { nextDueMs: now + trig.intervalSec * 1000 };
      this.timerStates.set(key, st);
      return;
    }
    if (trig.kind === 'timer.countdown' && st.fired) return;
    if (st.nextDueMs === undefined || now < st.nextDueMs) return;
    if (trig.kind === 'timer.watchdog') {
      st.nextDueMs = now + trig.intervalSec * 1000;
    } else {
      st.fired = true;
    }
    void this.runApplet(applet);
  }

  private evaluateCronTimer(
    applet: EemApplet,
    trig: Extract<EemTrigger, { kind: 'timer.cron' }>,
    index: number,
    now: number,
  ): void {
    const schedule = CronSchedule.parse(trig.cronEntry);
    if (!schedule) return;
    const at = new Date(now);
    const minuteKey = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}-${at.getHours()}-${at.getMinutes()}`;
    const key = this.timerKey(applet, index);
    let st = this.timerStates.get(key);
    if (!st) {
      st = {};
      this.timerStates.set(key, st);
    }
    if (st.lastCronMinuteKey === minuteKey) return;
    if (!schedule.isDue(at)) return;
    st.lastCronMinuteKey = minuteKey;
    void this.runApplet(applet);
  }

  private evaluateSnmpObjectTrigger(
    applet: EemApplet,
    trig: Extract<EemTrigger, { kind: 'snmp-object' }>,
  ): void {
    const agent = this.host.getSnmpAgent?.();
    if (!agent) return;
    const current = agent.getLocalOidValue(trig.oid);
    if (current === null) return;
    if (this.snmpObjectMatches(trig.op, current.value, trig.value)) {
      void this.runApplet(applet);
    }
  }

  private snmpObjectMatches(op: string, current: string | number | null, expected: string): boolean {
    const curNum = typeof current === 'number' ? current : Number.parseFloat(String(current));
    const expNum = Number.parseFloat(expected);
    const numeric = !Number.isNaN(curNum) && !Number.isNaN(expNum);
    switch (op) {
      case 'eq': case 'is': return numeric ? curNum === expNum : String(current) === expected;
      case 'ne': return numeric ? curNum !== expNum : String(current) !== expected;
      case 'lt': return numeric && curNum < expNum;
      case 'gt': return numeric && curNum > expNum;
      case 'le': return numeric && curNum <= expNum;
      case 'ge': return numeric && curNum >= expNum;
      default: return false;
    }
  }

  private matchesPattern(pattern: string, message: string): boolean {
    try {
      return new RegExp(pattern).test(message);
    } catch {
      return message.includes(pattern);
    }
  }

  private async executeAction(applet: EemApplet, action: EemAction): Promise<void> {
    switch (action.kind) {
      case 'cli':
        await this.host.executeCommand(action.command);
        break;
      case 'syslog':
        this.publishSyslog(action.severity, applet.name, action.message);
        break;
      case 'puts':
        this.publishSyslog(undefined, applet.name, action.message);
        break;
      case 'wait':
        await this.getScheduler().delay(action.seconds * 1000);
        break;
      case 'snmp-trap':
        this.host.getSnmpAgent?.()?.sendTrap(action.oid);
        break;
      case 'mail':
        this.publishSyslog(6, 'eem-mail', `mail to ${action.to}: ${action.subject} — ${action.body}`);
        break;
    }
  }

  private publishSyslog(severityNum: number | undefined, tag: string, message: string): void {
    this.getBus().publish({
      topic: 'device.syslog.entry',
      payload: {
        deviceId: this.host.id,
        severity: severityName(severityNum),
        severityNum: severityNum !== undefined && severityNum >= 0 && severityNum <= 7 ? severityNum : 6,
        tag,
        message,
        ts: Date.now(),
      },
    });
  }
}
