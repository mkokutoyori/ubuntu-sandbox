import { createLinuxPamModules } from '@/network/devices/linux/pam/LinuxPamModules';
import type {
  LinuxPamHost, PamGroupRecord, PamShadowRecord, PamUserRecord,
} from '@/network/devices/linux/pam/PamLinuxHost';
import { formatPamLogLine, type PamConversationRequest, type PamLogEntry, type PamReply } from '@/network/devices/linux/pam/PamHandle';
import { PamTransaction, runPamSync } from '@/network/devices/linux/pam/PamTransaction';

export const DAY_MS = 86_400_000;

export interface LabUser {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly password?: string;
  readonly hash?: string;
  readonly home?: string;
  readonly shell?: string;
  readonly shadow?: Partial<PamShadowRecord> | null;
}

export interface LabGroup {
  readonly name: string;
  readonly gid: number;
  readonly members: readonly string[];
}

export interface PamLabOptions {
  readonly users: readonly LabUser[];
  readonly groups?: readonly LabGroup[];
  readonly files?: Record<string, string>;
  readonly caller?: { uid: number; euid?: number; loginName?: string };
  readonly now?: number;
}

export class PamLab {
  readonly logs: PamLogEntry[] = [];
  readonly files = new Map<string, string>();
  readonly passwords = new Map<string, string>();
  readonly history = new Map<string, string[]>();
  now: number;
  private readonly users = new Map<string, LabUser>();
  private readonly groups: LabGroup[];
  private readonly caller: { uid: number; euid: number; loginName: string };

  constructor(options: PamLabOptions) {
    this.now = options.now ?? 1_700_000_000_000;
    for (const user of options.users) {
      this.users.set(user.name, user);
      if (user.password !== undefined) this.passwords.set(user.name, user.password);
    }
    this.groups = [...(options.groups ?? [])];
    for (const [path, content] of Object.entries(options.files ?? {})) this.files.set(path, content);
    const caller = options.caller ?? { uid: 0 };
    this.caller = { uid: caller.uid, euid: caller.euid ?? caller.uid, loginName: caller.loginName ?? '' };
  }

  private record(user: LabUser): PamUserRecord {
    const today = Math.floor(this.now / DAY_MS);
    const shadow: PamShadowRecord | null = user.shadow === null ? null : {
      hash: user.hash ?? '$y$hash',
      lastChange: today - 10, min: 0, max: 99999, warn: 7, inactive: -1, expire: -1,
      ...user.shadow,
    };
    return {
      name: user.name, uid: user.uid, gid: user.gid, home: user.home ?? `/home/${user.name}`,
      shell: user.shell ?? '/bin/bash', gecos: '', shadow,
    };
  }

  readonly host: LinuxPamHost = {
    readFile: (path) => this.files.get(path) ?? null,
    now: () => this.now,
    log: (entry) => { this.logs.push(entry); },
    caller: new Proxy({} as { uid: number; euid: number; loginName: string }, {
      get: (_target, key) => this.caller[key as 'uid' | 'euid' | 'loginName'],
    }),
    files: {
      writeFile: (path, content) => { this.files.set(path, content); return true; },
      exists: (path) => this.files.has(path),
      stat: (path) => (this.files.has(path) ? { mode: 0o644, regular: true } : null),
      mkdirp: () => undefined,
      listDirectory: () => [],
      remove: (path) => { this.files.delete(path); },
    },
    accounts: {
      findUser: (name) => { const user = this.users.get(name); return user === undefined ? null : this.record(user); },
      findUserByUid: (uid) => {
        const user = [...this.users.values()].find((candidate) => candidate.uid === uid);
        return user === undefined ? null : this.record(user);
      },
      findGroup: (name): PamGroupRecord | null => this.groups.find((group) => group.name === name) ?? null,
      findGroupByGid: (gid): PamGroupRecord | null => this.groups.find((group) => group.gid === gid) ?? null,
      passwordMatches: (name, password) => this.passwords.get(name) === password,
      setPassword: (name, password) => { this.passwords.set(name, password); },
      rememberedPasswordUsed: (name, password, depth) => (this.history.get(name) ?? []).slice(-depth).includes(password),
      rememberPassword: (name, old) => { this.history.set(name, [...(this.history.get(name) ?? []), old]); },
      groupNames: (name) => {
        const user = this.users.get(name);
        const names = this.groups.filter((group) => group.members.includes(name) || group.gid === user?.gid).map((group) => group.name);
        return names;
      },
    },
  };

  transaction(service: string): PamTransaction<LinuxPamHost> {
    return new PamTransaction(service, this.host, createLinuxPamModules(), this.host);
  }

  messages(): string[] {
    return this.logs.map(formatPamLogLine);
  }
}

export function answers(...lines: Array<string | null>): (request: PamConversationRequest) => readonly PamReply[] {
  const queue = [...lines];
  return (request) => request.map((message) => (
    message.style === 'prompt-echo-off' || message.style === 'prompt-echo-on' ? { text: queue.shift() ?? null } : { text: null }
  ));
}

export interface Shown {
  readonly style: string;
  readonly text: string;
}

export function recording(lines: Array<string | null> = []): { converse: (request: PamConversationRequest) => readonly PamReply[]; shown: Shown[]; prompts: string[] } {
  const queue = [...lines];
  const shown: Shown[] = [];
  const prompts: string[] = [];
  return {
    shown, prompts,
    converse: (request) => request.map((message) => {
      if (message.style === 'prompt-echo-off' || message.style === 'prompt-echo-on') {
        prompts.push(message.text);
        return { text: queue.shift() ?? null };
      }
      shown.push({ style: message.style, text: message.text });
      return { text: null };
    }),
  };
}

export { runPamSync };
