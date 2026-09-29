/*
 * Root hints of the Windows DNS Server: the 13 IANA roots by default, the
 * DnsServer RootHint cmdlets, cache.dns on disk, and the resolution itself —
 * WNS1 (recursive, no forwarder) walks from a root hint to a delegation to the
 * authoritative BIND9 server, every step a real UDP/53 exchange.
 *
 * Lab: WNS1 (10.0.1.10) recursive server, WNS3 (10.0.1.30) plays the root: it
 * hosts "test." delegating bind.test to NS2 (10.0.1.20, BIND9 primary), PC1
 * asks. The roots' addresses come from IANA's named.root as remembered (the
 * file could not be fetched from here); a lab replaces them with its own.
 *
 * Discrimination (git stash of the source files): 5 of the 7 cases fall
 * before the change. The two that pass either way are refusals — "sans racine
 * ni redirecteur" (guard: a server with nothing to recurse through still
 * refuses) and "-UseRootHint $false" (a server without roots refused before).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const WNS1_IP = '10.0.1.10';
const NS2_IP = '10.0.1.20';
const WNS3_IP = '10.0.1.30';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (d: WindowsServer, line: string) => (await PowerShellSubShell.create(d).subShell.processLine(line)).output.join('\n');

function question(qname: string): DnsMessage {
  return {
    id: Math.floor(Math.random() * 60000),
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const wns1 = new WindowsServer('WNS1');
  const ns2 = new LinuxServer('linux-server', 'NS2');
  const wns3 = new WindowsServer('WNS3');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [wns1, ns2, wns3, pc1].forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
    d.getPorts()[0].configureIP(new IPAddress([WNS1_IP, NS2_IP, WNS3_IP, '10.0.1.2'][i]), mask);
  });
  for (const w of [wns1, wns3]) { w.setCurrentUser('Administrator'); await run(w, 'Install-WindowsFeature DNS'); }
  const vfs = (ns2 as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/etc/bind/named.conf', 'options { recursion no; };\nzone "bind.test" { type primary; file "/etc/bind/db.bind.test"; };\n', 0, 0, 0o022);
  vfs.writeFile('/etc/bind/db.bind.test', [
    '$ORIGIN bind.test.', '$TTL 3600',
    '@ IN SOA ns2.bind.test. admin.bind.test. ( 1 3600 900 604800 300 )', '  IN NS ns2.bind.test.',
    `ns2 IN A ${NS2_IP}`, 'www IN A 10.0.9.1', '',
  ].join('\n'), 0, 0, 0o022);
  await ns2.executeCommand('systemctl start named');
  await run(wns3, 'Add-DnsServerPrimaryZone -Name test');
  await run(wns3, 'Add-DnsServerResourceRecord -NS -ZoneName test -Name bind -NameServer ns2.bind.test');
  await run(wns3, `Add-DnsServerResourceRecordA -ZoneName test -Name ns2.bind -IPv4Address ${NS2_IP}`);
  return { wns1, wns3, ns2, pc1 };
}

async function useOwnRoot(wns1: WindowsServer): Promise<void> {
  await run(wns1, 'foreach ($h in Get-DnsServerRootHint) { Remove-DnsServerRootHint -NameServer $h.NameServer -Force }');
  await run(wns1, `Add-DnsServerRootHint -NameServer a.root.test -IPAddress ${WNS3_IP}`);
}

const ask = (pc1: LinuxPC, qname: string) => queryDnsOverUdp(pc1, new IPAddress(WNS1_IP), question(qname), 53, 9000);
const answers = (m: DnsMessage | null, address: string) => m?.answers.some(rr => String((rr.data as ARecordData).address) === address) ?? false;

describe('root hints', () => {
  it('les 13 racines IANA sont là par défaut', async () => {
    const { wns1 } = await lab();
    const out = await run(wns1, 'Get-DnsServerRootHint');
    expect(out).toContain('a.root-servers.net.');
    expect(out).toContain('198.41.0.4');
    expect(out).toContain('m.root-servers.net.');
    expect((out.match(/root-servers\.net\./g) ?? []).length).toBe(13);
  });

  it('Add / Set / Remove-DnsServerRootHint et cache.dns', async () => {
    const { wns1 } = await lab();
    await run(wns1, 'Add-DnsServerRootHint -NameServer x.lab.test -IPAddress 10.9.9.9');
    expect(await run(wns1, 'Get-DnsServerRootHint')).toContain('10.9.9.9');
    expect(wns1.getFileSystem().readFile('C:\\Windows\\System32\\dns\\cache.dns').content).toContain('x.lab.test. 3600000 A     10.9.9.9');
    await run(wns1, 'Set-DnsServerRootHint -NameServer x.lab.test -IPAddress 10.9.9.8');
    const changed = await run(wns1, 'Get-DnsServerRootHint');
    expect(changed).toContain('10.9.9.8');
    expect(changed).not.toContain('10.9.9.9');
    await run(wns1, 'Remove-DnsServerRootHint -NameServer x.lab.test -Force');
    expect(await run(wns1, 'Get-DnsServerRootHint')).not.toContain('x.lab.test');
    expect(await run(wns1, 'Add-DnsServerRootHint -NameServer y.lab.test -IPAddress 999.1.1.1')).toMatch(/not a valid IPv4/);
    expect(await run(wns1, 'Remove-DnsServerRootHint -NameServer nope.lab.test -Force')).toMatch(/Cannot find/);
  });

  it('résout depuis la racine : référence, puis serveur faisant autorité, sur le fil', async () => {
    const { wns1, pc1 } = await lab();
    await useOwnRoot(wns1);
    const reply = await ask(pc1, 'www.bind.test');
    expect(reply?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(answers(reply, '10.0.9.1')).toBe(true);
    expect(await run(wns1, 'Show-DnsServerCache')).toContain('10.0.9.1');
  }, 30000);

  it('-UseRootHint $false coupe la résolution depuis les racines', async () => {
    const { wns1, pc1 } = await lab();
    await useOwnRoot(wns1);
    await run(wns1, 'Set-DnsServerForwarder -UseRootHint $false');
    expect((await ask(pc1, 'www.bind.test'))?.flags.rcode).toBe(DnsRcode.REFUSED);
  }, 30000);

  it('GARDE : sans racine ni redirecteur, la requête récursive est refusée', async () => {
    const { wns1, pc1 } = await lab();
    await run(wns1, 'foreach ($h in Get-DnsServerRootHint) { Remove-DnsServerRootHint -NameServer $h.NameServer -Force }');
    expect((await ask(pc1, 'www.bind.test'))?.flags.rcode).toBe(DnsRcode.REFUSED);
  }, 30000);

  it('un redirecteur mort laisse la main aux racines', async () => {
    const { wns1, pc1 } = await lab();
    await useOwnRoot(wns1);
    await run(wns1, 'Set-DnsServerForwarder -IPAddress 10.0.1.99 -Timeout 1');
    const reply = await ask(pc1, 'www.bind.test');
    expect(answers(reply, '10.0.9.1')).toBe(true);
  }, 30000);

  it('Import-DnsServerRootHint recopie les racines annoncées par un serveur racine', async () => {
    const { wns1, wns3 } = await lab();
    await run(wns3, 'Add-DnsServerPrimaryZone -Name .');
    await run(wns3, 'Add-DnsServerResourceRecord -NS -ZoneName . -Name "@" -NameServer a.root.test');
    await run(wns3, `Add-DnsServerResourceRecordA -ZoneName . -Name a.root.test -IPv4Address ${WNS3_IP}`);
    await useOwnRoot(wns1);
    await run(wns1, 'Import-DnsServerRootHint');
    const deadline = Date.now() + 8000;
    let listed = '';
    while (Date.now() < deadline) {
      listed = await run(wns1, 'Get-DnsServerRootHint');
      if (listed.includes('a.root.test.')) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    expect(listed).toContain('a.root.test.');
    expect(listed).toContain(WNS3_IP);
    expect(listed).not.toContain('a.root-servers.net.');
  }, 30000);
});
