import { simulationNowMs } from '@/network/core/SystemClock';

export const IPSET_VERSION = '7.15';
export const IPSET_PROTOCOL = 7;

const PROGRAM = `ipset v${IPSET_VERSION}`;
const DEFAULT_HASHSIZE = 1024;
const DEFAULT_MAXELEM = 65536;
const BUCKETSIZE = 12;
const RANGE_LIMIT = 65536;

type SetType = 'hash:ip' | 'hash:net' | 'hash:ip,port';
type Family = 'inet' | 'inet6';

const TYPES: Readonly<Record<SetType, { revision: number; aliases: readonly string[] }>> = {
  'hash:ip': { revision: 5, aliases: ['iphash'] },
  'hash:net': { revision: 7, aliases: ['nethash'] },
  'hash:ip,port': { revision: 6, aliases: ['ipporthash'] },
};

export class IpsetError extends Error {
  constructor(message: string, readonly status = 1) {
    super(message);
  }
}

interface Entry {
  readonly text: string;
  readonly address: string;
  readonly cidr: number;
  readonly protocol: string;
  readonly port: number;
  expiresAt: number | null;
  comment: string | null;
}

interface IpSet {
  name: string;
  readonly type: SetType;
  readonly family: Family;
  readonly hashsize: number;
  readonly maxelem: number;
  readonly netmask: number | null;
  readonly timeout: number | null;
  readonly comment: boolean;
  readonly forceadd: boolean;
  readonly initval: string;
  elements: Map<string, Entry>;
  nextExpiry: number;
}

export type IpsetResult = { readonly output: string; readonly exitCode: number };

export interface IpsetEnvironment {
  readonly servicePort: (name: string, protocol: string) => number | null;
  readonly references: (setName: string) => number;
}

function ipv4ToNumber(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

function isIpv6(text: string): boolean {
  return text.includes(':') && /^[0-9a-f:.]+$/i.test(text);
}

function initvalOf(name: string): string {
  let hash = 2166136261;
  for (const ch of name) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `0x${hash.toString(16).padStart(8, '0')}`;
}

function maskV4(value: number, bits: number): number {
  if (bits === 0) return 0;
  return Math.floor(value / 2 ** (32 - bits)) * 2 ** (32 - bits);
}

export class IpsetManager {
  private readonly sets = new Map<string, IpSet>();

  constructor(private readonly environment: IpsetEnvironment) {}

  hasSet(name: string): boolean {
    return this.sets.has(name);
  }

  setNames(): string[] {
    return [...this.sets.keys()];
  }

  dimensionOf(name: string): number | null {
    const set = this.sets.get(name);
    if (set === undefined) return null;
    return set.type === 'hash:ip,port' ? 2 : 1;
  }

  contains(name: string, address: string, port?: { protocol: string; port: number }): boolean {
    const set = this.sets.get(name);
    if (set === undefined) return false;
    this.purge(set);
    return this.hasElement(set, address, 32, port ?? null);
  }

  addAddress(name: string, address: string, port: { protocol: string; port: number } | null, exist: boolean, timeout: number | null): void {
    const set = this.sets.get(name);
    if (set === undefined) return;
    this.purge(set);
    try {
      const text = port === null ? address : `${address},${port.protocol}:${port.port}`;
      this.addElements(set, this.parseElement(set, text), exist, timeout, null);
    } catch {
      return;
    }
  }

  removeAddress(name: string, address: string, port: { protocol: string; port: number } | null): void {
    const set = this.sets.get(name);
    if (set === undefined) return;
    try {
      const text = port === null ? address : `${address},${port.protocol}:${port.port}`;
      this.removeElements(set, this.parseElement(set, text), true);
    } catch {
      return;
    }
  }

  execute(args: readonly string[], stdin?: string): IpsetResult {
    try {
      return this.run(args, stdin);
    } catch (error) {
      if (error instanceof IpsetError) return { output: error.message, exitCode: error.status };
      throw error;
    }
  }

  private run(args: readonly string[], stdin: string | undefined): IpsetResult {
    const options = { exist: false, names: false, terse: false, quiet: false, save: false, xml: false };
    const words: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-exist' || arg === '-!') options.exist = true;
      else if (arg === '-n' || arg === '-name') options.names = true;
      else if (arg === '-t' || arg === '-terse') options.terse = true;
      else if (arg === '-q' || arg === '-quiet') options.quiet = true;
      else if (arg === '-s' || arg === '-sorted') continue;
      else if (arg === '-o' || arg === '-output') {
        const format = args[++i];
        options.save = format === 'save';
        options.xml = format === 'xml';
      }
      else words.push(arg);
    }
    const command = words[0];
    if (command === undefined) return this.parameterProblem('No command specified.');
    const operands = words.slice(1);
    switch (command) {
      case 'create': case 'n': case '-N': return this.create(operands, options.exist);
      case 'add': case 'a': case '-A': return this.add(operands, options.exist);
      case 'del': case 'd': case '-D': return this.del(operands, options.exist);
      case 'test': case 't': case '-T': return this.test(operands, options.quiet);
      case 'destroy': case 'x': case '-X': return this.destroy(operands);
      case 'flush': case 'f': case '-F': return this.flush(operands);
      case 'rename': case 'e': case '-E': return this.rename(operands);
      case 'swap': case 'w': case '-W': return this.swap(operands);
      case 'list': case 'l': case '-L': return this.list(operands, options);
      case 'save': case 's': case '-S': return this.save(operands);
      case 'restore': case 'r': case '-R': return this.restore(stdin ?? '', options.exist);
      case 'version': case 'v': case '-V': return { output: `ipset v${IPSET_VERSION}, protocol version: ${IPSET_PROTOCOL}`, exitCode: 0 };
      case 'help': case 'h': case '-H': return { output: `${PROGRAM}\n\nUsage: ipset [options] COMMAND\n\nCommands:\ncreate SETNAME TYPENAME [type-specific-options]\nadd SETNAME ENTRY\ndel SETNAME ENTRY\ntest SETNAME ENTRY\ndestroy [SETNAME]\nflush [SETNAME]\nlist [SETNAME]\nsave [SETNAME]\nrestore\nrename FROM-SETNAME TO-SETNAME\nswap FROM-SETNAME TO-SETNAME\nversion`, exitCode: 0 };
      default: throw new IpsetError(`${PROGRAM}: No command specified: unknown argument ${command}\nTry \`ipset help' for more information.`, 2);
    }
  }

  private parameterProblem(message: string): never {
    throw new IpsetError(`${PROGRAM}: ${message}\nTry \`ipset help' for more information.`, 2);
  }

  private fail(message: string): never {
    throw new IpsetError(`${PROGRAM}: ${message}`);
  }

  private find(name: string | undefined): IpSet {
    if (name === undefined) this.parameterProblem('Missing mandatory argument(s)');
    const set = this.sets.get(name as string);
    if (set === undefined) this.fail('The set with the given name does not exist');
    return set as IpSet;
  }

  private typeOf(name: string): SetType | null {
    for (const [type, { aliases }] of Object.entries(TYPES)) {
      if (type === name || aliases.includes(name)) return type as SetType;
    }
    return null;
  }

  private create(operands: readonly string[], exist: boolean): IpsetResult {
    const [name, typeName, ...rest] = operands;
    if (name === undefined || typeName === undefined) this.parameterProblem('Missing mandatory argument(s)');
    const type = this.typeOf(typeName as string);
    if (type === null) this.parameterProblem(`Unknown set type: \`${typeName}'`);
    let family: Family = 'inet';
    let hashsize = DEFAULT_HASHSIZE;
    let maxelem = DEFAULT_MAXELEM;
    let netmask: number | null = null;
    let timeout: number | null = null;
    let comment = false;
    let forceadd = false;
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i];
      const numeric = (): number => {
        const value = Number(rest[++i]);
        if (!Number.isInteger(value) || value < 0) this.parameterProblem(`Syntax error: cannot parse '${rest[i]}': FAILED`);
        return value;
      };
      if (word === 'family') {
        const given = rest[++i];
        if (given !== 'inet' && given !== 'inet6') this.parameterProblem(`Syntax error: unknown family '${given}'`);
        family = given as Family;
      } else if (word === 'inet' || word === 'inet6') family = word;
      else if (word === 'hashsize') hashsize = numeric();
      else if (word === 'maxelem') maxelem = numeric();
      else if (word === 'netmask' && type === 'hash:ip') netmask = numeric();
      else if (word === 'timeout') timeout = numeric();
      else if (word === 'comment') comment = true;
      else if (word === 'forceadd') forceadd = true;
      else if (word === 'counters' || word === 'skbinfo') {
        this.parameterProblem(`\`${word}' is not supported by this simulator`);
      } else if (word === 'bucketsize' || word === 'initval' || word === 'probes' || word === 'resize' || word === 'gc') i++;
      else this.parameterProblem(`Unknown argument: \`${word}'`);
    }
    if (this.sets.has(name as string)) {
      if (exist) return { output: '', exitCode: 0 };
      this.fail('Set cannot be created: set with the same name already exists');
    }
    this.sets.set(name as string, {
      name: name as string, type: type as SetType, family, hashsize, maxelem, netmask, timeout, comment, forceadd,
      initval: initvalOf(name as string), elements: new Map(), nextExpiry: Infinity,
    });
    return { output: '', exitCode: 0 };
  }

  private parseElement(set: IpSet, text: string): { entries: Entry[]; tested: Entry | null } {
    const [addressPart, portPart] = set.type === 'hash:ip,port' ? text.split(',') : [text, undefined];
    if (set.type === 'hash:ip,port' && portPart === undefined) this.parameterProblem(`Syntax error: Missing separator from ${text}`);
    const ports = portPart === undefined ? [{ protocol: '', port: 0 }] : this.parsePorts(portPart);
    const addresses = this.parseAddresses(set, addressPart);
    const entries: Entry[] = [];
    for (const address of addresses) {
      for (const port of ports) {
        const body = address.cidr === (set.family === 'inet6' ? 128 : 32) || set.type !== 'hash:net'
          ? address.address : `${address.address}/${address.cidr}`;
        entries.push({
          text: set.type === 'hash:ip,port' ? `${body},${port.protocol}:${port.port}` : body,
          address: address.address, cidr: address.cidr, protocol: port.protocol, port: port.port, expiresAt: null, comment: null,
        });
      }
    }
    return { entries, tested: entries.length === 1 ? entries[0] : null };
  }

  private parsePorts(text: string): Array<{ protocol: string; port: number }> {
    let protocol = 'tcp';
    let spec = text;
    const colon = text.indexOf(':');
    if (colon >= 0) {
      protocol = text.slice(0, colon).toLowerCase();
      if (!['tcp', 'udp', 'sctp', 'udplite'].includes(protocol)) this.parameterProblem(`Syntax error: cannot parse '${text}' as a protocol`);
      spec = text.slice(colon + 1);
    }
    const [from, to] = spec.split('-');
    const resolve = (name: string): number => {
      if (/^\d+$/.test(name) && Number(name) <= 65535) return Number(name);
      const found = this.environment.servicePort(name, protocol);
      if (found === null) this.parameterProblem(`Syntax error: cannot parse '${name}' as a tcp port`);
      return found as number;
    };
    const first = resolve(from);
    const last = to === undefined ? first : resolve(to);
    if (last < first) this.parameterProblem(`Syntax error: cannot parse '${text}': invalid range`);
    return Array.from({ length: last - first + 1 }, (_, i) => ({ protocol, port: first + i }));
  }

  private parseAddresses(set: IpSet, text: string): Array<{ address: string; cidr: number }> {
    const v6 = set.family === 'inet6';
    const bad = (): never => this.parameterProblem(`Syntax error: cannot parse ${text}: resolving to IPv${v6 ? 6 : 4} address failed`);
    if (v6) {
      const [address, cidrText] = text.split('/');
      if (!isIpv6(address)) bad();
      const cidr = cidrText === undefined ? 128 : Number(cidrText);
      if (!Number.isInteger(cidr) || cidr < 0 || cidr > 128) this.fail('The value of the CIDR parameter of the IP address is invalid');
      return [{ address: address.toLowerCase(), cidr }];
    }
    const netmaskBits = set.netmask ?? 32;
    const normalise = (value: number, cidr: number): { address: string; cidr: number } =>
      ({ address: numberToIpv4(maskV4(value, set.type === 'hash:net' ? cidr : netmaskBits)), cidr });
    if (text.includes('-')) {
      const [from, to] = text.split('-');
      const low = ipv4ToNumber(from);
      const high = ipv4ToNumber(to);
      if (low === null || high === null) bad();
      if (set.type === 'hash:net') return this.coverRange(low as number, high as number);
      if ((high as number) - (low as number) >= RANGE_LIMIT * 16) this.fail('The specified range is too large, split it up into smaller ranges');
      return Array.from({ length: (high as number) - (low as number) + 1 }, (_, i) => normalise((low as number) + i, 32));
    }
    const [addressText, cidrText] = text.split('/');
    const value = ipv4ToNumber(addressText);
    if (value === null) bad();
    if (cidrText === undefined) return [normalise(value as number, 32)];
    const cidr = Number(cidrText);
    if (!Number.isInteger(cidr) || cidr < 0 || cidr > 32) this.fail('The value of the CIDR parameter of the IP address is invalid');
    if (set.type === 'hash:net') return [normalise(value as number, cidr)];
    const base = maskV4(value as number, cidr);
    const count = 2 ** (32 - cidr);
    if (count > RANGE_LIMIT) this.fail('The specified range is too large, split it up into smaller ranges');
    return Array.from({ length: count }, (_, i) => normalise(base + i, 32));
  }

  private coverRange(low: number, high: number): Array<{ address: string; cidr: number }> {
    const nets: Array<{ address: string; cidr: number }> = [];
    let current = low;
    while (current <= high) {
      let size = 1;
      while (current % (size * 2) === 0 && current + size * 2 - 1 <= high && size < 2 ** 32) size *= 2;
      nets.push({ address: numberToIpv4(current), cidr: 32 - Math.log2(size) });
      current += size;
    }
    return nets;
  }

  private purge(set: IpSet): void {
    if (set.timeout === null) return;
    const now = simulationNowMs();
    if (set.nextExpiry > now) return;
    let next = Infinity;
    for (const [key, entry] of set.elements) {
      if (entry.expiresAt === null) continue;
      if (entry.expiresAt <= now) set.elements.delete(key);
      else if (entry.expiresAt < next) next = entry.expiresAt;
    }
    set.nextExpiry = next;
  }

  private hasElement(set: IpSet, address: string, cidr: number, port: { protocol: string; port: number } | null): boolean {
    const candidate = set.type === 'hash:net' ? this.keyOfNetwork(address, cidr) : null;
    if (set.type !== 'hash:net') {
      const normalised = set.family === 'inet' && set.netmask !== null
        ? numberToIpv4(maskV4(ipv4ToNumber(address) ?? 0, set.netmask)) : address;
      const text = set.type === 'hash:ip,port' ? `${normalised},${port?.protocol ?? 'tcp'}:${port?.port ?? 0}` : normalised;
      return set.elements.has(text);
    }
    const value = ipv4ToNumber(address);
    if (value === null || candidate === null) return set.elements.has(address);
    for (const entry of set.elements.values()) {
      const start = ipv4ToNumber(entry.address);
      if (start === null) continue;
      const size = 2 ** (32 - entry.cidr);
      if (entry.cidr <= cidr && value >= start && value < start + size) return true;
    }
    return false;
  }

  private keyOfNetwork(address: string, cidr: number): string | null {
    const value = ipv4ToNumber(address);
    return value === null ? null : `${numberToIpv4(maskV4(value, cidr))}/${cidr}`;
  }

  private addElements(
    set: IpSet, parsed: { entries: Entry[] }, exist: boolean, timeout: number | null, comment: string | null,
  ): void {
    if (timeout !== null && set.timeout === null) this.fail('Timeout cannot be used: set was created without timeout support');
    if (comment !== null && !set.comment) this.fail('Comment cannot be used: set was created without comment support');
    const effective = timeout ?? set.timeout;
    const now = simulationNowMs();
    for (const entry of parsed.entries) {
      const present = set.elements.has(entry.text);
      if (present && !exist) this.fail("Element cannot be added to the set: it's already added");
      if (!present && set.elements.size >= set.maxelem) {
        if (!set.forceadd) this.fail('Hash is full, cannot add more elements');
        const oldest = set.elements.keys().next().value;
        if (oldest !== undefined) set.elements.delete(oldest);
      }
      const expiresAt = effective === null || effective === 0 ? null : now + effective * 1000;
      if (expiresAt !== null && expiresAt < set.nextExpiry) set.nextExpiry = expiresAt;
      set.elements.set(entry.text, { ...entry, expiresAt, comment });
    }
  }

  private removeElements(set: IpSet, parsed: { entries: Entry[] }, exist: boolean): void {
    for (const entry of parsed.entries) {
      if (!set.elements.delete(entry.text) && !exist) this.fail("Element cannot be deleted from the set: it's not added");
    }
  }

  private elementArguments(operands: readonly string[]): { element: string; timeout: number | null; comment: string | null } {
    const [, element, ...rest] = operands;
    if (element === undefined) this.parameterProblem('Missing mandatory argument(s)');
    let timeout: number | null = null;
    let comment: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === 'timeout') {
        timeout = Number(rest[++i]);
        if (!Number.isInteger(timeout) || timeout < 0) this.parameterProblem(`Syntax error: cannot parse '${rest[i]}': FAILED`);
      } else if (rest[i] === 'comment') comment = rest[++i] ?? '';
      else this.parameterProblem(`Unknown argument: \`${rest[i]}'`);
    }
    return { element: element as string, timeout, comment };
  }

  private add(operands: readonly string[], exist: boolean): IpsetResult {
    const set = this.find(operands[0]);
    this.purge(set);
    const { element, timeout, comment } = this.elementArguments(operands);
    this.addElements(set, this.parseElement(set, element), exist, timeout, comment);
    return { output: '', exitCode: 0 };
  }

  private del(operands: readonly string[], exist: boolean): IpsetResult {
    const set = this.find(operands[0]);
    this.purge(set);
    const { element } = this.elementArguments(operands);
    this.removeElements(set, this.parseElement(set, element), exist);
    return { output: '', exitCode: 0 };
  }

  private test(operands: readonly string[], quiet: boolean): IpsetResult {
    const set = this.find(operands[0]);
    this.purge(set);
    const { element } = this.elementArguments(operands);
    const parsed = this.parseElement(set, element);
    const found = parsed.entries.every((entry) => this.hasElement(
      set, entry.address, entry.cidr, set.type === 'hash:ip,port' ? { protocol: entry.protocol, port: entry.port } : null,
    ));
    if (quiet) return { output: '', exitCode: found ? 0 : 1 };
    return found
      ? { output: `Warning: ${element} is in set ${set.name}.`, exitCode: 0 }
      : { output: `${element} is NOT in set ${set.name}.`, exitCode: 1 };
  }

  private destroy(operands: readonly string[]): IpsetResult {
    if (operands[0] === undefined) {
      for (const name of this.sets.keys()) if (this.environment.references(name) > 0) this.fail('Set cannot be destroyed: it is in use by a kernel component');
      this.sets.clear();
      return { output: '', exitCode: 0 };
    }
    const set = this.find(operands[0]);
    if (this.environment.references(set.name) > 0) this.fail('Set cannot be destroyed: it is in use by a kernel component');
    this.sets.delete(set.name);
    return { output: '', exitCode: 0 };
  }

  private flush(operands: readonly string[]): IpsetResult {
    if (operands[0] === undefined) for (const set of this.sets.values()) set.elements.clear();
    else this.find(operands[0]).elements.clear();
    return { output: '', exitCode: 0 };
  }

  private rename(operands: readonly string[]): IpsetResult {
    const set = this.find(operands[0]);
    const target = operands[1];
    if (target === undefined) this.parameterProblem('Missing mandatory argument(s)');
    if (this.sets.has(target as string)) this.fail('Set cannot be renamed: a set with the new name already exists');
    if (this.environment.references(set.name) > 0) this.fail('Set cannot be renamed: it is in use by another system');
    this.sets.delete(set.name);
    set.name = target as string;
    this.sets.set(set.name, set);
    return { output: '', exitCode: 0 };
  }

  private swap(operands: readonly string[]): IpsetResult {
    const first = this.find(operands[0]);
    const secondName = operands[1];
    if (secondName === undefined) this.parameterProblem('Missing mandatory argument(s)');
    const second = this.sets.get(secondName as string);
    if (second === undefined) this.fail('Sets cannot be swapped: the second set does not exist');
    if (first.type !== (second as IpSet).type) this.fail('The sets cannot be swapped: their type does not match');
    const keep = first.elements;
    first.elements = (second as IpSet).elements;
    (second as IpSet).elements = keep;
    const keepExpiry = first.nextExpiry;
    first.nextExpiry = (second as IpSet).nextExpiry;
    (second as IpSet).nextExpiry = keepExpiry;
    return { output: '', exitCode: 0 };
  }

  private headerOf(set: IpSet): string {
    const parts = [`family ${set.family}`, `hashsize ${set.hashsize}`, `maxelem ${set.maxelem}`];
    if (set.netmask !== null) parts.push(`netmask ${set.netmask}`);
    if (set.timeout !== null) parts.push(`timeout ${set.timeout}`);
    if (set.comment) parts.push('comment');
    if (set.forceadd) parts.push('forceadd');
    parts.push(`bucketsize ${BUCKETSIZE}`, `initval ${set.initval}`);
    return parts.join(' ');
  }

  private memberText(set: IpSet, entry: Entry, now: number): string {
    let text = entry.text;
    if (set.timeout !== null) {
      const remaining = entry.expiresAt === null ? 0 : Math.max(0, Math.floor((entry.expiresAt - now) / 1000));
      text += ` timeout ${remaining}`;
    }
    if (entry.comment !== null) text += ` comment "${entry.comment}"`;
    return text;
  }

  private list(operands: readonly string[], options: { names: boolean; terse: boolean; save: boolean; xml: boolean }): IpsetResult {
    const targets = operands[0] === undefined ? [...this.sets.values()] : [this.find(operands[0])];
    if (options.names) return { output: targets.map((set) => set.name).join('\n'), exitCode: 0 };
    if (options.save) return this.save(operands);
    const now = simulationNowMs();
    if (options.xml) return this.xml(targets, options.terse, now);
    const blocks = targets.map((set) => {
      this.purge(set);
      const lines = [
        `Name: ${set.name}`, `Type: ${set.type}`, `Revision: ${TYPES[set.type].revision}`, `Header: ${this.headerOf(set)}`,
        `Size in memory: ${200 + 64 * set.elements.size}`, `References: ${this.environment.references(set.name)}`,
        `Number of entries: ${set.elements.size}`,
      ];
      if (!options.terse) lines.push('Members:', ...[...set.elements.values()].map((entry) => this.memberText(set, entry, now)));
      else lines.push('');
      return lines.join('\n').replace(/\n$/, '');
    });
    return { output: blocks.join('\n\n'), exitCode: 0 };
  }

  private xml(targets: readonly IpSet[], terse: boolean, now: number): IpsetResult {
    const lines = ['<ipsets>'];
    for (const set of targets) {
      this.purge(set);
      const header = [
        ['family', set.family], ['hashsize', set.hashsize], ['maxelem', set.maxelem],
        ...(set.netmask === null ? [] : [['netmask', set.netmask]]),
        ...(set.timeout === null ? [] : [['timeout', set.timeout]]),
        ['bucketsize', BUCKETSIZE], ['initval', set.initval],
      ].map(([name, value]) => `<${name}>${value}</${name}>`).join('');
      lines.push(
        `<ipset name="${set.name}">`, `<type>${set.type}</type>`, `<revision>${TYPES[set.type].revision}</revision>`,
        `<header>${header}`, `<memsize>${200 + 64 * set.elements.size}</memsize>`,
        `<references>${this.environment.references(set.name)}</references>`, `<numentries>${set.elements.size}</numentries>`,
        '</header>',
      );
      if (!terse) {
        lines.push('<members>');
        for (const entry of set.elements.values()) {
          const remaining = entry.expiresAt === null ? 0 : Math.max(0, Math.floor((entry.expiresAt - now) / 1000));
          lines.push(`<member><elem>${entry.text}</elem>${set.timeout === null ? '' : `<timeout>${remaining}</timeout>`}</member>`);
        }
        lines.push('</members>');
      }
      lines.push('</ipset>');
    }
    lines.push('</ipsets>');
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private save(operands: readonly string[]): IpsetResult {
    const targets = operands[0] === undefined ? [...this.sets.values()] : [this.find(operands[0])];
    const now = simulationNowMs();
    const lines: string[] = [];
    for (const set of targets) {
      this.purge(set);
      lines.push(`create ${set.name} ${set.type} ${this.headerOf(set)}`);
      for (const entry of set.elements.values()) lines.push(`add ${set.name} ${this.memberText(set, entry, now)}`);
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }

  private restore(input: string, exist: boolean): IpsetResult {
    for (const raw of input.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const words = line.match(/"[^"]*"|\S+/g)?.map((word) => word.replace(/^"|"$/g, '')) ?? [];
      if (words[0] === 'create') {
        const result = this.run(['-exist', ...words], undefined);
        if (result.exitCode !== 0) return result;
      } else if (words[0] === 'add' || words[0] === 'del') {
        const result = this.run(exist ? ['-exist', ...words] : words, undefined);
        if (result.exitCode !== 0) return result;
      } else if (['flush', 'destroy', 'rename', 'swap'].includes(words[0])) {
        const result = this.run(words, undefined);
        if (result.exitCode !== 0) return result;
      } else if (words[0] === 'COMMIT') continue;
      else this.parameterProblem(`Unknown argument: \`${words[0]}'`);
    }
    return { output: '', exitCode: 0 };
  }
}
