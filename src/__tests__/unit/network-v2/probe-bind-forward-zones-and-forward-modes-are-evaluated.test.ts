/*
 * Probe — BIND forward zones and the `forward first|only` mode decide where a recursive query goes.
 *
 * Measured first (BIND 9.18 resolver whose hints lead to a root that delegates corp.test to a dead server, and a
 * `zone "corp.test" { type forward; forwarders { 10.0.0.20; }; }` pointing at the live authoritative server):
 * - the forward zone was parsed and then never read — the query followed the root's delegation to the dead
 *   server and came back SERVFAIL, so the one use of a forward zone (send this domain to that server) did
 *   nothing; an internal Active Directory domain behind a BIND resolver could not be reached;
 * - `forward only;` written inside the zone, the standard form, was refused as "unknown option 'forward'";
 * - the options-level `forward only;` was stored and never consulted, so a resolver told to use its forwarders
 *   only still fell back to the root hints when they failed.
 * BIND's manual: `forward only` sends the query to the forwarders and, when they do not answer, fails;
 * `forward first` (the default) tries the forwarders and then resolves on its own. A forward zone applies the
 * same rule to its own domain, and its forwarders win over the global ones for names under it.
 *
 * A fourth defect sat under the other three: the forwarders resolver and the root-hints resolver share one cache,
 * and the first one stored its SERVFAIL there (servfail-ttl, 1 s by default), so the second answered from that
 * entry and never ran — `forward first` could not fall back at all. Only the last resolver of a chain now
 * stores the failure, as BIND caches the outcome of the whole resolution.
 *
 * Discrimination (git stash of NamedConfig.ts and Bind9Service.ts): 8 of the 10 cases fall before the change.
 * Two pass either way:
 *  - "resolves a name outside the forward zone through the root hints" — WITNESS: with an unused forward zone
 *    declared (no `forward` line, accepted before) the roots still answer, so the lab itself is sound.
 *  - "fails with the global forward only when the global forwarders are dead" — passes before for the WRONG
 *    reason: forward only was ignored, but the poisoned SERVFAIL entry made the fallback fail anyway. It is kept
 *    as the other half of its sibling "falls back ... forward is first", which falls before and discriminates.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const ROOT_IP = '10.0.0.1';
const CORP_IP = '10.0.0.20';
const FALLBACK_IP = '10.0.0.31';
const RESOLVER_IP = '10.0.0.53';
const PC_IP = '10.0.0.100';
const DEAD_IP = '10.0.0.99';

const ROOT_ZONE = [
  '$TTL 3600',
  '. IN SOA a.root-servers.net. hostmaster.root-servers.net. ( 1 3600 900 604800 300 )',
  '. IN NS a.root-servers.net.',
  `a.root-servers.net. IN A ${ROOT_IP}`,
  'corp.test. IN NS ns.corp.test.',
  'ns.corp.test. IN A 10.0.0.66',
  'fallback.test. IN NS ns.fallback.test.',
  `ns.fallback.test. IN A ${FALLBACK_IP}`,
  '',
].join('\n');

const hostedZone = (name: string, serverIp: string, www: string): string => [
  '$TTL 3600',
  `$ORIGIN ${name}.`,
  `@ IN SOA ns.${name}. hostmaster.${name}. ( 1 3600 900 604800 300 )`,
  `@ IN NS ns.${name}.`,
  `ns IN A ${serverIp}`,
  `www IN A ${www}`,
  'a.b IN A 10.0.0.81',
  '',
].join('\n');

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function put(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

async function buildLab(resolverConf: string) {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const root = new LinuxServer('linux-server', 'ROOT');
  const corp = new LinuxServer('linux-server', 'CORP');
  const fallback = new LinuxServer('linux-server', 'FALLBACK');
  const resolver = new LinuxServer('linux-server', 'RESOLVER');
  const pc = new LinuxPC('linux-pc', 'PC');
  const mask = new SubnetMask('255.255.255.0');
  [root, corp, fallback, resolver, pc].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([ROOT_IP, CORP_IP, FALLBACK_IP, RESOLVER_IP, PC_IP][index]), mask);
  });

  put(root, '/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "." { type primary; file "/etc/bind/db.root"; };\n');
  put(root, '/etc/bind/db.root', ROOT_ZONE);
  await root.executeCommand('systemctl start named');

  put(corp, '/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "corp.test" { type primary; file "/etc/bind/db.corp"; };\n');
  put(corp, '/etc/bind/db.corp', hostedZone('corp.test', CORP_IP, '10.0.0.80'));
  await corp.executeCommand('systemctl start named');

  put(fallback, '/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "fallback.test" { type primary; file "/etc/bind/db.fb"; };\n');
  put(fallback, '/etc/bind/db.fb', hostedZone('fallback.test', FALLBACK_IP, '10.0.0.90'));
  await fallback.executeCommand('systemctl start named');

  put(resolver, '/etc/bind/named.conf', resolverConf);
  put(resolver, '/etc/bind/db.hints', `. 3600000 IN NS a.root-servers.net.\na.root-servers.net. 3600000 IN A ${ROOT_IP}\n`);
  await resolver.executeCommand('systemctl start named');
  return { pc, resolver };
}

const conf = (options: string, zones: string): string =>
  `options { directory "/var/cache/bind"; recursion yes; allow-recursion { any; }; dnssec-validation no; ${options} };\n`
  + 'zone "." { type hint; file "/etc/bind/db.hints"; };\n'
  + `${zones}\n`;

const ask = (pc: LinuxPC, name: string): Promise<string> =>
  pc.executeCommand(`dig @${RESOLVER_IP} ${name} A +tries=1`);

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('BIND forward zones', () => {
  it('sends a name under a forward zone to its forwarders, not along the root delegation', async () => {
    const { pc } = await buildLab(conf('', `zone "corp.test" { type forward; forwarders { ${CORP_IP}; }; };`));
    expect(await ask(pc, 'www.corp.test')).toMatch(/www\.corp\.test\.\s+\d+\s+IN\s+A\s+10\.0\.0\.80/);
  });

  it('reads forward only inside the zone, the standard form', async () => {
    const { pc, resolver } = await buildLab(conf('', `zone "corp.test" { type forward; forward only; forwarders { ${CORP_IP}; }; };`));
    expect(await resolver.executeCommand('named-checkconf')).toBe('');
    expect(await ask(pc, 'www.corp.test')).toMatch(/IN\s+A\s+10\.0\.0\.80/);
  });

  it('applies the forward zone to every name below it', async () => {
    const { pc } = await buildLab(conf('', `zone "corp.test" { type forward; forward only; forwarders { ${CORP_IP}; }; };`));
    expect(await ask(pc, 'a.b.corp.test')).toMatch(/IN\s+A\s+10\.0\.0\.81/);
  });

  it('fails with forward only when the zone forwarders are dead, without trying the roots', async () => {
    const { pc } = await buildLab(conf('', `zone "fallback.test" { type forward; forward only; forwarders { ${DEAD_IP}; }; };`));
    expect(await ask(pc, 'www.fallback.test')).toContain('status: SERVFAIL');
  });

  it('falls back to the roots with forward first when the zone forwarders are dead', async () => {
    const { pc } = await buildLab(conf('', `zone "fallback.test" { type forward; forward first; forwarders { ${DEAD_IP}; }; };`));
    expect(await ask(pc, 'www.fallback.test')).toMatch(/IN\s+A\s+10\.0\.0\.90/);
  });

  it('resolves a name outside the forward zone through the root hints', async () => {
    const { pc } = await buildLab(conf('', `zone "corp.test" { type forward; forwarders { ${CORP_IP}; }; };`));
    expect(await ask(pc, 'www.fallback.test')).toMatch(/IN\s+A\s+10\.0\.0\.90/);
  });

  it('fails with the global forward only when the global forwarders are dead', async () => {
    const { pc } = await buildLab(conf(`forwarders { ${DEAD_IP}; }; forward only;`, ''));
    expect(await ask(pc, 'www.fallback.test')).toContain('status: SERVFAIL');
  });

  it('falls back to the root hints when the global forwarders are dead and forward is first', async () => {
    const { pc } = await buildLab(conf(`forwarders { ${DEAD_IP}; }; forward first;`, ''));
    expect(await ask(pc, 'www.fallback.test')).toMatch(/IN\s+A\s+10\.0\.0\.90/);
  });

  it('lets the forward zone forwarders win over the global ones for its own names', async () => {
    const { pc } = await buildLab(conf(`forwarders { ${DEAD_IP}; }; forward only;`, `zone "corp.test" { type forward; forward only; forwarders { ${CORP_IP}; }; };`));
    expect(await ask(pc, 'www.corp.test')).toMatch(/IN\s+A\s+10\.0\.0\.80/);
  });

  it('refuses forward in a primary zone with the manual wording', async () => {
    const { resolver } = await buildLab(conf('', ''));
    vfsOf(resolver).writeFile('/etc/bind/named.conf', 'zone "x.test" { type primary; file "/etc/bind/db.x"; forward only; };\n', 0, 0, 0o022);
    expect(await resolver.executeCommand('named-checkconf')).toContain("option 'forward' is not allowed in 'primary' zone 'x.test'");
  });
});
