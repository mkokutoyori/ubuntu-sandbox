import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import type { AddressInfo, HostEntry, HostLookupFailure } from '../nss/HostLookup';
import { emit, outputOf, type ToolOutput } from '../kerberos/Krb5ToolOutput';

export type NameChange = 'ok' | 'EPERM' | 'EINVAL';

export interface InterfaceAddress {
  readonly loopback: boolean;
  readonly up: boolean;
  readonly family: 2 | 10;
  readonly address: string;
}

export interface HostnameHost {
  hostname(): string;
  setHostname(name: string): NameChange;
  domainName(): string;
  setDomainName(name: string): NameChange;
  readFile(path: string): { readonly text: string } | { readonly error: string };
  addressInfo(name: string): Promise<AddressInfo | HostLookupFailure>;
  hostByName(name: string): Promise<HostEntry | HostLookupFailure>;
  interfaceAddresses(): readonly InterfaceAddress[];
  nameOfAddress(address: string): Promise<string | null>;
}

type Kind = 'default' | 'dns' | 'fqdn' | 'short' | 'alias' | 'ip' | 'nis' | 'nis-default' | 'all-fqdns' | 'all-ips';

export const HOSTNAME_VERSION = '3.23';

const USAGE = [
  'Usage: hostname [-b] {hostname|-F file}         set host name (from file)',
  '       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name',
  '       hostname                                 display host name',
  '',
  '       {yp,nis,}domainname {nisdomain|-F file}  set NIS domain name (from file)',
  '       {yp,nis,}domainname                      display NIS domain name',
  '',
  '       dnsdomainname                            display dns domain name',
  '',
  '       hostname -V|--version|-h|--help          print info and exit',
  '',
  'Program name:',
  '       {yp,nis,}domainname=hostname -y',
  '       dnsdomainname=hostname -d',
  '',
  'Program options:',
  '    -a, --alias            alias names',
  '    -A, --all-fqdns        all long host names (FQDNs)',
  '    -b, --boot             set default hostname if none available',
  '    -d, --domain           DNS domain name',
  '    -f, --fqdn, --long     long host name (FQDN)',
  '    -F, --file             read host name or NIS domain name from given file',
  '    -i, --ip-address       addresses for the host name',
  '    -I, --all-ip-addresses all addresses for the host',
  '    -s, --short            short host name',
  '    -y, --yp, --nis        NIS/YP domain name',
  '',
  'Description:',
  '   This command can get or set the host name or the NIS domain name. You can',
  '   also get the DNS domain or the FQDN (fully qualified domain name).',
  '   Unless you are using bind or NIS for host lookups you can change the',
  '   FQDN (Fully Qualified Domain Name) and the DNS domain name (which is',
  '   part of the FQDN) in the /etc/hosts file.',
  '',
].join('\n');

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'domain', letter: 'd', takesArgument: false },
  { name: 'boot', letter: 'b', takesArgument: false },
  { name: 'file', letter: 'F', takesArgument: true },
  { name: 'fqdn', letter: 'f', takesArgument: false },
  { name: 'all-fqdns', letter: 'A', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'long', letter: 'f', takesArgument: false },
  { name: 'short', letter: 's', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'alias', letter: 'a', takesArgument: false },
  { name: 'ip-address', letter: 'i', takesArgument: false },
  { name: 'all-ip-addresses', letter: 'I', takesArgument: false },
  { name: 'nis', letter: 'y', takesArgument: false },
  { name: 'yp', letter: 'y', takesArgument: false },
];

const KIND_OF_LETTER: Readonly<Record<string, Kind>> = {
  d: 'dns', a: 'alias', f: 'fqdn', A: 'all-fqdns', i: 'ip', I: 'all-ips', s: 'short', y: 'nis-default',
};

const KIND_OF_PROGRAM: Readonly<Record<string, Kind>> = {
  dnsdomainname: 'dns', domainname: 'nis', ypdomainname: 'nis-default', nisdomainname: 'nis-default',
};

const NO_NAME = '(none)';
const SPACE = '[ \\t\\n\\v\\f\\r]';
const TRIM = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g');
const ALNUM = /^[A-Za-z0-9]$/;

export function isValidHostname(name: string): boolean {
  if (name.length === 0 || !ALNUM.test(name[0]) || !ALNUM.test(name[name.length - 1])) return false;
  for (let i = 0; i < name.length; i++) {
    const letter = name[i];
    if (!ALNUM.test(letter) && letter !== '-' && letter !== '.') return false;
    if (letter === '-' && (name[i - 1] === '.' || name[i + 1] === '.')) return false;
    if (letter === '.' && name[i - 1] === '.') return false;
  }
  return true;
}

function firstNameInFile(text: string): string {
  let last = '';
  let from = 0;
  while (from < text.length) {
    const end = text.indexOf('\n', from);
    const line = end < 0 ? text.slice(from) : text.slice(from, end + 1);
    from = end < 0 ? text.length : end + 1;
    last = line;
    if (line.startsWith('\n') || line.startsWith('#')) continue;
    return end < 0 ? line : line.slice(0, line.length - 1);
  }
  return last;
}

function isLinkLocalOrMulticastLinkLocal(address: string): boolean {
  const first = address.split(':')[0];
  const word = first === '' ? 0 : parseInt(first, 16);
  return (word & 0xffc0) === 0xfe80 || ((word & 0xff00) === 0xff00 && (word & 0x000f) === 2);
}

export async function runHostname(argv0: string, args: readonly string[], host: HostnameHost): Promise<ToolOutput> {
  const out = outputOf();
  const write = (fd: 1 | 2, text: string): void => emit(out, fd === 1 ? 'stdout' : 'stderr', text);
  const program = argv0.slice(argv0.lastIndexOf('/') + 1);
  const finish = (status: number): ToolOutput => { out.exitCode = status; return out; };
  const usage = (fd: 1 | 2): ToolOutput => { write(fd, USAGE); return finish(255); };
  const fail = (message: string): ToolOutput => { write(2, `${program}: ${message}\n`); return finish(1); };

  let kind: Kind = KIND_OF_PROGRAM[program] ?? 'default';
  let file: string | null = null;
  let boot = false;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'aAdfbF:h?iIsVy', LONG_OPTIONS)) {
    if (item.kind === 'operand') {
      operands.push(item.value);
    } else if (item.kind === 'option') {
      if (item.letter === 'V') {
        write(1, `hostname ${HOSTNAME_VERSION}\n`);
        return finish(0);
      }
      if (item.letter === 'h' || item.letter === '?') return usage(1);
      if (item.letter === 'b') boot = true;
      else if (item.letter === 'F') file = item.argument ?? '';
      else kind = KIND_OF_LETTER[item.letter] ?? kind;
    } else {
      write(2, `${getoptDiagnostic(argv0, item)}\n`);
      return usage(1);
    }
  }

  let name: string | null = null;
  if (file !== null) {
    const read = host.readFile(file);
    if ('error' in read) {
      if (!boot) return fail(read.error);
    } else {
      name = firstNameInFile(read.text);
    }
    if (boot && (name === null || name === '')) {
      name = host.hostname();
      if (name === '' || name === NO_NAME) name = 'localhost';
    }
  }

  if (operands.length > 0) {
    if (name !== null) return usage(2);
    name = operands.shift() as string;
  }
  if (operands.length > 0) return usage(2);

  return name === null ? showName(kind) : setName(kind, name);

  function setName(type: Kind, value: string): ToolOutput {
    if (type === 'default') {
      const trimmed = value.replace(TRIM, '');
      if (!isValidHostname(trimmed)) return fail('the specified hostname is invalid');
      const outcome = host.setHostname(trimmed);
      if (outcome === 'EPERM') return fail('you must be root to change the host name');
      if (outcome === 'EINVAL') return fail('name too long');
      return finish(0);
    }
    if (type === 'nis' || type === 'nis-default') {
      const outcome = host.setDomainName(value);
      if (outcome === 'EPERM') return fail('you must be root to change the domain name');
      if (outcome === 'EINVAL') return fail('name too long');
      return finish(0);
    }
    return usage(2);
  }

  async function showName(type: Kind): Promise<ToolOutput> {
    switch (type) {
      case 'default':
        write(1, `${host.hostname()}\n`);
        return finish(0);
      case 'short':
        write(1, `${host.hostname().split('.')[0]}\n`);
        return finish(0);
      case 'nis':
        write(1, `${host.domainName()}\n`);
        return finish(0);
      case 'nis-default': {
        const domain = host.domainName();
        if (domain === NO_NAME) {
          write(1, `${program}: Local domain name not set\n`);
          return finish(1);
        }
        write(1, `${domain}\n`);
        return finish(0);
      }
      case 'all-ips':
      case 'all-fqdns': {
        let line = '';
        for (const entry of host.interfaceAddresses()) {
          if (entry.loopback || !entry.up) continue;
          if (entry.family === 10 && isLinkLocalOrMulticastLinkLocal(entry.address)) continue;
          const text = type === 'all-ips' ? entry.address : await host.nameOfAddress(entry.address);
          if (text !== null) line += `${text} `;
        }
        write(1, `${line}\n`);
        return finish(0);
      }
      default:
        return showResolved(type);
    }
  }

  async function showResolved(type: Kind): Promise<ToolOutput> {
    const own = host.hostname();
    const info = await host.addressInfo(own);
    if ('failure' in info) return fail(info.failure);
    if (type === 'alias') {
      const entry = await host.hostByName(own);
      if ('failure' in entry) return fail(entry.failure);
      write(1, `${entry.aliases.join(' ')}\n`);
    } else if (type === 'ip') {
      write(1, `${info.addresses.join(' ')}\n`);
    } else if (type === 'dns') {
      const dot = info.canonicalName.indexOf('.');
      if (dot >= 0) write(1, `${info.canonicalName.slice(dot + 1)}\n`);
    } else if (type === 'fqdn') {
      write(1, `${info.canonicalName}\n`);
    }
    return finish(0);
  }
}
