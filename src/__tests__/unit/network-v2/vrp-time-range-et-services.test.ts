import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { IPAddress } from '@/network/core/types';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { replayVendorConfig } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function routeur(cmds: string[] = []) {
  const r = new HuaweiRouter('R', 0, 0);
  for (const c of ['system-view', ...cmds, 'quit']) await r.executeCommand(c);
  return r;
}

const config = async (r: HuaweiRouter) =>
  ((await r.executeCommand('display current-configuration')) ?? '')
    .split('\n').map((l) => l.trim());

const paquet = () => ({
  type: 'ipv4', version: 4, ihl: 5, dscp: 0, ecn: 0, totalLength: 40,
  identification: 1, flags: 0, fragmentOffset: 0, ttl: 64, protocol: 6, checksum: 0,
  sourceIP: new IPAddress('10.0.0.5'), destinationIP: new IPAddress('8.8.8.8'),
  payload: {},
});

const LAB = [
  'time-range OUVERT 08:00 to 18:00 daily',
  'acl number 3000',
  'rule 5 permit ip source 10.0.0.0 0.0.0.255 time-range OUVERT',
  'quit',
];

describe('VRP — une règle horaire s\'applique à l\'heure dite', () => {
  it('permet dans la plage et refuse en dehors', async () => {
    const r = await routeur(LAB);
    expect(r.evaluateACLByName('3000', paquet() as never, new Date('2026-08-20T12:00:00')))
      .toBe('permit');
    expect(r.evaluateACLByName('3000', paquet() as never, new Date('2026-08-20T03:00:00')))
      .toBe('deny');
  });

  it('la règle garde sa plage dans la configuration', async () => {
    expect(await config(await routeur(LAB)))
      .toContain('rule 5 permit ip source 10.0.0.0 0.0.0.255 time-range OUVERT');
  });

  it('la plage elle-même se rend sous l\'orthographe de VRP', async () => {
    expect(await config(await routeur(['time-range OUVERT 08:00 to 18:00 daily'])))
      .toContain('time-range OUVERT 08:00 to 18:00 daily');
  });

  it('déclare la plage AVANT la règle qui la nomme', async () => {
    const l = await config(await routeur(LAB));
    expect(l.findIndex((x) => x.startsWith('time-range OUVERT')))
      .toBeLessThan(l.findIndex((x) => x.startsWith('rule 5 ')));
  });

  it('traduit les jours ouvrés de VRP', async () => {
    expect(await config(await routeur(['time-range TR 09:00 to 17:00 working-day'])))
      .toContain('time-range TR 09:00 to 17:00 working-day');
  });

  it('refuse une plage mal formée plutôt que de la ranger', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    await r.executeCommand('system-view');
    expect(await r.executeCommand('time-range TR zorglub')).toMatch(/Wrong parameter/);
    expect(await r.executeCommand('time-range TR 25:00 to 18:00 daily')).toMatch(/Wrong parameter/);
    await r.executeCommand('quit');
    expect((await config(r)).filter((x) => x.startsWith('time-range'))).toHaveLength(0);
  });

  it('survit à un aller-retour export → import, règle comprise', async () => {
    const r = await routeur(LAB);
    const texte = (await r.executeCommand('display current-configuration')) ?? '';
    const r2 = new HuaweiRouter('R2', 0, 0);
    await replayVendorConfig(r2, texte);
    expect(r2.evaluateACLByName('3000', paquet() as never, new Date('2026-08-20T03:00:00')))
      .toBe('deny');
  });
});

describe('VRP — les services de gestion reviennent d\'un export', () => {
  it('rend `ftp server enable` et `telnet server enable`', async () => {
    const l = await config(await routeur(['ftp server enable', 'telnet server enable']));
    expect(l).toContain('ftp server enable');
    expect(l).toContain('telnet server enable');
  });

  it('la forme `undo` les retire de la configuration', async () => {
    const l = await config(await routeur([
      'ftp server enable', 'telnet server enable',
      'undo ftp server enable', 'undo telnet server enable',
    ]));
    expect(l).not.toContain('ftp server enable');
    expect(l).not.toContain('telnet server enable');
  });

  it('n\'écrit rien tant qu\'aucun n\'est démarré', async () => {
    const l = await config(await routeur());
    expect(l.filter((x) => /^(ftp|telnet) server/.test(x))).toHaveLength(0);
  });
});

describe('VRP — ce que ce simulateur ne porte pas est refusé', () => {
  it('refuse toute la famille IS-IS en nommant le moteur absent', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0']) await r.executeCommand(c);
    for (const cmd of ['isis enable 1', 'isis circuit-level level-2', 'isis cost 10']) {
      expect(await r.executeCommand(cmd), cmd).toMatch(/no IS-IS engine/);
    }
  });

  it('rend l\'application d\'une politique de trafic sur l\'interface', async () => {
    const r = new HuaweiRouter('R', 0, 0);
    for (const c of ['system-view', 'traffic policy P1', 'quit',
      'interface GigabitEthernet0/0/0', 'undo shutdown',
      'ip address 10.0.0.1 255.255.255.0', 'traffic-policy P1 inbound', 'quit', 'quit']) {
      await r.executeCommand(c);
    }
    const section = ((await r.executeCommand('display current-configuration interface GigabitEthernet0/0/0')) ?? '')
      .split('\n').map((l) => l.trim());
    expect(section).toContain('traffic-policy P1 inbound');
  });
});
