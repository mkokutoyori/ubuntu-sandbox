/*
 * hostname against the real tool (hostname 3.23+nmu2ubuntu2 of Ubuntu 24.04, whose domainname, dnsdomainname, ypdomainname and nisdomainname are the same binary run under another name):
 * scripts/oracle/record_hostname.py runs the real binary in a private UTS, mount and network namespace for 19 scenarios and stores, for each of 538 invocations, stdout, stderr and the exit status. A scenario
 * fixes the host name, /etc/hosts, the hosts line of /etc/nsswitch.conf, /etc/resolv.conf, the interfaces (bridges: the kernel has no dummy driver) with their addresses and state, and a one-socket DNS
 * responder when the dns source is exercised. The replay builds a LinuxPC with the same facts and runs the same argv, as root or as nobody (65534) like the recording, in the recorded order (the invocations
 * that set a name come after the ones that read it), and compares stdout, stderr and the status.
 * What the recording measured: usage goes to stdout with status 255 for -h, -?, --help and for any option error (the getopt message goes to stderr first); long options may be abbreviated and an ambiguous
 * prefix lists its candidates in the order of the long_options table; the last of -a -A -d -f -i -I -s -y wins; a host name is trimmed, then checked by RFC 1035 (alphanumeric ends, no `-` or `.` beside a `.`) and
 * set by sethostname (64 bytes at most, root only) while a NIS domain name is set as typed; -F reads the first line that is neither empty nor a comment and, when the file ends on such a line, that last
 * line; -b replaces an unreadable or empty file by the current name; -f prints the canonical name getaddrinfo returns (first line of /etc/hosts that holds the name, case-insensitively; the end of a CNAME
 * chain in the DNS) and -d what follows its first dot (nothing, not even a newline, without a dot); -i prints every address of the name in the order getaddrinfo sorts them (RFC 3484 as glibc does: a
 * destination with no route last, loopback and link-local before global); -a prints the aliases gethostbyname returns, merging the lines of /etc/hosts that hold the name (`multi on` of /etc/host.conf);
 * -I and -A walk the addresses of the interfaces that are up and not loopback, print each followed by a space, and -A prints only those with a reverse name; -y says `Local domain name not set` on stdout, status 1.
 * The DNS scenarios replay the nameserver as a test double of the wire (the source asks it for A, AAAA and PTR records); IPv6 addresses cannot be put on an interface where the recording kernel has none,
 * so the IPv6 cases are the names held by /etc/hosts only (see probe-hostname-ipv6-interfaces.test.ts for the interface side, read from hostname.c).
 * Measured before the change (git stash push -- src/network src/powershell): 19 of 19 scenarios fail, at least 395 of their 522 invocations different (the old command answered a constant 127.0.1.1 for -i
 * and -I, the name itself for -A, knew neither the NIS domain name nor the aliases nor the usage, and accepted any name); the WITNESS passes either way, it only counts the fixture. The three host.conf
 * scenarios (`multi off`, no file, `multi on` with repeated lines) were recorded after a first measurement exposed the single-entry rule.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import { makeARecord, makeCnameRecord, makePtrRecord } from '@/network/dns/wire/ResourceRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { ptrQName } from '@/network/dns/compat/DnsWireCompat';
import { parseResolvConf } from '@/network/devices/linux/nss/ResolvConf';
import type { DnsNssSource } from '@/network/devices/linux/nss/DnsNssSource';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Executor {
  readonly vfs: VirtualFileSystem;
  readonly dnsNss: DnsNssSource;
  runAsUser<T>(user: string, work: () => Promise<T>): Promise<T>;
}
const executorOf = (pc: LinuxPC): Executor => (pc as unknown as { executor: Executor }).executor;

interface Run { readonly prog: string; readonly argv: readonly string[]; readonly uid: number; readonly stdout: string; readonly stderr: string; readonly rc: number }
interface Dns {
  readonly A: Readonly<Record<string, readonly string[]>>;
  readonly CNAME: Readonly<Record<string, string>>;
  readonly PTR: Readonly<Record<string, string>>;
}
interface Setup {
  readonly name: string;
  readonly hostname: string;
  readonly nsswitch: string;
  readonly hosts: readonly string[];
  readonly resolv?: readonly string[];
  readonly host_conf?: readonly string[] | null;
  readonly dns?: Dns;
  readonly interfaces: readonly { readonly name: string; readonly addrs: readonly string[]; readonly up: boolean }[];
  readonly routes?: readonly (readonly string[])[];
  readonly files: Readonly<Record<string, string>>;
}
interface Scenario { readonly setup: Setup; readonly runs: readonly Run[] }

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/hostname-3.23.json', import.meta.url), 'utf8')) as { readonly scenarios: readonly Scenario[] };

const DNS_SERVER = '10.53.53.53';
const NOBODY = 65534;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function response(name: string, qtype: number, answers: DnsMessage['answers'], rcode: number): DnsMessage {
  return {
    id: 1,
    flags: { qr: true, opcode: 0, aa: false, tc: false, rd: true, ra: true, ad: false, cd: false, rcode },
    questions: [{ qname: name, qtype, qclass: 1 }],
    answers,
    authorities: [],
    additionals: [],
  };
}

function answerFrom(table: Dns, name: string, qtype: 'A' | 'AAAA' | 'PTR'): DnsMessage {
  const asked = qtype === 'PTR' ? ptrQName(name).replace(/\.$/, '') : name;
  const wanted = qtype === 'A' ? RRType.A : qtype === 'AAAA' ? RRType.AAAA : RRType.PTR;
  const records: DnsMessage['answers'][number][] = [];
  let target = asked.toLowerCase();
  const cname = table.CNAME[target];
  if (cname !== undefined) {
    records.push(makeCnameRecord(target, 60, cname));
    target = cname;
  }
  if (qtype === 'A') for (const address of table.A[target] ?? []) records.push(makeARecord(target, 60, address));
  if (qtype === 'PTR' && table.PTR[target] !== undefined) records.push(makePtrRecord(target, 60, table.PTR[target]));
  const known = cname !== undefined || table.A[target] !== undefined || table.PTR[target] !== undefined;
  return response(asked, wanted, records, records.length > 0 || known ? DnsRcode.NOERROR : DnsRcode.NXDOMAIN);
}

async function build(setup: Setup): Promise<LinuxPC> {
  const pc = new LinuxPC('H', 0, 0);
  const executor = executorOf(pc);
  const vfs = executor.vfs;
  pc.setHostname(setup.hostname);
  for (const [index, entry] of setup.interfaces.entries()) {
    const name = `eth${index}`;
    for (const cidr of entry.addrs) await pc.executeCommand(`ip addr add ${cidr} dev ${name}`);
    await pc.executeCommand(`ip link set ${name} ${entry.up ? 'up' : 'down'}`);
  }
  if (setup.host_conf === null) await executor.runAsUser('root', () => pc.executeCommand('rm /etc/host.conf'));
  else if (setup.host_conf !== undefined) vfs.writeFile('/etc/host.conf', `${setup.host_conf.join('\n')}\n`, 0, 0, 0o022);
  for (const route of setup.routes ?? []) await pc.executeCommand(`ip route add default via ${route[2]}`);
  vfs.writeFile('/etc/hosts', `${setup.hosts.join('\n')}\n`, 0, 0, 0o022);
  const switchText = vfs.readFile('/etc/nsswitch.conf') ?? '';
  vfs.writeFile('/etc/nsswitch.conf', switchText.replace(/^hosts:.*$/m, setup.nsswitch), 0, 0, 0o022);
  vfs.writeFile('/etc/resolv.conf', `${(setup.resolv ?? ['options timeout:1 attempts:1']).join('\n')}\n`, 0, 0, 0o022);
  for (const [path, content] of Object.entries(setup.files)) {
    vfs.mkdirp(path.slice(0, path.lastIndexOf('/')), 0o755, 0, 0);
    vfs.writeFile(path, content, 0, 0, 0o022);
  }
  const table = setup.dns;
  executor.dnsNss.setWireResolver({
    nameservers: () => parseResolvConf(vfs.readFile('/etc/resolv.conf') ?? '').nameservers,
    searchDomains: () => parseResolvConf(vfs.readFile('/etc/resolv.conf') ?? '').search,
    ndots: () => parseResolvConf(vfs.readFile('/etc/resolv.conf') ?? '').ndots,
    query: (server, name, qtype) => (server === DNS_SERVER && table !== undefined ? answerFrom(table, name, qtype) : null),
  });
  return pc;
}

const shellWord = (word: string): string => (word === '' || /[^A-Za-z0-9_./=:@%+,-]/.test(word) ? `'${word.replace(/'/g, `'\\''`)}'` : word);

async function replay(pc: LinuxPC, run: Run): Promise<{ stdout: string; stderr: string; rc: number }> {
  const words = [run.prog, ...run.argv].map(shellWord).join(' ');
  const out = `/tmp/replay.${run.uid}.out`;
  const err = `/tmp/replay.${run.uid}.err`;
  const script = `${words} 2>${err} >${out}; echo "rc=$?"; cat ${out}; echo ---; cat ${err}`;
  const text = await executorOf(pc).runAsUser(run.uid === 0 ? 'root' : 'nobody', () => pc.executeCommand(script));
  const [head, ...rest] = text.split('\n');
  const body = rest.join('\n');
  const split = body.lastIndexOf('---');
  return { rc: Number(head.replace('rc=', '')), stdout: body.slice(0, split), stderr: body.slice(split + 4) };
}

describe('hostname against the real tool', () => {
  it('WITNESS: the fixture holds the recorded scenarios and every program name', () => {
    expect(fixture.scenarios.map((scenario) => scenario.setup.name)).toHaveLength(19);
    const runs = fixture.scenarios.flatMap((scenario) => scenario.runs);
    expect(runs).toHaveLength(538);
    expect(new Set(runs.map((run) => run.prog))).toEqual(new Set(['hostname', 'domainname', 'dnsdomainname', 'ypdomainname', 'nisdomainname']));
    expect(runs.some((run) => run.uid === NOBODY)).toBe(true);
    expect(runs.some((run) => run.rc === 255)).toBe(true);
  });

  for (const scenario of fixture.scenarios) {
    it(`${scenario.setup.name}: every invocation prints and returns what the real tool does`, async () => {
      const pc = await build(scenario.setup);
      const differing: string[] = [];
      for (const run of scenario.runs) {
        const got = await replay(pc, run);
        const normal = (text: string): string => text.replace(/\n$/, '');
        if (normal(got.stdout) !== normal(run.stdout) || normal(got.stderr) !== normal(run.stderr) || got.rc !== run.rc) {
          differing.push([
            `${run.prog} ${run.argv.join(' ')} (uid ${run.uid})`,
            `  expected rc=${run.rc} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`,
            `  got      rc=${got.rc} stdout=${JSON.stringify(got.stdout)} stderr=${JSON.stringify(got.stderr)}`,
          ].join('\n'));
        }
      }
      expect(differing, `${differing.length} of ${scenario.runs.length} differ\n${differing.join('\n')}`).toEqual([]);
    }, 120000);
  }
});
