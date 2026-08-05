/**
 * Suivi d'objets + IP SLA, surface CLI.
 *
 * Ce fichier date de l'époque où IP SLA était une façade qui déduisait la
 * joignabilité de la table de routage (cf. docs/PRD-IP-SLA.md §0.1). Trois
 * de ses assertions décrivaient cette façade et non IOS ; elles sont
 * corrigées ici plutôt que conservées :
 *   - `show track` rend le nom de l'état SUIVI (`Line protocol is Up`,
 *     `Reachability is Up`), pas un générique « State is Up » ;
 *   - `show ip sla statistics` ne contient ni « reachable » ni
 *     « unreachable » — ce mot n'existe dans aucune sortie IOS ; une
 *     opération qui n'a pas encore sondé répond « No statistics gathered ».
 * Les mesures elles-mêmes vivent dans probe-ip-sla-sonde-reelle.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cisco object tracking — real resolved state', () => {
  it('track interface line-protocol follows the REAL port', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('track 1 interface GigabitEthernet0/0 line-protocol'))
      .not.toMatch(/Invalid input/);
    await r.executeCommand('exit');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('show track 1')).toMatch(/Line protocol is Up/);

    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('show track 1')).toMatch(/Line protocol is Down/);
  });

  it('track ip route reachability uses the REAL routing table', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    await r.executeCommand('ip route 10.10.0.0 255.255.0.0 192.168.1.2');
    await r.executeCommand('track 2 ip route 10.10.0.0 255.255.0.0 reachability');
    await r.executeCommand('end');
    expect(await r.executeCommand('show track 2')).toMatch(/Reachability is Up/);
    expect(await r.executeCommand('show track brief')).toContain('2');
  });

  it('composite list boolean track combines member states', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    await r.executeCommand('track 1 interface GigabitEthernet0/0 line-protocol');
    await r.executeCommand('exit');
    await r.executeCommand('track 2 interface GigabitEthernet0/1 line-protocol');
    await r.executeCommand('exit');
    await r.executeCommand('track 10 list boolean and');
    await r.executeCommand('object 1');
    await r.executeCommand('object 2');
    await r.executeCommand('end');
    // Gi0/1 is down ⇒ AND ⇒ Down (real composition, not a stub).
    expect(await r.executeCommand('show track 10')).toMatch(/State is Down/);
    expect(await r.executeCommand('show track 10')).toContain('List boolean and');
  });
});

describe('Cisco IP SLA — la configuration est relue telle qu\'elle a été tapée', () => {
  it('ip sla operation is recorded and projected', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    expect(await r.executeCommand('ip sla 1')).not.toMatch(/Invalid input/);
    await r.executeCommand('icmp-echo 192.168.1.9 source-interface GigabitEthernet0/0');
    await r.executeCommand('frequency 5');
    await r.executeCommand('exit');
    await r.executeCommand('ip sla schedule 1 life forever start-time now');
    await r.executeCommand('ip sla responder');
    await r.executeCommand('end');

    const cfg = await r.executeCommand('show ip sla configuration');
    expect(cfg).toContain('192.168.1.9');
    expect(cfg).toMatch(/icmp-echo/);
    const stats = await r.executeCommand('show ip sla statistics');
    expect(stats).not.toMatch(/Invalid input/);
    expect(stats).toContain('IPSLA operation id: 1');
    expect(await r.executeCommand('show ip sla responder')).toMatch(/Enabled/);
  });
});
