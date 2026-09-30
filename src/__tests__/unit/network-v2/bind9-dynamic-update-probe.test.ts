/**
 * Sonde de la mise à jour dynamique servie par named (RFC 2136, RFC 2845).
 *
 * Mesuré AVANT correctif (git stash push -- src/network) : 8 cas sur 10 tombent.
 *   - named.conf refusait `allow-update`, `update-policy` (« unknown option »)
 *   - une requête UPDATE recevait NOTIMP du moteur de requêtes : aucun ajout
 *     n'était possible, signé ou non
 *   - un secret `key {}` base64 n'était pas décodé aux frontières (nsupdate -y)
 * Passent avant et après (témoins) : la zone statique reste consultable et un
 * nsupdate vers une zone sans allow-update ne modifie rien.
 *
 * Les secrets sont en base64 comme dans named.conf ; le clair de la clé est
 * « secret-partage ».
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

const SECRET = 'c2VjcmV0LXBhcnRhZ2U=';
const WRONG = 'cGFzLWxlLWJvbg==';

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@ IN SOA ns1.example.com. admin.example.com. ( 100 3600 900 604800 300 )',
  '  IN NS ns1.example.com.',
  'ns1 IN A 10.0.1.10',
  'www IN A 10.0.1.80',
  '',
].join('\n');

function lab(zoneOptions: string) {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const ns = new LinuxServer('linux-server', 'NS1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [ns, pc].forEach((device, i) => new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]));
  ns.getPorts()[0].configureIP(new IPAddress('10.0.1.10'), mask);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.1.2'), mask);
  writeRoot(ns, '/etc/bind/named.conf', [
    'options { recursion no; };',
    `key "lab-key" { algorithm hmac-sha256; secret "${SECRET}"; };`,
    'zone "example.com" {',
    '  type primary;',
    '  file "/etc/bind/db.example.com";',
    `  ${zoneOptions}`,
    '};',
    '',
  ].join('\n'));
  writeRoot(ns, '/etc/bind/db.example.com', ZONE_DB);
  return { ns, pc };
}

async function nsupdate(pc: LinuxPC, lines: string[], key?: string): Promise<string> {
  const script = ['server 10.0.1.10', 'zone example.com', ...lines, 'send'].join('\\n');
  const flag = key ? ` -y hmac-sha256:lab-key:${key}` : '';
  return pc.executeCommand(`printf '${script}\\n' | nsupdate${flag}`);
}

async function resolve(pc: LinuxPC, name: string): Promise<string> {
  return pc.executeCommand(`dig +short @10.0.1.10 ${name}`);
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('named — mise à jour dynamique', () => {
  it('témoin : la zone statique se consulte', async () => {
    const { ns, pc } = lab('');
    await ns.executeCommand('systemctl start named');
    expect(await resolve(pc, 'www.example.com')).toContain('10.0.1.80');
  });

  it('témoin : sans allow-update, la mise à jour ne change rien', async () => {
    const { ns, pc } = lab('');
    await ns.executeCommand('systemctl start named');
    await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99']);
    expect(await resolve(pc, 'new.example.com')).not.toContain('10.0.1.99');
  });

  it('allow-update { any; } accepte un ajout non signé', async () => {
    const { ns, pc } = lab('allow-update { any; };');
    const start = await ns.executeCommand('systemctl start named');
    expect(start).not.toContain('Failed');
    const out = await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99']);
    expect(out.trim()).toBe('');
    expect(await resolve(pc, 'new.example.com')).toContain('10.0.1.99');
  });

  it('une zone sans allow-update REFUSE la mise à jour', async () => {
    const { ns, pc } = lab('');
    await ns.executeCommand('systemctl start named');
    const out = await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99']);
    expect(out).toContain('REFUSED');
  });

  it('allow-update { key lab-key; } refuse le non signé et accepte la bonne clé', async () => {
    const { ns, pc } = lab('allow-update { key lab-key; };');
    await ns.executeCommand('systemctl start named');
    const unsigned = await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99']);
    expect(unsigned).toContain('REFUSED');
    const signed = await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99'], SECRET);
    expect(signed.trim()).toBe('');
    expect(await resolve(pc, 'new.example.com')).toContain('10.0.1.99');
  });

  it('un mauvais secret est refusé en NOTAUTH', async () => {
    const { ns, pc } = lab('allow-update { key lab-key; };');
    await ns.executeCommand('systemctl start named');
    const out = await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99'], WRONG);
    expect(out).toContain('NOTAUTH');
  });

  it('le numéro de série avance après une mise à jour', async () => {
    const { ns, pc } = lab('allow-update { any; };');
    await ns.executeCommand('systemctl start named');
    await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99']);
    const soa = await pc.executeCommand('dig +short @10.0.1.10 example.com SOA');
    expect(soa).toContain(' 101 ');
  });

  it('update-policy grant zonesub : la clé écrit n’importe où dans la zone', async () => {
    const { ns, pc } = lab('update-policy { grant lab-key zonesub ANY; };');
    await ns.executeCommand('systemctl start named');
    const ok = await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99'], SECRET);
    expect(ok.trim()).toBe('');
    expect(await resolve(pc, 'new.example.com')).toContain('10.0.1.99');
  });

  it('update-policy grant name : la clé ne peut écrire qu’au nom désigné', async () => {
    const { ns, pc } = lab('update-policy { grant lab-key name host.example.com. A; };');
    await ns.executeCommand('systemctl start named');
    const denied = await nsupdate(pc, ['update add other.example.com 300 A 10.0.1.99'], SECRET);
    expect(denied).toContain('REFUSED');
    const okName = await nsupdate(pc, ['update add host.example.com 300 A 10.0.1.98'], SECRET);
    expect(okName.trim()).toBe('');
    const wrongType = await nsupdate(pc, ['update add host.example.com 300 TXT hello'], SECRET);
    expect(wrongType).toContain('REFUSED');
  });

  it('rndc freeze écrit les changements dans le fichier de zone, rndc thaw les relit', async () => {
    const { ns, pc } = lab('allow-update { any; };');
    await ns.executeCommand('systemctl start named');
    await nsupdate(pc, ['update add new.example.com 300 A 10.0.1.99']);
    await ns.executeCommand('rndc freeze example.com');
    expect(vfsOf(ns).readFile('/etc/bind/db.example.com')).toContain('10.0.1.99');
    await ns.executeCommand('rndc thaw example.com');
    expect(await resolve(pc, 'new.example.com')).toContain('10.0.1.99');
  });
});
