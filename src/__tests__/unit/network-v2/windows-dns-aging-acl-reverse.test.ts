/*
 * Windows DNS Server: per-record update ownership (secure dynamic update),
 * aging and scavenging on the machine's simulated clock, RFC 2317 classless
 * reverse zones and ip6.arpa reverse zones with -CreatePtr.
 *
 * Lab: WNS1 (Windows Server, DNS role, 10.0.0.1) and PC1 (Linux, 10.0.0.100)
 * which sends real RFC 2136 updates with nsupdate, signed by a TSIG key. Every
 * update and query is a real UDP/53 exchange.
 *
 * Discrimination (git stash of the source files): 12 of the 18 cases fall
 * before the change. The six that pass either way, and why:
 *   - "TÉMOIN : une mise à jour signée qui crée un nouveau nom" — witness, the
 *     lab and the signed update path are sound;
 *   - "alice remplace son propre enregistrement" — non-regression, the owner
 *     keeps its rights;
 *   - "-AllowUpdateAny ouvre cet enregistrement" — the outcome (the update is
 *     accepted) was already the behaviour when nothing was protected;
 *   - "TÉMOIN : vieillissement coupé" — witness, nothing is scavenged while
 *     aging is off;
 *   - "-AgeRecord rend un enregistrement statique éligible" and
 *     "-ScavengeServers qui ne nomme pas ce serveur" — the asserted state
 *     (record removed / record kept) is reached by other means before the
 *     change, so they are structural checks that complement the cases above.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const SERVER = '10.0.0.1';
const DAY = 86_400_000;

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (d: WindowsServer, line: string) => (await PowerShellSubShell.create(d).subShell.processLine(line)).output.join('\n');

async function lab(secure = true): Promise<{ wns: WindowsServer; pc: LinuxPC }> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const wns = new WindowsServer('WNS1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [wns, pc].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  wns.getPorts()[0].configureIP(new IPAddress(SERVER), mask);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), mask);
  wns.setCurrentUser('Administrator');
  await run(wns, 'Install-WindowsFeature DNS');
  await run(wns, 'Add-DnsServerPrimaryZone -Name lab.test');
  await run(wns, `Set-DnsServerPrimaryZone -Name lab.test -DynamicUpdate ${secure ? 'Secure' : 'NonsecureAndSecure'}`);
  await run(wns, 'Add-DnsServerTsigKey -Name alice -Secret YWxpY2Utc2VjcmV0');
  await run(wns, 'Add-DnsServerTsigKey -Name bob -Secret Ym9iLXNlY3JldA==');
  return { wns, pc };
}

const SECRETS: Readonly<Record<string, string>> = {
  alice: 'YWxpY2Utc2VjcmV0', bob: 'Ym9iLXNlY3JldA==',
};

function update(pc: LinuxPC, key: string, lines: readonly string[]): Promise<string> {
  const script = ['server ' + SERVER, 'zone lab.test', ...lines, 'send'].join('\\n');
  return pc.executeCommand(`printf '${script}\\n' | nsupdate -y hmac-sha256:${key}:${SECRETS[key]}`);
}

const records = (wns: WindowsServer, extra = '') => run(wns, `Get-DnsServerResourceRecord -ZoneName lab.test ${extra}`);
const stampOf = (wns: WindowsServer, name: string) =>
  run(wns, `Get-DnsServerResourceRecord -ZoneName lab.test -Name ${name} | Select-Object -ExpandProperty Timestamp`);

describe('propriété des enregistrements en mise à jour sécurisée', () => {
  it('TÉMOIN : une mise à jour signée qui crée un nouveau nom est acceptée', async () => {
    const { wns, pc } = await lab();
    expect(await update(pc, 'alice', ['update add host.lab.test 300 A 10.0.0.9'])).toBe('');
    expect(await records(wns, '-Name host')).toContain('10.0.0.9');
  });

  it('un autre porteur de clé ne peut ni remplacer ni supprimer l enregistrement d alice', async () => {
    const { wns, pc } = await lab();
    await update(pc, 'alice', ['update add host.lab.test 300 A 10.0.0.9']);
    const refused = await update(pc, 'bob', ['update delete host.lab.test A', 'update add host.lab.test 300 A 6.6.6.6']);
    expect(refused).toContain('REFUSED');
    const after = await records(wns, '-Name host');
    expect(after).toContain('10.0.0.9');
    expect(after).not.toContain('6.6.6.6');
  });

  it('alice remplace son propre enregistrement', async () => {
    const { wns, pc } = await lab();
    await update(pc, 'alice', ['update add host.lab.test 300 A 10.0.0.9']);
    expect(await update(pc, 'alice', ['update delete host.lab.test A', 'update add host.lab.test 300 A 10.0.0.10'])).toBe('');
    expect(await records(wns, '-Name host')).toContain('10.0.0.10');
  });

  it('un enregistrement posé par l administrateur n est pas modifiable par une mise à jour sécurisée', async () => {
    const { wns, pc } = await lab();
    await run(wns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.0.5');
    expect(await update(pc, 'alice', ['update delete www.lab.test A', 'update add www.lab.test 300 A 6.6.6.6'])).toContain('REFUSED');
    expect(await records(wns, '-Name www')).toContain('10.0.0.5');
  });

  it('-AllowUpdateAny ouvre cet enregistrement à tout porteur de clé', async () => {
    const { wns, pc } = await lab();
    await run(wns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.0.5 -AllowUpdateAny');
    expect(await update(pc, 'alice', ['update delete www.lab.test A', 'update add www.lab.test 300 A 10.0.0.6'])).toBe('');
    expect(await records(wns, '-Name www')).toContain('10.0.0.6');
  });
});

describe('vieillissement et nettoyage (scavenging)', () => {
  const aging = 'Set-DnsServerZoneAging -Name lab.test -Aging $true -NoRefreshInterval "1.00:00:00" -RefreshInterval "1.00:00:00"';

  it('TÉMOIN : vieillissement coupé, rien n est jamais nettoyé', async () => {
    const { wns, pc } = await lab(false);
    await update(pc, 'alice', ['update add old.lab.test 300 A 10.0.0.9']);
    wns.advanceTime(30 * DAY);
    await run(wns, 'Start-DnsServerScavenging');
    expect(await records(wns, '-Name old')).toContain('10.0.0.9');
  });

  it('un enregistrement dynamique est horodaté, un statique ne l est pas', async () => {
    const { wns, pc } = await lab(false);
    await run(wns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.0.5');
    await update(pc, 'alice', ['update add dyn.lab.test 300 A 10.0.0.9']);
    expect(await stampOf(wns, 'dyn')).toMatch(/\d/);
    expect(await stampOf(wns, 'www')).toBe('');
  });

  it('Set/Get-DnsServerZoneAging portent les intervalles et la date de disponibilité', async () => {
    const { wns } = await lab(false);
    await run(wns, aging);
    const out = await run(wns, 'Get-DnsServerZoneAging -Name lab.test');
    expect(out).toMatch(/AgingEnabled\s*:\s*True/);
    expect(out).toMatch(/AvailForScavengeTime\s*:\s*\S/);
    expect(out).toMatch(/NoRefreshInterval\s*:\s*1\.00:00:00/);
  });

  it('après NoRefresh + Refresh, Start-DnsServerScavenging retire le dynamique et garde le statique', async () => {
    const { wns, pc } = await lab(false);
    await run(wns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.0.5');
    await update(pc, 'alice', ['update add dyn.lab.test 300 A 10.0.0.9']);
    await run(wns, aging);
    wns.advanceTime(1.5 * DAY);
    await run(wns, 'Start-DnsServerScavenging');
    expect(await records(wns, '-Name dyn')).toContain('10.0.0.9');
    wns.advanceTime(1 * DAY);
    await run(wns, 'Start-DnsServerScavenging');
    expect(await records(wns, '-Name dyn')).not.toContain('10.0.0.9');
    expect(await records(wns, '-Name www')).toContain('10.0.0.5');
  });

  it('-AgeRecord rend un enregistrement statique éligible au nettoyage', async () => {
    const { wns } = await lab(false);
    await run(wns, aging);
    await run(wns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name aged -IPv4Address 10.0.0.7 -AgeRecord');
    wns.advanceTime(2.5 * DAY);
    await run(wns, 'Start-DnsServerScavenging');
    expect(await records(wns, '-Name aged')).not.toContain('10.0.0.7');
  });

  it('un renouvellement dans l intervalle No-Refresh garde l horodatage, après il le rafraîchit', async () => {
    const { wns, pc } = await lab(false);
    await run(wns, aging);
    await update(pc, 'alice', ['update add dyn.lab.test 300 A 10.0.0.9']);
    const stamped = await stampOf(wns, 'dyn');
    wns.advanceTime(0.5 * DAY);
    await update(pc, 'alice', ['update add dyn.lab.test 300 A 10.0.0.9']);
    expect(await stampOf(wns, 'dyn')).toBe(stamped);
    wns.advanceTime(1 * DAY);
    await update(pc, 'alice', ['update add dyn.lab.test 300 A 10.0.0.9']);
    expect(await stampOf(wns, 'dyn')).not.toBe(stamped);
  });

  it('le nettoyage automatique tourne à son intervalle quand ScavengingState est vrai', async () => {
    const { wns, pc } = await lab(false);
    await update(pc, 'alice', ['update add dyn.lab.test 300 A 10.0.0.9']);
    await run(wns, aging);
    await run(wns, 'Set-DnsServerScavenging -ScavengingState $true -ScavengingInterval "1.00:00:00"');
    wns.advanceTime(3 * DAY);
    expect(await records(wns, '-Name dyn')).not.toContain('10.0.0.9');
    expect(await run(wns, 'Get-DnsServerScavenging')).toMatch(/ScavengingState\s*:\s*True/);
  });

  it('-ScavengeServers qui ne nomme pas ce serveur empêche le nettoyage', async () => {
    const { wns, pc } = await lab(false);
    await update(pc, 'alice', ['update add dyn.lab.test 300 A 10.0.0.9']);
    await run(wns, `${aging} -ScavengeServers 10.0.0.77`);
    wns.advanceTime(3 * DAY);
    await run(wns, 'Start-DnsServerScavenging');
    expect(await records(wns, '-Name dyn')).toContain('10.0.0.9');
  });

  it('un intervalle inférieur à une heure est refusé', async () => {
    const { wns } = await lab(false);
    expect(await run(wns, 'Set-DnsServerZoneAging -Name lab.test -Aging $true -RefreshInterval "00:10:00"')).toMatch(/at least one hour/);
  });
});

describe('zones inverses classless (RFC 2317) et IPv6', () => {
  it('-NetworkId /25 crée la zone 0/25 ; -CreatePtr y pose le PTR, le CNAME va dans la zone parente', async () => {
    const { wns } = await lab(false);
    await run(wns, 'Add-DnsServerPrimaryZone -Name lab.test2');
    await run(wns, 'Add-DnsServerPrimaryZone -NetworkId 10.0.1.0/24');
    await run(wns, 'Add-DnsServerPrimaryZone -NetworkId 10.0.1.0/25');
    expect(await run(wns, 'Get-DnsServerZone')).toContain('0/25.1.0.10.in-addr.arpa');
    await run(wns, 'Add-DnsServerResourceRecordA -ZoneName lab.test2 -Name www -IPv4Address 10.0.1.5 -CreatePtr');
    expect(await run(wns, 'Get-DnsServerResourceRecord -ZoneName "0/25.1.0.10.in-addr.arpa" -RRType PTR')).toContain('www.lab.test2');
    expect(await run(wns, 'Get-DnsServerResourceRecord -ZoneName 1.0.10.in-addr.arpa -RRType CNAME')).toContain('5.0/25.1.0.10.in-addr.arpa');
  });

  it('un préfixe hors octet plus large qu un /24, et des bits d hôte, sont refusés', async () => {
    const { wns } = await lab(false);
    expect(await run(wns, 'Add-DnsServerPrimaryZone -NetworkId 10.0.0.0/20')).toMatch(/RFC 2317/);
    expect(await run(wns, 'Add-DnsServerPrimaryZone -NetworkId 10.0.1.64/25')).toMatch(/0\/25|host bits/);
  });

  it('-NetworkId IPv6 crée la zone ip6.arpa ; -CreatePtr y pose le PTR d un AAAA', async () => {
    const { wns } = await lab(false);
    await run(wns, 'Add-DnsServerPrimaryZone -NetworkId 2001:db8::/32');
    expect(await run(wns, 'Get-DnsServerZone')).toContain('8.b.d.0.1.0.0.2.ip6.arpa');
    await run(wns, 'Add-DnsServerResourceRecordAAAA -ZoneName lab.test -Name v6 -IPv6Address 2001:db8::5 -CreatePtr');
    expect(await run(wns, 'Get-DnsServerResourceRecord -ZoneName 8.b.d.0.1.0.0.2.ip6.arpa -RRType PTR')).toContain('v6.lab.test');
  });

  it('un préfixe IPv6 hors frontière de quartet est refusé', async () => {
    const { wns } = await lab(false);
    expect(await run(wns, 'Add-DnsServerPrimaryZone -NetworkId 2001:db8::/33')).toMatch(/nibble boundary/);
  });
});
