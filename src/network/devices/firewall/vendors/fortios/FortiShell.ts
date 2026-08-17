import type { FortiGate } from './FortiGate';
import { FORTIOS_PROFILE } from './FortiProfile';

export const FORTI_COMMAND_FAIL = 'Command fail. Return code -61';

type FortiTable = 'policy' | 'address';

interface EditedObject {
  readonly table: FortiTable;
  readonly id: string;
  readonly attributes: Map<string, string[]>;
}

const POLICY_ATTRIBUTES = new Set([
  'srcintf', 'dstintf', 'srcaddr', 'dstaddr', 'action',
  'schedule', 'service', 'nat', 'name', 'status', 'comments',
]);

const ADDRESS_ATTRIBUTES = new Set(['subnet', 'type', 'start-ip', 'end-ip', 'comment']);

const ROOT_VOCABULARY: readonly string[] = Object.freeze([
  'config firewall policy', 'config firewall address',
  'diagnose sys session list', 'get system status',
  'show firewall address', 'show firewall policy',
]);

export class FortiShell {
  private table?: FortiTable;
  private edited?: EditedObject;
  private readonly stored = new Map<string, EditedObject>();

  constructor(private readonly fw: FortiGate) {}

  getPrompt(): string {
    const host = this.fw.getName();
    if (this.edited) return `${host} (${this.edited.id}) # `;
    if (this.table) return `${host} (${this.table}) # `;
    return `${host} # `;
  }

  completions(input: string): readonly string[] {
    const prefix = input.trimStart();
    return this.vocabulary().filter(word => word.startsWith(prefix) && word !== prefix);
  }

  help(): readonly string[] {
    return this.vocabulary();
  }

  private vocabulary(): readonly string[] {
    if (this.edited) {
      const known = this.edited.table === 'policy' ? POLICY_ATTRIBUTES : ADDRESS_ATTRIBUTES;
      return [...[...known].map(a => `set ${a}`), 'unset nat', 'next', 'end'];
    }
    if (this.table) return ['edit', 'delete', 'end'];
    return ROOT_VOCABULARY;
  }

  execute(rawLine: string): string {
    const line = rawLine.trim();
    if (line.length === 0) return '';

    if (line.endsWith('?')) return this.help().join('\n');

    const tokens = line.split(/\s+/);
    switch (tokens[0]) {
      case 'config': return this.enterTable(tokens.slice(1));
      case 'edit': return this.enterObject(tokens[1]);
      case 'next': return this.leaveObject();
      case 'end': return this.leaveTable();
      case 'set': return this.setAttribute(tokens.slice(1));
      case 'unset': return this.unsetAttribute(tokens[1]);
      case 'delete': return this.deleteObject(tokens[1]);
      case 'show': return this.show(tokens.slice(1));
      case 'get': return this.get(tokens.slice(1));
      case 'diagnose': return this.diagnose(tokens.slice(1));
      default: return FORTI_COMMAND_FAIL;
    }
  }

  private enterTable(rest: string[]): string {
    if (this.edited || rest[0] !== 'firewall') return FORTI_COMMAND_FAIL;
    if (rest[1] !== 'policy' && rest[1] !== 'address') return FORTI_COMMAND_FAIL;

    this.table = rest[1];
    return '';
  }

  private enterObject(name: string | undefined): string {
    if (this.table === undefined || this.edited || name === undefined) return FORTI_COMMAND_FAIL;

    const id = name === '0' && this.table === 'policy' ? this.nextPolicyId() : name;
    const key = `${this.table}:${id}`;
    const existing = this.stored.get(key);

    this.edited = existing ?? { table: this.table, id, attributes: new Map() };
    this.stored.set(key, this.edited);
    return '';
  }

  private nextPolicyId(): string {
    let candidate = 1;
    while (this.stored.has(`policy:${candidate}`)) candidate++;
    return String(candidate);
  }

  private leaveObject(): string {
    if (!this.edited) return FORTI_COMMAND_FAIL;

    this.commit(this.edited);
    this.edited = undefined;
    return '';
  }

  private leaveTable(): string {
    if (this.edited) this.leaveObject();
    this.table = undefined;
    return '';
  }

  private setAttribute(rest: string[]): string {
    const object = this.edited;
    if (!object) return FORTI_COMMAND_FAIL;

    const attribute = rest[0];
    const values = rest.slice(1).map(stripQuotes);
    const known = object.table === 'policy' ? POLICY_ATTRIBUTES : ADDRESS_ATTRIBUTES;
    if (attribute === undefined || !known.has(attribute)) return FORTI_COMMAND_FAIL;
    if (values.length === 0) return FORTI_COMMAND_FAIL;

    object.attributes.set(attribute, values);
    return '';
  }

  private unsetAttribute(attribute: string | undefined): string {
    const object = this.edited;
    if (!object || attribute === undefined) return FORTI_COMMAND_FAIL;

    object.attributes.delete(attribute);
    return '';
  }

  private deleteObject(name: string | undefined): string {
    if (this.table === undefined || name === undefined) return FORTI_COMMAND_FAIL;

    this.stored.delete(`${this.table}:${name}`);
    if (this.table === 'policy') this.fw.getPolicyStore().remove(name);
    else this.fw.getObjectStore().removeAddress(name);
    return '';
  }

  private commit(object: EditedObject): void {
    if (object.table === 'policy') this.commitPolicy(object);
    else this.commitAddress(object);
  }

  private commitPolicy(object: EditedObject): void {
    const attribute = (name: string): string[] | undefined => object.attributes.get(name);
    const action = attribute('action')?.[0] === 'deny' ? 'deny' : 'allow';

    this.fw.getPolicyStore().remove(object.id);
    this.fw.getPolicyStore().append({
      id: object.id,
      name: attribute('name')?.[0],
      from: attribute('srcintf') ?? ['any'],
      to: attribute('dstintf') ?? ['any'],
      source: normaliseAny(attribute('srcaddr')),
      destination: normaliseAny(attribute('dstaddr')),
      service: normaliseAny(attribute('service')),
      action,
      enabled: attribute('status')?.[0] !== 'disable',
      natEnabled: attribute('nat')?.[0] === 'enable',
      comment: attribute('comments')?.[0],
    });
  }

  private commitAddress(object: EditedObject): void {
    const subnet = object.attributes.get('subnet');
    if (!subnet || subnet.length < 2) return;

    this.fw.getObjectStore().addAddress({
      name: object.id, kind: 'subnet', family: 'ipv4',
      value: subnet[0], careMask: subnet[1], predefined: false, tags: [],
    });
  }

  private show(rest: string[]): string {
    if (rest[0] !== 'firewall') return FORTI_COMMAND_FAIL;
    if (rest[1] === 'policy') return this.showPolicies();
    if (rest[1] === 'address') return this.showAddresses();
    return FORTI_COMMAND_FAIL;
  }

  private showPolicies(): string {
    const lines = ['config firewall policy'];
    for (const object of this.stored.values()) {
      if (object.table !== 'policy') continue;

      lines.push(`    edit ${object.id}`);
      for (const [attribute, values] of object.attributes) {
        lines.push(`        set ${attribute} ${renderValues(attribute, values)}`);
      }
      lines.push('    next');
    }
    lines.push('end');
    return lines.join('\n');
  }

  private showAddresses(): string {
    const lines = ['config firewall address'];
    for (const object of this.stored.values()) {
      if (object.table !== 'address') continue;

      lines.push(`    edit "${object.id}"`);
      for (const [attribute, values] of object.attributes) {
        lines.push(`        set ${attribute} ${values.join(' ')}`);
      }
      lines.push('    next');
    }
    lines.push('end');
    return lines.join('\n');
  }

  private get(rest: string[]): string {
    if (rest[0] !== 'system' || rest[1] !== 'status') return FORTI_COMMAND_FAIL;

    return [
      `Version: FortiGate-VM64 v${FORTIOS_PROFILE.defaultVersion},build2662`,
      `Hostname: ${this.fw.getName()}`,
      'Operation Mode: NAT',
      'Current virtual domain: root',
    ].join('\n');
  }

  private diagnose(rest: string[]): string {
    if (rest[0] !== 'sys' || rest[1] !== 'session') return FORTI_COMMAND_FAIL;
    if (rest[2] === 'stat') return this.sessionStat();
    if (rest[2] !== 'list') return FORTI_COMMAND_FAIL;

    const sessions = this.fw.getSessionTable().view().all();
    return sessions.map(session =>
      `session info: proto=${session.c2s.protocol} proto_state=00`
      + ` duration=0 expire=${session.timeoutSec} timeout=${session.timeoutSec}\n`
      + `hook=post dir=org act=noop`
      + ` ${session.c2s.sourceIP}:${session.c2s.sourcePort}`
      + `->${session.c2s.destIP}:${session.c2s.destPort}`).join('\n');
  }

  private sessionStat(): string {
    const count = this.fw.getSessionTable().count();
    return `misc info: session_count=${count}`;
  }
}

function normaliseAny(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return ['any'];
  return values.map(value => (value.toLowerCase() === 'all' ? 'any' : value));
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, '');
}

const UNQUOTED_ATTRIBUTES = new Set(['action', 'nat', 'status']);

function renderValues(attribute: string, values: string[]): string {
  if (UNQUOTED_ATTRIBUTES.has(attribute)) return values.join(' ');
  return values.map(value => `"${value}"`).join(' ');
}
