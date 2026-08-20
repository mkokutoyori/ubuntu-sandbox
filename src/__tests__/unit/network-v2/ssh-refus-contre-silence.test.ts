/**
 * Un REFUS et un SILENCE sont deux diagnostics, pas un seul.
 *
 * La distinction existe deja UNE COUCHE PLUS BAS et elle est jetee :
 * `TcpStack.connectOutcome` rend `'refused'` quand le pair repond par un
 * RST ou un ICMP inaccessible, et `'timeout'` quand rien ne revient
 * (rejet silencieux, pas de route) — son propre commentaire le dit. Mais
 * `EndHost.tcpConnect` ne rend qu'un `null` sans motif, donc
 * `SshSession.connect` appelle les deux `CONNECTION_REFUSED`, et le
 * terminal ecrit « Connection refused » dans les deux cas.
 *
 * C'est le diagnostic qui coute le plus cher a inverser, et la
 * documentation d'OpenSSH comme celle de tous les guides de depannage le
 * disent dans les memes termes : un pare-feu qui REJETTE donne
 * « Connection refused » et envoie regarder si le service tourne ; un
 * pare-feu qui JETTE donne « Connection timed out » et envoie regarder une
 * regle de filtrage. Un simulateur qui repond « refused » a un paquet jete
 * apprend le mauvais reflexe — et c'est exactement ce que fait
 * `allowaccess` sur un FortiGate, dont le rejet est silencieux.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai client :
 *
 *   1. **Un port ferme sur une machine joignable** rend
 *      `ssh: connect to host <h> port <p>: Connection refused`, et tout de
 *      suite — le RST revient sans attendre.
 *   2. **Un paquet JETE** rend
 *      `ssh: connect to host <h> port <p>: Connection timed out`, apres le
 *      repli de retransmission, et ne dit JAMAIS « refused ».
 *   3. **Le socle sait deja distinguer les deux** dans le meme
 *      laboratoire : c'est le temoin, sans lequel un laboratoire mal bati
 *      et un defaut seraient indiscernables.
 *   4. **`tcpDial` porte le motif** au lieu d'un `null` muet, pour tout
 *      appelant et pas seulement SSH.
 *   5. **Chaque plateforme le dit dans SES mots**, sur un vrai
 *      equipement : Cisco `% Connection timed out; remote host not
 *      responding`, Linux `Connection timed out`, Huawei et Windows une
 *      seule formulation pour les deux causes, comme les vraies machines.
 *   6. **Un port de destination est un PORT** : `telnet <hote> 99999` est
 *      refuse au lieu d'etre compose, parce que le port traverse
 *      `PortNumber` et non un `number` nu.
 *   7. **Le type d'adresse couvre LES DEUX familles.** Ce cas est ne d'une
 *      regression que la suite complete a attrapee : typer l'adresse avec
 *      `IPAddress` seul — qui est IPv4 — faisait rendre `null` a
 *      `tcpConnect` pour toute destination IPv6, ce qui cassait le repli
 *      DNS sur TCP. `parseDialAddress` rend `IPAddress | IPv6Address`.
 *
 * Discrimination (`git stash push -- src/network/ src/terminal/`) : 9 des
 * 15 cas d'origine tombent avant correctif. Les 6 autres sont nommes ici plutot que
 * laisses a decouvrir, et aucun ne prouve le mecanisme :
 *   - les deux temoins du socle passent des deux cotes — c'est leur
 *     objet, ils etablissent que `connectOutcome` distinguait DEJA ;
 *   - « un demon arrete donne Connection refused » et « un routeur Cisco
 *     garde % Connection refused » passaient parce que le REFUS etait
 *     deja juste, et c'est precisement ce qui rendait le defaut
 *     invisible ;
 *   - Huawei et Windows passent des deux cotes parce que leur formulation
 *     unique couvre les deux causes sur la vraie machine — ils verifient
 *     une decision, pas une correction.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { parseDialAddress } from '@/network/tcp/dial';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const CLIENT = '192.168.1.10';
const SILENCIEUX = '192.168.1.1';
const BAVARD = '192.168.1.53';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function typeLine(session: TerminalSession, line: string): Promise<void> {
  const foreground = session.foreground;
  foreground.setInput(line);
  foreground.setInputBuf(line);
  session.handleKey(key('Enter'));
  for (let i = 0; i < 12; i++) await new Promise<void>((r) => setTimeout(r, 5));
}

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

/**
 * Le repli de retransmission d'un SYN dure une minute d'horloge. On la
 * fait passer par tranches, en laissant respirer les micro-taches entre
 * chaque, parce que la resolution traverse une chaine de promesses.
 */
async function laisserExpirer(clock: VirtualTimeScheduler): Promise<void> {
  for (let i = 0; i < 40; i++) {
    clock.advance(4000);
    for (let t = 0; t < 4; t++) await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);

  const poste = new LinuxPC('linux-pc', 'PC', 0, 0);
  const pareFeu = new FortiGate('firewall-fortinet', 'FGT', 150, 0);
  const serveur = new LinuxServer('linux-server', 'SRV', -150, 0);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  poste.powerOn(); serveur.powerOn(); commutateur.powerOn();

  new Cable('a').connect(poste.getPorts()[0], commutateur.getPort('eth0')!);
  new Cable('b').connect(pareFeu.getPort('port1')!, commutateur.getPort('eth1')!);
  new Cable('c').connect(serveur.getPorts()[0], commutateur.getPort('eth2')!);

  const shell = pareFeu.getShell();
  for (const line of [
    'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${SILENCIEUX} 255.255.255.0`, 'set allowaccess ping', 'next', 'end']) {
    shell.execute(line);
  }

  const mask = new SubnetMask('255.255.255.0');
  serveur.getPorts()[0].configureIP(new IPAddress(BAVARD), mask);
  await runOn(poste, ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`]);

  return { poste, serveur, pareFeu, commutateur, clock };
}

function transcript(host: TerminalSession): string {
  return host.lines.map((l) => l.text).join('\n');
}

afterEach(() => { __setDefaultScheduler(null); });

describe('le socle distingue deja le refus du silence — le temoin', () => {
  it('un demon arrete sur une machine joignable est un REFUS', async () => {
    const { poste, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl stop ssh']);

    expect(poste.tcpConnectOutcome(new IPAddress(BAVARD), 22)).toBe('refused');
  });

  it('un paquet jete par le pare-feu est un SILENCE', async () => {
    const { poste, clock } = await laboratoire();

    const verdict = poste.tcpConnectOutcome(new IPAddress(SILENCIEUX), 22);
    void clock;

    expect(verdict).toBe('timeout');
  });
});

describe('`tcpDial` porte le motif au lieu d`un null muet', () => {
  it('un refus est rendu comme un refus', async () => {
    const { poste, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl stop ssh']);

    const issue = await poste.tcpDial(new IPAddress(BAVARD), PortNumber.of(22));

    expect(issue).toEqual({ dialFailed: 'refused' });
  });

  it('un silence est rendu comme un silence', async () => {
    const { poste, clock } = await laboratoire();

    const pending = poste.tcpDial(new IPAddress(SILENCIEUX), PortNumber.of(22));
    await laisserExpirer(clock);

    expect(await pending).toEqual({ dialFailed: 'timeout' });
  });

  it('une adresse IPv6 reste composable — le type d`adresse couvre LES DEUX familles', async () => {
    const { poste } = await laboratoire();

    expect(parseDialAddress('2001:db8::1')).not.toBeNull();
    expect(parseDialAddress('192.168.1.1')).not.toBeNull();
    expect(parseDialAddress('pas-une-adresse')).toBeNull();
    expect(await poste.tcpConnect('2001:db8::99', 53)).toBeNull();
  });

  it('une connexion qui aboutit rend la socket', async () => {
    const { poste, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl start ssh']);

    const issue = await poste.tcpDial(new IPAddress(BAVARD), PortNumber.of(22));

    expect(issue).toHaveProperty('state');
  });
});

describe('le port de destination est un PORT, pas un entier', () => {
  it('`telnet <hote> 99999` est refuse plutot que compose', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    await typeLine(host, `telnet ${BAVARD} 99999`);

    expect(transcript(host)).toMatch(/usage: telnet/);
    expect(transcript(host)).not.toMatch(/Trying/);
  });

  it('`telnet <hote> zero` est refuse de meme', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    await typeLine(host, `telnet ${BAVARD} 0`);

    expect(transcript(host)).toMatch(/usage: telnet/);
  });
});

describe('chaque plateforme dit le silence dans ses propres mots', () => {
  it('un routeur Cisco ecrit `% Connection timed out`', async () => {
    const { commutateur, clock } = await laboratoire();
    const routeur = new CiscoRouter('R1', 0, 0);
    routeur.powerOn();
    new Cable('d').connect(routeur.getPorts()[0], commutateur.getPort('eth3')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.1.20 255.255.255.0', 'no shutdown', 'end']) {
      await routeur.executeCommand(c);
    }
    const term = new CiscoTerminalSession('c', routeur);
    await term.init?.();

    await typeLine(term, `telnet ${SILENCIEUX}`);
    await laisserExpirer(clock);

    expect(transcript(term)).toMatch(/% Connection timed out; remote host not responding/);
    expect(transcript(term)).not.toMatch(/refused/);
  });

  it('un routeur Cisco garde `% Connection refused` pour un vrai refus', async () => {
    const { commutateur, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl stop ssh']);
    const routeur = new CiscoRouter('R1', 0, 0);
    routeur.powerOn();
    new Cable('d').connect(routeur.getPorts()[0], commutateur.getPort('eth3')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.1.20 255.255.255.0', 'no shutdown', 'end']) {
      await routeur.executeCommand(c);
    }
    const term = new CiscoTerminalSession('c', routeur);
    await term.init?.();

    await typeLine(term, `telnet ${BAVARD} 22`);

    expect(transcript(term)).toMatch(/% Connection refused by remote host/);
  });

  it('un routeur Huawei garde UNE formulation, comme la vraie machine', async () => {
    const { commutateur, clock } = await laboratoire();
    const routeur = new HuaweiRouter('hwR1', 0, 0);
    routeur.powerOn();
    new Cable('d').connect(routeur.getPorts()[0], commutateur.getPort('eth3')!);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 192.168.1.30 255.255.255.0', 'undo shutdown', 'quit', 'quit']) {
      await routeur.executeCommand(c);
    }
    const term = new HuaweiTerminalSession('h', routeur);
    await term.init?.();

    await typeLine(term, `telnet ${SILENCIEUX}`);
    await laisserExpirer(clock);

    expect(transcript(term)).toMatch(/Error: Failed to connect to the remote host\./);
  });

  it('une machine Windows dit `Connect failed`, comme telnet.exe', async () => {
    const { commutateur, clock } = await laboratoire();
    const machine = new WindowsPC('windows-pc', 'WIN', 0, 0);
    machine.powerOn();
    new Cable('d').connect(machine.getPorts()[0], commutateur.getPort('eth3')!);
    await machine.executeCommand(
      'netsh interface ip set address "Ethernet0" static 192.168.1.40 255.255.255.0');
    const term = new WindowsTerminalSession('w', machine);
    await term.init?.();

    await typeLine(term, `telnet ${SILENCIEUX}`);
    await laisserExpirer(clock);

    expect(transcript(term)).toMatch(/Could not open connection to the host/);
  });
});

describe('le client SSH nomme le bon diagnostic', () => {
  it('un demon arrete donne `Connection refused`', async () => {
    const { poste, serveur } = await laboratoire();
    await runOn(serveur, ['systemctl stop ssh']);
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    host.setInput(`ssh root@${BAVARD}`);
    host.handleKey(key('Enter'));
    for (let i = 0; i < 40; i++) await new Promise<void>((r) => setTimeout(r, 15));

    expect(transcript(host)).toMatch(/Connection refused/);
  });

  it('un paquet jete donne `Connection timed out`', async () => {
    const { poste, clock } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    host.setInput(`ssh admin@${SILENCIEUX}`);
    host.handleKey(key('Enter'));
    await laisserExpirer(clock);

    expect(transcript(host)).toMatch(/Connection timed out/);
  });

  it('un paquet jete ne dit JAMAIS `refused`', async () => {
    const { poste, clock } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    host.setInput(`ssh admin@${SILENCIEUX}`);
    host.handleKey(key('Enter'));
    await laisserExpirer(clock);

    expect(transcript(host)).not.toMatch(/Connection refused/);
  });

  it('le message porte l`hote et le port, comme celui d`OpenSSH', async () => {
    const { poste, clock } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    host.setInput(`ssh admin@${SILENCIEUX}`);
    host.handleKey(key('Enter'));
    await laisserExpirer(clock);

    expect(transcript(host))
      .toMatch(new RegExp(`ssh: connect to host ${SILENCIEUX} port 22: Connection timed out`));
  });
});
