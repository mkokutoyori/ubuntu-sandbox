/*
 * Probe — nslookup on Windows prints what nslookup.exe prints, and asks what nslookup.exe asks.
 *
 * Measured first (a Windows PC and a BIND9 server holding example.com, a reverse zone and a CNAME): the Windows
 * command answered in the BIND layout — `Server:\t\t10.0.0.2`, `Address:\t10.0.0.2#53`, `Name:\tweb.example.com`,
 * `Address: 10.0.0.80`, `mail exchanger = 10 mail.example.com.`, `** server can't find x: NXDOMAIN`, `;; connection
 * timed out; no servers could be reached` — whereas nslookup.exe prints `Server:  ns1.example.com` /
 * `Address:  10.0.0.2` (the server NAME read from the PTR of its address, `UnKnown` when there is none),
 * `Name:    ` / `Address:  ` / `Aliases:  ` blocks, `MX preference = 10, mail exchanger = mail.example.com`,
 * `*** ns1.example.com can't find x: Non-existent domain` and `DNS request timed out. / timeout was 2 seconds. /
 * *** Request to UnKnown timed-out`. It also answered a name that only the hosts file knows (nslookup never reads
 * it), ignored `-debug`, `-TYPE=` in capitals and the DNS suffix search list, and printed `Usage:` for `set all`.
 *
 * Authority: Microsoft Learn, Windows Commands, nslookup and its `set` subcommands (the documented options,
 * defaults and error classes); Microsoft Learn Exchange 2000 "How to use Nslookup to verify MX records" (the
 * `Default Server:` / `Server:` / `Address:` header and the `MX preference = 10, mail exchanger = host` and
 * `host internet address = ip` lines) and Windows Server 2003 "Verify DNS registration for domain controllers
 * using the nslookup command" (the `SRV service location:` block with `priority       =` / `svr hostname   =`
 * and the note that time-outs appear when the server has no reverse record); the SOA block (`primary name
 * server =`, `refresh = 900 (15 mins)`) from a captured Windows session. Microsoft Learn Q&A and TechNet forum
 * answers: nslookup queries DNS directly and ignores the hosts file. The `Name:`/`Aliases:` block, the `text =`
 * layout and the `Set options:` list are the tool's own output as captured in the sessions above; they are not
 * in a Microsoft page.
 *
 * Discrimination (the probe run on the tree before the change): 23 of the 26 cases fall. The three that pass
 * either way are the WITNESS (the name resolves to 10.0.0.80) and two NON-REGRESSIONS (an explicit reachable server
 * is still asked and still answers; an unknown `set` option was already refused with the tool's own text).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const FORWARD_ZONE = [
  '$TTL 3600',
  '$ORIGIN example.com.',
  '@ IN SOA ns1.example.com. hostmaster.example.com. ( 2026103101 3600 900 604800 300 )',
  '@ IN NS ns1.example.com.',
  '@ IN MX 10 mail.example.com.',
  '@ IN TXT "v=spf1 mx -all"',
  'ns1 IN A 10.0.0.2',
  'mail IN A 10.0.0.25',
  'web IN A 10.0.0.80',
  'www IN CNAME web',
  '_imaps._tcp IN SRV 10 5 993 mail',
  '',
].join('\n');

const REVERSE_ZONE = [
  '$TTL 3600',
  '$ORIGIN 0.0.10.in-addr.arpa.',
  '@ IN SOA ns1.example.com. hostmaster.example.com. ( 1 3600 900 604800 300 )',
  '@ IN NS ns1.example.com.',
  '2 IN PTR ns1.example.com.',
  '80 IN PTR web.example.com.',
  '',
].join('\n');

const NAMED_CONF = [
  'options { directory "/var/cache/bind"; recursion no; };',
  'zone "example.com" { type primary; file "/etc/bind/db.example"; };',
  'zone "0.0.10.in-addr.arpa" { type primary; file "/etc/bind/db.reverse"; };',
  '',
].join('\n');

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function lab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const srv = new LinuxServer('linux-server', 'NS1', 0, 0);
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const vfs = (srv as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/etc/bind/named.conf', NAMED_CONF, 0, 0, 0o022);
  vfs.writeFile('/etc/bind/db.example', FORWARD_ZONE, 0, 0, 0o022);
  vfs.writeFile('/etc/bind/db.reverse', REVERSE_ZONE, 0, 0, 0o022);
  await srv.executeCommand('systemctl start named');
  await pc.executeCommand('netsh interface ip set dns name="eth0" static 10.0.0.2');
  const shell = PowerShellSubShell.create(pc as never).subShell;
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  return { pc, srv, ps, nslookup: (args: string) => pc.executeCommand(`nslookup ${args}`) };
}

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function type(session: TerminalSession, line: string): Promise<void> {
  session.setInput(line);
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

const printed = (session: TerminalSession): string => session.lines.map((line) => line.text).join('\n');

describe('the header names the server the way nslookup.exe does', () => {
  it('WITNESS: the name resolves to the address the zone holds', async () => {
    const { nslookup } = await lab();
    expect(await nslookup('web.example.com')).toContain('10.0.0.80');
  });

  it('prints Server:  <name read from the PTR> and Address:  <ip>, two spaces, no #53', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('web.example.com');
    expect(out).toContain('Server:  ns1.example.com\nAddress:  10.0.0.2\n');
    expect(out).not.toContain('#53');
  });

  it('prints UnKnown when the server address has no PTR record', async () => {
    const { nslookup, srv } = await lab();
    const vfs = (srv as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
    vfs.writeFile('/etc/bind/db.reverse', REVERSE_ZONE.replace('2 IN PTR ns1.example.com.\n', ''), 0, 0, 0o022);
    await srv.executeCommand('rndc reload');
    expect(await nslookup('web.example.com')).toContain('Server:  UnKnown\nAddress:  10.0.0.2\n');
  });
});

describe('answers use the Windows layout', () => {
  it('an address is a Name:/Address: block, with the CNAME chain as Aliases:', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('www.example.com');
    expect(out).toContain('Name:    web.example.com\nAddress:  10.0.0.80\nAliases:  www.example.com\n');
  });

  it('MX records read "MX preference = N, mail exchanger = host" and the glue follows after a blank line', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('-type=MX example.com');
    expect(out).toContain('example.com\tMX preference = 10, mail exchanger = mail.example.com\n');
    expect(out).toContain('\n\nmail.example.com\tinternet address = 10.0.0.25');
  });

  it('NS records carry no trailing dot', async () => {
    const { nslookup } = await lab();
    expect(await nslookup('-type=NS example.com')).toMatch(/example\.com\tnameserver = ns1\.example\.com(\r?\n|$)/);
  });

  it('SOA prints its fields with the durations spelled out', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('-type=SOA example.com');
    expect(out).toContain('example.com\n\tprimary name server = ns1.example.com\n\tresponsible mail addr = hostmaster.example.com\n\tserial  = 2026103101\n');
    expect(out).toContain('\trefresh = 3600 (1 hour)\n\tretry   = 900 (15 mins)\n\texpire  = 604800 (7 days)\n\tdefault TTL = 300 (5 mins)');
  });

  it('TXT prints "text =", a blank line and the quoted string', async () => {
    const { nslookup } = await lab();
    expect(await nslookup('-type=TXT example.com')).toContain('example.com\ttext =\n\n\t"v=spf1 mx -all"');
  });

  it('SRV prints the service location block', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('-type=SRV _imaps._tcp.example.com');
    expect(out).toContain('_imaps._tcp.example.com\tSRV service location:\n\t  priority       = 10\n\t  weight         = 5\n\t  port           = 993\n\t  svr hostname   = mail.example.com');
  });

  it('an IP address is answered as Name:/Address: from its PTR record', async () => {
    const { nslookup } = await lab();
    expect(await nslookup('10.0.0.80')).toContain('Name:    web.example.com\nAddress:  10.0.0.80\n');
  });
});

describe('failures use the Windows wording', () => {
  it('a name that does not exist is "*** <server> can\'t find <name>: Non-existent domain"', async () => {
    const { nslookup } = await lab();
    expect(await nslookup('nexiste.example.com')).toContain("*** ns1.example.com can't find nexiste.example.com: Non-existent domain");
  });

  it('a silent server prints the timeout pair for the PTR, then twice for the query, then the request line', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('web.example.com 10.0.0.200');
    expect(out.match(/DNS request timed out\.\n {4}timeout was 2 seconds\./g)).toHaveLength(3);
    expect(out).toContain('Server:  UnKnown\nAddress:  10.0.0.200');
    expect(out).toContain('*** Request to UnKnown timed-out');
  }, 30000);
});

describe('options and the resolver environment', () => {
  it('options are case-insensitive: -TYPE=mx asks for MX', async () => {
    const { nslookup } = await lab();
    expect(await nslookup('-TYPE=mx example.com')).toContain('MX preference = 10');
  });

  it('-debug prints each answer packet, with its flags and the TTL of every record', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('-debug web.example.com');
    expect(out).toContain('Got answer:');
    expect(out).toContain('opcode = QUERY');
    expect(out).toContain('header flags:  response, auth. answer');
    expect(out).toContain('ttl = 3600 (1 hour)');
  });

  it('-d2 also prints the query that was sent and the size of each answer', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('-d2 web.example.com');
    expect(out).toMatch(/SendRequest\(\), len \d+/);
    expect(out).toMatch(/Got answer \(\d+ bytes\):/);
  });

  it('-norecurse sends the query without the recursion-desired bit', async () => {
    const { nslookup } = await lab();
    const out = await nslookup('-debug -norecurse web.example.com');
    expect(out).toContain('header flags:  response, auth. answer\n');
    expect(out).not.toContain('want recursion');
  });

  it('nslookup does not read the hosts file', async () => {
    const { pc, nslookup } = await lab();
    pc.addHostsEntry('10.0.0.99', 'onlyhosts');
    const out = await nslookup('onlyhosts');
    expect(out).not.toContain('10.0.0.99');
    expect(out).toContain("can't find onlyhosts");
  });

  it('a single-label name is completed with the DNS suffix search list, which ipconfig /all shows', async () => {
    const { pc, ps, nslookup } = await lab();
    pc.setCurrentUser('Administrator');
    await ps('Set-DnsClientGlobalSetting -SuffixSearchList example.com');
    expect(await nslookup('web')).toContain('Name:    web.example.com');
    expect(await pc.executeCommand('ipconfig /all')).toContain('DNS Suffix Search List. . . . . . : example.com');
  });

  it('NON-REGRESSION: an explicit reachable server is asked and answers', async () => {
    const { nslookup } = await lab();
    expect(await nslookup('web.example.com 10.0.0.2')).toContain('10.0.0.80');
  });
});

describe('the interactive session', () => {
  it('set all lists the options, the default query type being A+AAAA', async () => {
    const { pc } = await lab();
    const term = new WindowsTerminalSession('t1', pc);
    await term.init();
    await type(term, 'nslookup');
    await type(term, 'set all');
    const screen = printed(term);
    expect(screen).toContain('Set options:');
    expect(screen).toContain('  type=A+AAAA');
    expect(screen).toContain('  timeout=2');
    expect(screen).toContain('  retry=1');
  });

  it('set type=MX changes the answers of the following lookups', async () => {
    const { pc } = await lab();
    const term = new WindowsTerminalSession('t1', pc);
    await term.init();
    await type(term, 'nslookup');
    await type(term, 'set type=MX');
    await type(term, 'example.com');
    expect(printed(term)).toContain('MX preference = 10, mail exchanger = mail.example.com');
  });

  it('NON-REGRESSION: an unknown option is refused in the tool\'s own words', async () => {
    const { pc } = await lab();
    const term = new WindowsTerminalSession('t1', pc);
    await term.init();
    await type(term, 'nslookup');
    await type(term, 'set zorglub=1');
    expect(printed(term)).toContain('*** Invalid option: zorglub=1');
  });

  it('server <name> resolves the name through the current server and switches to its address', async () => {
    const { pc } = await lab();
    const term = new WindowsTerminalSession('t1', pc);
    await term.init();
    await type(term, 'nslookup');
    await type(term, 'server ns1.example.com');
    expect(printed(term)).toMatch(/Default Server: {2}ns1\.example\.com\nAddress: {2}10\.0\.0\.2\n[\s\S]*Default Server: {2}ns1\.example\.com\nAddress: {2}10\.0\.0\.2/);
  });

  it('server <name> that does not exist leaves the server unchanged and says why', async () => {
    const { pc } = await lab();
    const term = new WindowsTerminalSession('t1', pc);
    await term.init();
    await type(term, 'nslookup');
    await type(term, 'server nexiste.example.com');
    expect(printed(term)).toContain("*** Can't find address for server nexiste.example.com: Non-existent domain");
  });

  it('help lists the subcommands', async () => {
    const { pc } = await lab();
    const term = new WindowsTerminalSession('t1', pc);
    await term.init();
    await type(term, 'nslookup');
    await type(term, 'help');
    const screen = printed(term);
    expect(screen).toContain('set OPTION      - set an option');
    expect(screen).toContain('server NAME     - set default server to NAME, using current default server');
  });

  it('a lookup does not move the default server when a server is given with the name', async () => {
    const { pc } = await lab();
    const term = new WindowsTerminalSession('t1', pc);
    await term.init();
    await type(term, 'nslookup');
    await type(term, 'web.example.com 10.0.0.2');
    await type(term, 'set all');
    expect(printed(term)).toMatch(/Default Server: {2}ns1\.example\.com\nAddress: {2}10\.0\.0\.2/);
  });
});
