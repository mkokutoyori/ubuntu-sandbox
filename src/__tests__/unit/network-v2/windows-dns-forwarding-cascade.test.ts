/*
 * Windows DNS Server: forwarders that really forward (RD=1, the forwarder
 * recurses and its answer is final), conditional forwarders with and without
 * recursion, forwarder reordering by measured response time, and NOTIFY sent
 * onward by a secondary zone (cascaded secondaries).
 *
 * Lab: WNS1 (10.0.1.10) is the server under test, NS2 (10.0.1.20, BIND9) is
 * authoritative for bind.test, WNS3 (10.0.1.30) is a second Windows server and
 * PC1 (10.0.1.2) asks the questions. Every exchange is a real UDP/TCP 53 frame.
 *
 * Discrimination (git stash of the source files): 8 of the 9 cases fall before
 * the change. The one that passes either way is "Get-DnsServerForwarder rend
 * compte d EnableReordering", a weak structural check: its /False/ pattern is
 * already satisfied by the UseRootHint column the lab sets to False.
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

const WNS1 = '10.0.1.10';
const NS2 = '10.0.1.20';
const WNS3 = '10.0.1.30';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (d: WindowsServer, line: string) => (await PowerShellSubShell.create(d).subShell.processLine(line)).output.join('\n');

function question(qname: string, recursion = true): DnsMessage {
  return {
    id: Math.floor(Math.random() * 60000),
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: recursion, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(path, content, 0, 0, 0o022);
}

interface Lab { wns1: WindowsServer; wns3: WindowsServer; ns2: LinuxServer; pc1: LinuxPC }

async function lab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const wns1 = new WindowsServer('WNS1');
  const ns2 = new LinuxServer('linux-server', 'NS2');
  const wns3 = new WindowsServer('WNS3');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [wns1, ns2, wns3, pc1].forEach((d, i) => {
    new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]);
    d.getPorts()[0].configureIP(new IPAddress([WNS1, NS2, WNS3, '10.0.1.2'][i]), mask);
  });
  for (const w of [wns1, wns3]) { w.setCurrentUser('Administrator'); await run(w, 'Install-WindowsFeature DNS'); }
  await run(wns1, 'Set-DnsServerForwarder -UseRootHint $false');
  await run(wns3, 'Set-DnsServerForwarder -UseRootHint $false');
  return { wns1, wns3, ns2, pc1 };
}

async function startAuthoritative(ns2: LinuxServer): Promise<void> {
  writeRoot(ns2, '/etc/bind/named.conf', 'options { recursion no; };\nzone "bind.test" { type primary; file "/etc/bind/db.bind.test"; };\n');
  writeRoot(ns2, '/etc/bind/db.bind.test', [
    '$ORIGIN bind.test.', '$TTL 3600',
    '@ IN SOA ns2.bind.test. admin.bind.test. ( 1 3600 900 604800 300 )', '  IN NS ns2.bind.test.',
    `ns2 IN A ${NS2}`, 'www IN A 10.0.9.1', 'www1 IN A 10.0.9.11', 'www2 IN A 10.0.9.12', 'www3 IN A 10.0.9.13', '',
  ].join('\n'));
  await ns2.executeCommand('systemctl start named');
}

const ask = (from: LinuxPC, server: string, name: string, timeout = 9000) =>
  queryDnsOverUdp(from, new IPAddress(server), question(name), 53, timeout);
const has = (m: DnsMessage | null, address: string) => m?.answers.some(rr => String((rr.data as ARecordData).address) === address) ?? false;

async function eventually(probe: () => Promise<DnsMessage | null>, accept: (m: DnsMessage) => boolean): Promise<DnsMessage> {
  const deadline = Date.now() + 9000;
  for (;;) {
    const value = await probe();
    if (value !== null && accept(value)) return value;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

describe('redirecteurs', () => {
  it('un redirecteur reçoit une requête récursive et sa réponse fait foi', async () => {
    const { wns1, wns3, ns2, pc1 } = await lab();
    await startAuthoritative(ns2);
    await run(wns3, `Add-DnsServerConditionalForwarderZone -Name bind.test -MasterServers ${NS2}`);
    await run(wns1, `Set-DnsServerForwarder -IPAddress ${WNS3}`);
    expect(has(await ask(pc1, WNS1, 'www.bind.test'), '10.0.9.1')).toBe(true);
  }, 30000);

  it('-UseRecursion $false : le maître qui ne fait pas autorité refuse', async () => {
    const { wns1, wns3, ns2, pc1 } = await lab();
    await startAuthoritative(ns2);
    await run(wns3, `Add-DnsServerConditionalForwarderZone -Name bind.test -MasterServers ${NS2}`);
    await run(wns1, `Add-DnsServerConditionalForwarderZone -Name bind.test -MasterServers ${WNS3} -UseRecursion $false`);
    expect((await ask(pc1, WNS1, 'www.bind.test'))?.flags.rcode).toBe(DnsRcode.SERVFAIL);
  }, 30000);

  it('Set-DnsServerConditionalForwarderZone -UseRecursion $true fait passer la même requête', async () => {
    const { wns1, wns3, ns2, pc1 } = await lab();
    await startAuthoritative(ns2);
    await run(wns3, `Add-DnsServerConditionalForwarderZone -Name bind.test -MasterServers ${NS2}`);
    await run(wns1, `Add-DnsServerConditionalForwarderZone -Name bind.test -MasterServers ${WNS3} -UseRecursion $false`);
    await run(wns1, 'Set-DnsServerConditionalForwarderZone -Name bind.test -UseRecursion $true');
    expect(has(await ask(pc1, WNS1, 'www.bind.test'), '10.0.9.1')).toBe(true);
  }, 30000);

  it('-ZoneFile d un redirecteur conditionnel est écrit puis retiré avec la zone', async () => {
    const { wns1 } = await lab();
    await run(wns1, `Add-DnsServerConditionalForwarderZone -Name bind.test -MasterServers ${NS2} -ZoneFile fwd.dns`);
    expect(wns1.getFileSystem().readFile('C:\\Windows\\System32\\dns\\fwd.dns').content).toContain(NS2);
    expect(await run(wns1, 'Get-DnsServerZone -Name bind.test')).toMatch(/ZoneFile\s*:\s*fwd\.dns/);
    await run(wns1, 'Remove-DnsServerZone -Name bind.test -Force');
    expect(wns1.getFileSystem().readFile('C:\\Windows\\System32\\dns\\fwd.dns').ok).toBe(false);
  });
});

describe('réordonnancement des redirecteurs', () => {
  async function timedLab(reordering: boolean): Promise<{ first: number; second: number }> {
    const { wns1, wns3, ns2, pc1 } = await lab();
    await startAuthoritative(ns2);
    await run(wns3, `Add-DnsServerConditionalForwarderZone -Name bind.test -MasterServers ${NS2}`);
    await run(wns1, `Set-DnsServerForwarder -IPAddress 10.0.1.99,${WNS3} -Timeout 1 -EnableReordering $${reordering}`);
    const t0 = Date.now();
    expect(has(await ask(pc1, WNS1, 'www1.bind.test'), '10.0.9.11')).toBe(true);
    const t1 = Date.now();
    expect(has(await ask(pc1, WNS1, 'www2.bind.test'), '10.0.9.12')).toBe(true);
    return { first: t1 - t0, second: Date.now() - t1 };
  }

  it('avec réordonnancement, le redirecteur mort passe en dernier après un échec', async () => {
    const { first, second } = await timedLab(true);
    expect(first).toBeGreaterThan(900);
    expect(second).toBeLessThan(600);
  }, 30000);

  it('sans réordonnancement, le redirecteur mort est réessayé en premier à chaque requête', async () => {
    const { first, second } = await timedLab(false);
    expect(first).toBeGreaterThan(900);
    expect(second).toBeGreaterThan(900);
  }, 30000);

  it('Get-DnsServerForwarder rend compte d EnableReordering', async () => {
    const { wns1 } = await lab();
    await run(wns1, 'Set-DnsServerForwarder -EnableReordering $false');
    expect(await run(wns1, 'Get-DnsServerForwarder')).toMatch(/False/);
  });
});

describe('NOTIFY en cascade', () => {
  it('une secondaire notifie à son tour ses propres secondaires', async () => {
    const { wns1, wns3, ns2, pc1 } = await lab();
    await run(wns3, 'Add-DnsServerPrimaryZone -Name chain.test');
    await run(wns3, 'Add-DnsServerResourceRecordA -ZoneName chain.test -Name a -IPv4Address 10.0.5.1');
    await run(wns3, `Set-DnsServerPrimaryZone -Name chain.test -SecureSecondaries TransferAnyServer -Notify NotifyServers -NotifyServers ${WNS1}`);
    await run(wns1, `Add-DnsServerSecondaryZone -Name chain.test -MasterServers ${WNS3}`);
    await run(wns1, `Set-DnsServerSecondaryZone -Name chain.test -SecureSecondaries TransferAnyServer -Notify NotifyServers -NotifyServers ${NS2}`);
    await eventually(() => ask(pc1, WNS1, 'a.chain.test'), m => has(m, '10.0.5.1'));
    writeRoot(ns2, '/etc/bind/named.conf', [
      'options { recursion no; };',
      'zone "chain.test" { type secondary;', `  primaries { ${WNS1}; };`, '  file "db.chain.test"; };', '',
    ].join('\n'));
    await ns2.executeCommand('systemctl start named');
    await eventually(() => ask(pc1, NS2, 'a.chain.test'), m => has(m, '10.0.5.1'));

    await run(wns3, 'Add-DnsServerResourceRecordA -ZoneName chain.test -Name b -IPv4Address 10.0.5.2');
    await eventually(() => ask(pc1, WNS1, 'b.chain.test'), m => has(m, '10.0.5.2'));
    await eventually(() => ask(pc1, NS2, 'b.chain.test'), m => has(m, '10.0.5.2'));
  }, 40000);

  it('Set-DnsServerSecondaryZone -Notify NoNotify coupe la cascade', async () => {
    const { wns1, wns3, ns2, pc1 } = await lab();
    await run(wns3, 'Add-DnsServerPrimaryZone -Name chain.test');
    await run(wns3, 'Add-DnsServerResourceRecordA -ZoneName chain.test -Name a -IPv4Address 10.0.5.1');
    await run(wns3, `Set-DnsServerPrimaryZone -Name chain.test -SecureSecondaries TransferAnyServer -Notify NotifyServers -NotifyServers ${WNS1}`);
    await run(wns1, `Add-DnsServerSecondaryZone -Name chain.test -MasterServers ${WNS3}`);
    await run(wns1, `Set-DnsServerSecondaryZone -Name chain.test -SecureSecondaries TransferAnyServer -Notify NoNotify`);
    await eventually(() => ask(pc1, WNS1, 'a.chain.test'), m => has(m, '10.0.5.1'));
    writeRoot(ns2, '/etc/bind/named.conf', [
      'options { recursion no; };',
      'zone "chain.test" { type secondary;', `  primaries { ${WNS1}; };`, '  file "db.chain.test"; };', '',
    ].join('\n'));
    await ns2.executeCommand('systemctl start named');
    await eventually(() => ask(pc1, NS2, 'a.chain.test'), m => has(m, '10.0.5.1'));
    await run(wns3, 'Add-DnsServerResourceRecordA -ZoneName chain.test -Name b -IPv4Address 10.0.5.2');
    await eventually(() => ask(pc1, WNS1, 'b.chain.test'), m => has(m, '10.0.5.2'));
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(has(await ask(pc1, NS2, 'b.chain.test'), '10.0.5.2')).toBe(false);
  }, 40000);
});
