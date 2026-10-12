/**
 * Quand `systemd-resolved` redemarre, s'arrete ou meurt, ses sockets meurent avec son processus ; quand l'unite demarre,
 * le demon les rouvre : le stub `127.0.0.53%lo:53` (UDP et TCP) et les repondeurs LLMNR (5355) et mDNS (5353).
 * `systemctl reload` est refuse par l'unite, qui ne declare pas d'`ExecReload` : rien ne change.
 *
 * Mesure de depart (fa7d49a31 et ses descendants jusqu'a a7e9f551f ; vert a 2d36ab993) : apres
 * `systemctl restart systemd-resolved`, le SIGTERM de l'ancien processus (pid 29) faisait fermer par le faucheur de prises
 * -- qui, depuis ce lot, ferme aussi l'ecoute UDP de l'hote -- toutes les lignes sans PID portant le nom de processus
 * `systemd-resolved` ; or rien ne rouvrait le stub ni les repondeurs au demarrage de l'unite, et les agents LLMNR et mDNS
 * croyaient toujours tenir leur socket (`start()` rendait la main quand `bound` etait vrai). `ss -ulnp` ne montrait plus
 * que NTP, un voisin n'obtenait plus de reponse LLMNR, `dig @127.0.0.53` restait sans reponse, et la publication DNS-SD
 * d'un `.dnssd` n'etait plus decouverte : douze cas de `probe-resolvectl-07-dnssd`, `-08-sous-types-et-maj` et
 * `-09-expiration-cache` tombaient. Avant ce lot, le faucheur ne retirait d'une prise UDP que sa ligne et laissait
 * l'ecouteur : les lignes disparaissaient de `ss`, le service continuait. Les deux tables disent maintenant la meme chose ;
 * il reste a faire suivre le cycle de vie du demon.
 *
 * Autorites : le noyau libere les sockets d'un processus a sa mort (`do_exit` puis `exit_files`), donc un demon qui
 * redemarre est un nouveau processus qui rouvre les siennes ; `systemd` v249 (`resolved-llmnr.c`, `resolved-mdns.c`,
 * `resolved-dns-stub.c`) ouvre les sockets au demarrage du demon ; l'unite de systemd v249
 * (`units/systemd-resolved.service.in`, lue sur GitHub) porte `Restart=always` et `RestartSec=0`, donc un demon tue
 * revient. Limite acceptee et deja celle de ces probes : un redemarrage garde l'etat de l'hote (nom mDNS
 * acquis, services annonces, nom LLMNR verifie) au lieu de sonder a nouveau pendant trois quarts de seconde, comme le
 * faisait la simulation avant ce lot.
 *
 * Ce qui est construit : `EndHost.isUdpPortServed` ; `LlmnrAgent` et `MdnsAgent` dont `isRunning()` dit la verite de la
 * socket et dont `start()` rouvre la socket partie sans repartir de zero ; a chaque demarrage de l'unite -- que
 * `systemctl restart` et la relance du superviseur declenchent aussi -- le stub est rouvert (`bindResolvedStub`), et
 * les repondeurs sont resynchronises avec la configuration (`syncLinkLocalResponders`).
 *
 * Discrimination (fichier copie sur a7e9f551f) : 6 cas sur 13 tombent -- le redemarrage rend le stub et les repondeurs, il
 * laisse les voisins obtenir leur reponse, il tient chaque prise une seule fois ; `start` rouvre ce que `stop` a ferme ;
 * chaque agent dit s'il tient sa socket ; systemd relance l'unite tuee avec des prises neuves. Les 7 autres passent des deux
 * cotes : deux temoins du banc (le stub et les repondeurs au demarrage ; un voisin resout l'hote par LLMNR sur le fil),
 * `stop` qui ferme tout et `kill -9` qui emporte les prises avec le processus (non-regressions), `reload` refuse sans rien
 * changer (temoin : l'unite n'a pas d'ExecReload), et les deux cas qui disent que le redemarrage garde l'etat de l'hote (nom
 * mDNS acquis, nom LLMNR verifie), limite acceptee que le code d'avant ce lot respectait et que la reprise des agents doit
 * continuer a respecter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');

interface Lab {
  readonly alpha: LinuxPC;
  readonly bravo: LinuxPC;
  rowsOfBravo(): Promise<string[]>;
  alphaResolvesBravo(): Promise<'network' | 'cache' | 'unknown'>;
}

async function lab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const alpha = new LinuxPC('linux-pc', 'alpha', 0, 0);
  const bravo = new LinuxPC('linux-pc', 'bravo', 0, 0);
  sw.powerOn();
  alpha.powerOn();
  bravo.powerOn();
  new Cable('c1').connect(alpha.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(bravo.getPorts()[0], sw.getPorts()[1]);
  alpha.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  bravo.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  for (const pc of [alpha, bravo]) {
    await pc.executeCommand("sudo sh -c 'printf \"nameserver 127.0.0.53\\n\" > /etc/resolv.conf'");
    await pc.executeCommand('sudo resolvectl mdns eth0 yes');
  }
  return {
    alpha,
    bravo,
    rowsOfBravo: async () => (await bravo.executeCommand('ss -ulnH')).split('\n')
      .map((line) => line.trim().split(/\s+/)[3]).filter((local) => local !== undefined && local !== ''),
    alphaResolvesBravo: async () => {
      await alpha.executeCommand('sudo resolvectl flush-caches');
      const answer = await alpha.executeCommand('resolvectl query bravo');
      if (!answer.includes('10.0.0.2')) return 'unknown';
      return answer.includes('Data from: network') ? 'network' : 'cache';
    },
  };
}

async function untilActive(host: LinuxPC): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await host.executeCommand('systemctl is-active systemd-resolved')).trim() === 'active') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const RESPONDER_ROWS = ['0.0.0.0:5355', '0.0.0.0:5353'];
const STUB_ROW = '127.0.0.53%lo:53';

describe('the bench is sound (witness)', () => {
  it('at boot the host holds its stub on the loopback device and both responders', async () => {
    const { rowsOfBravo } = await lab();
    const rows = await rowsOfBravo();
    for (const row of [STUB_ROW, ...RESPONDER_ROWS]) expect(rows).toContain(row);
  });

  it('a neighbour resolves the host by LLMNR over the wire, and the stub answers on the host', async () => {
    const { alphaResolvesBravo, bravo } = await lab();
    expect(await alphaResolvesBravo()).toBe('network');
    expect(await bravo.executeCommand('dig @127.0.0.53 alpha +short')).toBe('10.0.0.1');
  });
});

describe('systemctl restart systemd-resolved', () => {
  it('gives the stub and the responders back to the new process', async () => {
    const { bravo, rowsOfBravo } = await lab();
    await bravo.executeCommand('sudo systemctl restart systemd-resolved');
    const rows = await rowsOfBravo();
    for (const row of [STUB_ROW, ...RESPONDER_ROWS]) expect(rows).toContain(row);
  });

  it('keeps answering the neighbours: LLMNR over the wire and the stub', async () => {
    const { alphaResolvesBravo, bravo } = await lab();
    await bravo.executeCommand('sudo systemctl restart systemd-resolved');
    expect(await alphaResolvesBravo()).toBe('network');
    expect(await bravo.executeCommand('dig @127.0.0.53 alpha +short')).toBe('10.0.0.1');
  });

  it('keeps what the daemon already announced: the host does not start probing its mDNS name again', async () => {
    const { bravo } = await lab();
    const agent = bravo.getMdnsAgent();
    await agent.whenReady();
    expect(agent.nameState()).toBe('claimed');
    await bravo.executeCommand('sudo systemctl restart systemd-resolved');
    expect(agent.nameState()).toBe('claimed');
  });

  it('keeps what the daemon already verified: the LLMNR name stays unique and is not asked about again', async () => {
    const { bravo } = await lab();
    const agent = bravo.getLlmnrAgent();
    await agent.whenReady();
    expect(agent.nameState()).toBe('unique');
    await bravo.executeCommand('sudo systemctl restart systemd-resolved');
    expect(agent.nameState()).toBe('unique');
  });

  it('holds each socket once: no duplicate of the stub or of a responder', async () => {
    const { bravo, rowsOfBravo } = await lab();
    await bravo.executeCommand('sudo systemctl restart systemd-resolved');
    const rows = await rowsOfBravo();
    for (const row of [STUB_ROW, ...RESPONDER_ROWS]) expect(rows.filter((candidate) => candidate === row)).toHaveLength(1);
  });
});

describe('systemctl stop and start', () => {
  it('stop closes the stub and the responders, and the host stops answering', async () => {
    const { bravo, rowsOfBravo, alphaResolvesBravo } = await lab();
    await bravo.executeCommand('sudo systemctl stop systemd-resolved');
    const rows = await rowsOfBravo();
    for (const row of [STUB_ROW, ...RESPONDER_ROWS]) expect(rows).not.toContain(row);
    expect(await alphaResolvesBravo()).toBe('unknown');
  });

  it('start opens them again', async () => {
    const { bravo, rowsOfBravo, alphaResolvesBravo } = await lab();
    await bravo.executeCommand('sudo systemctl stop systemd-resolved');
    await bravo.executeCommand('sudo systemctl start systemd-resolved');
    const rows = await rowsOfBravo();
    for (const row of [STUB_ROW, ...RESPONDER_ROWS]) expect(rows).toContain(row);
    expect(await alphaResolvesBravo()).toBe('network');
  });

  it('each responder agent says whether it holds its socket: yes at boot, no once the daemon is stopped, yes once started', async () => {
    const { bravo } = await lab();
    const holding = () => [bravo.getLlmnrAgent().isRunning(), bravo.getMdnsAgent().isRunning()];
    expect(holding()).toEqual([true, true]);
    await bravo.executeCommand('sudo systemctl stop systemd-resolved');
    expect(holding()).toEqual([false, false]);
    await bravo.executeCommand('sudo systemctl start systemd-resolved');
    expect(holding()).toEqual([true, true]);
  });
});

describe('systemctl reload and kill', () => {
  it('reload is refused, as systemd refuses it for a unit without ExecReload, and changes nothing: same process, same sockets, inodes included', async () => {
    const { bravo } = await lab();
    const before = { pid: (await bravo.executeCommand('pidof systemd-resolved')).trim(), table: await bravo.executeCommand('ss -uleH') };
    const answer = await bravo.executeCommand('sudo systemctl reload systemd-resolved');
    expect(answer).toContain('Job type reload is not applicable for unit systemd-resolved.service');
    expect((await bravo.executeCommand('pidof systemd-resolved')).trim()).toBe(before.pid);
    expect(await bravo.executeCommand('ss -uleH')).toBe(before.table);
  });

  it('kill -9 takes the sockets with the process: the responders and the stub are gone and the neighbour is not answered', async () => {
    const { bravo, rowsOfBravo, alphaResolvesBravo } = await lab();
    const pid = (await bravo.executeCommand('pidof systemd-resolved')).trim();
    await bravo.executeCommand(`sudo kill -9 ${pid}`);
    const rows = await rowsOfBravo();
    for (const row of [STUB_ROW, ...RESPONDER_ROWS]) expect(rows).not.toContain(row);
    expect(await alphaResolvesBravo()).toBe('unknown');
  });

  it('systemd relaunches the killed unit and the new process opens the stub and the responders again, for a new pid', async () => {
    const { bravo, rowsOfBravo, alphaResolvesBravo } = await lab();
    const pid = (await bravo.executeCommand('pidof systemd-resolved')).trim();
    await bravo.executeCommand(`sudo kill -9 ${pid}`);
    await untilActive(bravo);
    expect((await bravo.executeCommand('pidof systemd-resolved')).trim()).not.toBe(pid);
    const rows = await rowsOfBravo();
    for (const row of [STUB_ROW, ...RESPONDER_ROWS]) expect(rows).toContain(row);
    expect(await alphaResolvesBravo()).toBe('network');
  });
});
