import type { AuditMessage, AuditPriority, AuditdConfigFs } from '../AuditdConfig';
import { loadPluginConfig, type PluginConfig } from './AudispPluginConfig';
import type { PluginInstance, PluginProgram } from './AudispPlugins';

export interface DispatcherSettings {
  qDepth: number;
  overflowAction: string;
  maxRestarts: number;
  pluginDir: string;
}

export interface DispatcherEnv {
  readonly fs: AuditdConfigFs;
  listDirectory(path: string): readonly string[] | null;
  syslog(priority: AuditPriority, text: string): void;
  spawn(config: PluginConfig): number;
  isAlive(pid: number): boolean;
  terminate(pid: number): void;
  programFor(path: string): PluginProgram | null;
  startProgram(program: PluginProgram, config: PluginConfig, pid: number): PluginInstance | null;
}

interface Slot {
  config: PluginConfig;
  pid: number;
  pipeOpen: boolean;
  instance: PluginInstance | null;
  restartCount: number;
  checked: boolean;
}

function countDots(name: string): number {
  return name.split('.').length - 1;
}

export class AudispDispatcher {
  private slots: Slot[] = [];
  private settings: DispatcherSettings;
  private maxUsed = 0;
  private running = false;

  constructor(private readonly env: DispatcherEnv, settings: DispatcherSettings) {
    this.settings = { ...settings };
  }

  get activePlugins(): number {
    return this.slots.length;
  }

  get isRunning(): boolean {
    return this.running;
  }

  init(): void {
    this.slots = [];
    this.loadPluginConfigs().forEach((config) => this.slots.push(this.newSlot(config)));
    if (this.slots.length === 0) {
      this.running = false;
      this.env.syslog('NOTICE', 'No plugins found, not dispatching events');
      return;
    }
    let active = 0;
    for (const slot of this.slots) if (this.startOne(slot)) active++;
    this.running = true;
    this.env.syslog('INFO', `audit dispatcher initialized with q_depth=${this.settings.qDepth} and ${active} active plugins`);
  }

  dispatch(line: string): void {
    if (!this.running) return;
    this.maxUsed = Math.max(this.maxUsed, 1);
    const event = line.replace(/\n(?!$)/g, ' ');
    for (const slot of this.slots) {
      if (!slot.config.active || !slot.pipeOpen) continue;
      if (this.env.isAlive(slot.pid) && slot.instance !== null) {
        slot.instance.write(event);
        continue;
      }
      this.env.syslog('ERR', `plugin ${slot.config.path} terminated unexpectedly`);
      slot.pid = 0;
      slot.pipeOpen = false;
      slot.instance = null;
      slot.restartCount++;
      slot.config.active = false;
      if (slot.restartCount > this.settings.maxRestarts) {
        this.env.syslog('ERR', `plugin ${slot.config.path} has exceeded max_restarts`);
      }
      if (this.startOne(slot)) {
        slot.instance?.write(event);
        this.env.syslog('NOTICE', `plugin ${slot.config.path} was restarted`);
        slot.config.active = true;
      }
    }
  }

  reconfigure(settings: DispatcherSettings): void {
    this.settings = { ...settings };
    if (this.slots.length === 0) {
      this.init();
      return;
    }
    for (const slot of this.slots) slot.checked = false;
    for (const next of this.loadPluginConfigs()) {
      const current = this.slots.find((slot) => slot.config.name === next.name);
      if (current === undefined) {
        const slot = this.newSlot(next);
        this.slots.push(slot);
        this.startOne(slot);
        continue;
      }
      if (current.config.active === next.active) {
        if (current.config.active) {
          if (current.config.inode === next.inode) {
            current.instance?.reload();
          } else {
            this.env.syslog('INFO', `Restarting ${current.config.path} since binary changed`);
            this.stop(current);
            this.startOne(current);
            current.config.inode = next.inode;
          }
        }
        current.checked = true;
      } else if (next.active) {
        current.config = next;
        current.checked = true;
        this.startOne(current);
      }
    }
    for (const slot of this.slots) {
      if (slot.checked) continue;
      slot.config.active = false;
      this.env.syslog('INFO', `Terminating ${slot.config.path} because its now inactive`);
      this.stop(slot);
      slot.checked = true;
    }
    if (this.slots.every((slot) => !slot.config.active)) {
      this.env.syslog('INFO', 'After reconfigure, there are no active plugins, exiting');
      this.shutdown();
    }
  }

  shutdown(): void {
    for (const slot of this.slots) {
      if (slot.pid !== 0) this.stop(slot);
    }
    this.slots = [];
    this.running = false;
  }

  stateLines(): string[] {
    return [
      `Number of active plugins = ${this.slots.length}`,
      'current plugin queue depth = 0',
      `max plugin queue depth used = ${this.maxUsed}`,
      `plugin queue size = ${this.settings.qDepth}`,
      'plugin queue overflow detected = no',
      'plugin queueing suspended = no',
    ];
  }

  private newSlot(config: PluginConfig): Slot {
    return { config, pid: 0, pipeOpen: false, instance: null, restartCount: 0, checked: true };
  }

  private stop(slot: Slot): void {
    slot.instance?.terminate();
    if (slot.pid !== 0) this.env.terminate(slot.pid);
    slot.instance = null;
    slot.pid = 0;
    slot.pipeOpen = false;
  }

  private startOne(slot: Slot): boolean {
    if (slot.restartCount > this.settings.maxRestarts) return true;
    const config = slot.config;
    const pid = this.env.spawn(config);
    slot.pid = pid;
    slot.pipeOpen = true;
    const program = config.path === null ? null : this.env.programFor(config.path);
    slot.instance = program === null ? null : this.env.startProgram(program, config, pid);
    if (slot.instance === null) this.env.terminate(pid);
    return true;
  }

  private loadPluginConfigs(): PluginConfig[] {
    const directory = this.settings.pluginDir;
    const names = this.env.listDirectory(directory);
    const loaded: PluginConfig[] = [];
    if (names === null) return loaded;
    for (const name of [...names].sort()) {
      if (name.startsWith('.') || countDots(name) > 1) continue;
      const result = loadPluginConfig(this.env.fs, `${directory}/${name}`);
      this.emit(result.messages);
      if (result.rc === 0) {
        if (result.config.active) loaded.push(result.config);
      } else {
        this.env.syslog('ERR', `Skipping ${name} plugin due to errors`);
      }
    }
    return loaded;
  }

  private emit(messages: readonly AuditMessage[]): void {
    for (const entry of messages) this.env.syslog(entry.priority, entry.text);
  }
}
