/**
 * `logging host` — les messages QUITTENT la machine.
 *
 * Le tampon local se lit sur la machine ; un collecteur externe est ce
 * qu'on interroge quand la machine, elle, n'est plus joignable. C'est donc
 * la moitie qui compte en exploitation, et c'est celle qui manquait.
 *
 * Audit fait avant d'ecrire : `SyslogAgent` existe, il emet de VRAIS
 * datagrammes UDP/514 et son contrat d'hote (`SyslogHost`) ne demande que
 * `getHostname`/`getPort`/`getPorts`/`sendFrame` — un `Firewall` les a
 * tous. Mieux, `CiscoShellBase` portait deja la projection
 * `LoggingConfig` → `SyslogAgent` ; elle a ete EXTRAITE
 * (`syslog/loggingProjection.ts`) plutot que recopiee, et les deux
 * appelants la partagent. Une seconde projection aurait fini par
 * contredire la premiere sur la severite ou la facilite.
 *
 * Ce fichier compte les TRAMES. Une configuration qui s'affiche
 * correctement sans qu'aucun datagramme ne parte est exactement le defaut
 * « accepte et inerte » que ce depot referme partout — et il ne se voit
 * qu'en regardant le cable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { AsaShell } from '@/network/devices/firewall/vendors/asa/AsaShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(shell: AsaShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = shell.execute(line);
  return last;
}

async function buildLab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);
  const shell = new AsaShell(fw);
  const inside = new LinuxPC('linux-pc', 'INSIDE', -100, 0);
  const collector = new LinuxPC('linux-pc', 'COLLECTEUR', 100, 0);

  new Cable('a').connect(inside.getPort('eth0')!, fw.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(fw.getPort('GigabitEthernet0/1')!, collector.getPort('eth0')!);

  run(shell, 'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'nameif inside',
    'ip address 192.168.1.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/1', 'nameif outside',
    'ip address 203.0.113.1 255.255.255.0', 'exit',
    'logging enable', 'logging buffered debugging', 'end');

  await runOn(inside, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(collector, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, shell, inside, collector };
}

function countSyslogFrames(fw: AsaFirewall): () => number {
  let sent = 0;
  fw.attachCapture(({ direction }) => {
    if (direction === 'out') sent++;
  }, 'GigabitEthernet0/1');
  return () => sent;
}

beforeEach(() => { Logger.reset(); });

describe('`logging host` declare un collecteur', () => {
  it('la commande est acceptee et le collecteur est retenu', async () => {
    const { fw, shell } = await buildLab();

    run(shell, 'configure terminal', 'logging host outside 203.0.113.10', 'end');

    expect(fw.getLoggingConfig().hosts).toContain('203.0.113.10');
  });

  it('l\'agent du depot le connait aussi — un seul magasin, deux vues', async () => {
    const { fw, shell } = await buildLab();

    run(shell, 'configure terminal', 'logging host outside 203.0.113.10', 'end');

    expect(fw.getSyslogAgent().listServers().map(s => s.ip)).toContain('203.0.113.10');
  });

  it('la configuration rendue le reproduit', async () => {
    const { shell } = await buildLab();
    run(shell, 'configure terminal', 'logging host outside 203.0.113.10', 'end');

    expect(run(shell, 'show running-config')).toContain('logging host');
  });

  it('`no logging host` le retire des DEUX vues', async () => {
    const { fw, shell } = await buildLab();
    run(shell, 'configure terminal', 'logging host outside 203.0.113.10');

    run(shell, 'no logging host outside 203.0.113.10', 'end');

    expect(fw.getLoggingConfig().hosts).not.toContain('203.0.113.10');
    expect(fw.getSyslogAgent().listServers()).toHaveLength(0);
  });

  it('`show logging` annonce le collecteur', async () => {
    const { shell } = await buildLab();
    run(shell, 'configure terminal', 'logging host outside 203.0.113.10', 'end');

    expect(run(shell, 'show logging')).toContain('203.0.113.10');
  });
});

describe('les messages SORTENT vraiment sur le cable', () => {
  it('un refus fait partir au moins un datagramme', async () => {
    const { fw, shell, inside } = await buildLab();
    run(shell, 'configure terminal', 'logging trap debugging',
      'logging host outside 203.0.113.10', 'end');
    const emises = countSyslogFrames(fw);

    await pingOnSimulatedClock(inside, 'ping -c 1 198.51.100.9');

    expect(emises()).toBeGreaterThan(0);
  });

  it('SANS collecteur, rien ne part par ce port — le temoin', async () => {
    const { fw, shell, inside } = await buildLab();
    run(shell, 'configure terminal', 'logging trap debugging', 'end');
    const emises = countSyslogFrames(fw);

    await pingOnSimulatedClock(inside, 'ping -c 1 198.51.100.9');

    expect(emises()).toBe(0);
  });

  it('plus de trafic journalise, plus de datagrammes', async () => {
    const un = await buildLab();
    run(un.shell, 'configure terminal', 'logging trap debugging',
      'logging host outside 203.0.113.10', 'end');
    const compteUn = countSyslogFrames(un.fw);
    await pingOnSimulatedClock(un.inside, 'ping -c 1 198.51.100.9');
    const apresUn = compteUn();

    const trois = await buildLab();
    run(trois.shell, 'configure terminal', 'logging trap debugging',
      'logging host outside 203.0.113.10', 'end');
    const compteTrois = countSyslogFrames(trois.fw);
    await pingOnSimulatedClock(trois.inside, 'ping -c 3 198.51.100.9');

    expect(compteTrois()).toBeGreaterThan(apresUn);
  });

  it('le seuil `logging trap` filtre ce qui SORT, pas ce qui est retenu', async () => {
    const { fw, shell, inside } = await buildLab();
    run(shell, 'configure terminal', 'logging trap emergencies',
      'logging host outside 203.0.113.10', 'end');
    const emises = countSyslogFrames(fw);

    await pingOnSimulatedClock(inside, 'ping -c 1 198.51.100.9');

    expect(emises()).toBe(0);
    expect(run(shell, 'show logging')).toContain('Deny');
  });
});
