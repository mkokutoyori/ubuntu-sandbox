/**
 * Le tutoriel ACL Cisco se joue de bout en bout.
 *
 * On rejoue le tutoriel « Les ACL Cisco pour les debutants » commande par
 * commande, sur la maquette qu'il decrit : un routeur, deux commutateurs,
 * quatre machines. Chaque section suit le rythme du tutoriel —
 * la config, le test depuis une VRAIE machine, puis l'impact.
 *
 * Ecrite A L'AVEUGLE : les assertions disent ce que le tutoriel PROMET a
 * son lecteur, pas ce que la plateforme sait faire aujourd'hui. Un cas
 * qui tombe est un endroit ou le lecteur serait bloque.
 *
 *   Maquette du tutoriel
 *   ────────────────────
 *   PC-LNX  192.168.10.10 ─┐
 *   PC-WIN  192.168.10.20 ─┴─ SW1 ─ G0/0 .10.1 ┐
 *   PC-ADMIN 192.168.20.10 ──────── G0/1 .20.1 ┼── R1
 *   SRV-LNX 192.168.30.10 ─┐                   │
 *   SRV-WIN 192.168.30.20 ─┴─ SW2 ─ G0/2 .30.1 ┘
 *
 *   Discrimination (`git stash push -- src/network/`) : 16 cas sur 42
 *   tombent avant correctif. Les 26 qui passent des deux côtés sont
 *   nommés ici plutôt que laissés à découvrir :
 *
 *   — le montage du labo (4 cas) : il n'a jamais rien eu de cassé, il
 *     sert à prouver que le tutoriel est jouable avant d'y toucher ;
 *   — l'ACL standard, l'ordre des lignes, l'ACL étendue, `log`,
 *     `access-class`, `established`, `reload in` : ces mécanismes
 *     FONCTIONNAIENT déjà, et ces cas sont des non-régressions ;
 *   — « une VACL ne filtre QUE le trafic apparié » : le filtrage VACL du
 *     plan de données existait, seules ses deux vues manquaient ;
 *   — « les ACL réflexives : `reflect` et `evaluate` sont acceptés » :
 *     la SYNTAXE était acceptée depuis toujours — c'est l'évaluation qui
 *     échouait fermé. Ce cas ne prouve donc rien du moteur, et c'est le
 *     cas voisin (« le retour d'un flux SORTI passe ») qui le prouve.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const PC_LNX = '192.168.10.10';
const PC_WIN = '192.168.10.20';
const PC_ADMIN = '192.168.20.10';
const SRV_LNX = '192.168.30.10';
const SRV_WIN = '192.168.30.20';

interface Cmd { executeCommand(cmd: string): Promise<string> }

/**
 * Rend TOUT ce que la machine a repondu, pas seulement la derniere ligne.
 *
 * Premiere redaction : `last`. Or une sequence de configuration finit par
 * `end`, qui ne rend rien — donc `expect(sortie).not.toMatch(/Invalid
 * input/)` sur une sequence de dix commandes n'examinait que la chaine
 * vide et passait quoi qu'il arrive. Trois cas de « la config est
 * acceptee telle quelle » ne prouvaient rien.
 */
async function tape(device: Cmd, ...lines: string[]): Promise<string> {
  const sorties: string[] = [];
  for (const line of lines) sorties.push(await device.executeCommand(line));
  return sorties.filter(s => s !== '').join('\n');
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const r1 = new CiscoRouter('R1');
  const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
  const pcLnx = new LinuxPC('linux-pc', 'PC-LNX');
  const pcWin = new WindowsPC('windows-pc', 'PC-WIN');
  const pcAdmin = new LinuxPC('linux-pc', 'PC-ADMIN');
  const srvLnx = new LinuxServer('linux-server', 'SRV-LNX');
  const srvWin = new WindowsPC('windows-pc', 'SRV-WIN');
  for (const d of [r1, sw1, sw2, pcLnx, pcWin, pcAdmin, srvLnx, srvWin]) d.powerOn();

  new Cable('c1').connect(pcLnx.getPorts()[0], sw1.getPorts()[1]);
  new Cable('c2').connect(pcWin.getPorts()[0], sw1.getPorts()[2]);
  new Cable('c3').connect(sw1.getPorts()[0], r1.getPort('GigabitEthernet0/0')!);
  new Cable('c4').connect(pcAdmin.getPorts()[0], r1.getPort('GigabitEthernet0/1')!);
  new Cable('c5').connect(sw2.getPorts()[0], r1.getPort('GigabitEthernet0/2')!);
  new Cable('c6').connect(srvLnx.getPorts()[0], sw2.getPorts()[1]);
  new Cable('c7').connect(srvWin.getPorts()[0], sw2.getPorts()[2]);

  await tape(r1,
    'enable', 'configure terminal',
    'hostname R1',
    'interface GigabitEthernet0/0',
    'description LAN-USERS',
    'ip address 192.168.10.1 255.255.255.0',
    'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    'description LAN-ADMIN',
    'ip address 192.168.20.1 255.255.255.0',
    'no shutdown', 'exit',
    'interface GigabitEthernet0/2',
    'description LAN-SERVEURS',
    'ip address 192.168.30.1 255.255.255.0',
    'no shutdown', 'exit',
    'ip routing', 'end');

  await tape(pcLnx, 'ip link set eth0 up', `ip addr add ${PC_LNX}/24 dev eth0`,
    'ip route add default via 192.168.10.1');
  await tape(pcAdmin, 'ip link set eth0 up', `ip addr add ${PC_ADMIN}/24 dev eth0`,
    'ip route add default via 192.168.20.1');
  await tape(srvLnx, 'ip link set eth0 up', `ip addr add ${SRV_LNX}/24 dev eth0`,
    'ip route add default via 192.168.30.1',
    'systemctl start nginx', 'systemctl start ssh');

  await tape(pcWin, `netsh interface ip set address "Ethernet0" static ${PC_WIN} `
    + '255.255.255.0 192.168.10.1');
  await tape(srvWin, `netsh interface ip set address "Ethernet0" static ${SRV_WIN} `
    + '255.255.255.0 192.168.30.1');

  return { r1, sw1, sw2, pcLnx, pcWin, pcAdmin, srvLnx, srvWin };
}

/**
 * A-t-on VRAIMENT joint la cible ?
 *
 * Premiere redaction : `/Reply from/i` — qui apparie aussi
 * `Reply from 192.168.10.1: Destination host unreachable.`, c'est-a-dire
 * exactement le REFUS que le tutoriel cherche a faire constater. Trois
 * cas annoncaient un defaut du produit alors que l'ACL faisait son
 * travail. On compte donc ce qui est REVENU.
 */
function passe(sortie: string): boolean {
  const windows = /Received = (\d+)/.exec(sortie);
  if (windows) return Number(windows[1]) > 0;
  return /, 0% packet loss/.test(sortie);
}

beforeEach(() => { Logger.reset(); });

describe('le labo du tutoriel se monte', () => {
  it('la configuration de depart de R1 est acceptee', async () => {
    const { r1 } = await laboratoire();

    const brief = await tape(r1, 'show ip interface brief');
    expect(brief).toContain('192.168.10.1');
    expect(brief).toContain('192.168.20.1');
    expect(brief).toContain('192.168.30.1');
  });

  it('`write memory` sauvegarde', async () => {
    const { r1 } = await laboratoire();
    expect(await tape(r1, 'write memory')).toMatch(/OK|\[OK\]/);
  });

  it('la verification avant de commencer passe : tout se joint', async () => {
    const { pcLnx } = await laboratoire();

    expect(passe(await tape(pcLnx, `ping -c 2 ${SRV_LNX}`))).toBe(true);
    expect(await tape(pcLnx, `curl -I http://${SRV_LNX}`)).toContain('200');
  });

  it('les serveurs ecoutent la ou le tutoriel le dit', async () => {
    const { srvLnx } = await laboratoire();

    const ports = await tape(srvLnx, 'ss -ltnp');
    expect(ports).toContain(':80');
    expect(ports).toContain(':22');
  });
});

describe('concept 2 — l ACL standard', () => {
  it('la config du tutoriel est acceptee telle quelle', async () => {
    const { r1 } = await laboratoire();

    const sortie = await tape(r1, 'configure terminal',
      'access-list 1 remark === Blocage du poste PC-WIN vers les serveurs ===',
      `access-list 1 deny host ${PC_WIN}`,
      'access-list 1 permit any',
      'interface GigabitEthernet0/2',
      'ip access-group 1 out', 'end');

    expect(sortie).not.toMatch(/Invalid input|Unrecognized/);
    const vue = await tape(r1, 'show access-lists 1');
    expect(vue).toContain('Standard IP access list 1');
    expect(vue).toContain(`deny   ${PC_WIN}`);
    expect(vue).toContain('permit any');
  });

  it('PC-WIN est bloque vers les serveurs, PC-LNX passe', async () => {
    const { r1, pcLnx, pcWin } = await laboratoire();
    await tape(r1, 'configure terminal',
      `access-list 1 deny host ${PC_WIN}`,
      'access-list 1 permit any',
      'interface GigabitEthernet0/2', 'ip access-group 1 out', 'end');

    expect(passe(await tape(pcWin, `ping ${SRV_LNX}`))).toBe(false);
    expect(passe(await tape(pcLnx, `ping -c 2 ${SRV_LNX}`))).toBe(true);
  });

  it('les compteurs de matches s incrementent', async () => {
    const { r1, pcWin } = await laboratoire();
    await tape(r1, 'configure terminal',
      `access-list 1 deny host ${PC_WIN}`,
      'access-list 1 permit any',
      'interface GigabitEthernet0/2', 'ip access-group 1 out', 'end');

    await tape(pcWin, `ping ${SRV_LNX}`);

    expect(await tape(r1, 'show access-lists 1')).toMatch(/deny.*\(\d+ match/);
  });

  it('l impact cache : PC-WIN joint encore le reseau d administration',
    async () => {
      const { r1, pcWin } = await laboratoire();
      await tape(r1, 'configure terminal',
        `access-list 1 deny host ${PC_WIN}`,
        'access-list 1 permit any',
        'interface GigabitEthernet0/2', 'ip access-group 1 out', 'end');

      expect(passe(await tape(pcWin, `ping ${PC_ADMIN}`))).toBe(true);
    });

  it('le piege : le trafic intra-VLAN ne traverse pas le routeur', async () => {
    const { r1, pcWin } = await laboratoire();
    await tape(r1, 'configure terminal',
      `access-list 1 deny host ${PC_WIN}`,
      'access-list 1 permit any',
      'interface GigabitEthernet0/2', 'ip access-group 1 out', 'end');

    expect(passe(await tape(pcWin, `ping ${PC_LNX}`))).toBe(true);
  });

  it('posee en `in` sur G0/0, elle coupe PC-WIN de TOUT', async () => {
    const { r1, pcWin } = await laboratoire();
    await tape(r1, 'configure terminal',
      `access-list 1 deny host ${PC_WIN}`,
      'access-list 1 permit any',
      'interface GigabitEthernet0/0', 'ip access-group 1 in', 'end');

    expect(passe(await tape(pcWin, `ping ${SRV_LNX}`))).toBe(false);
    expect(passe(await tape(pcWin, `ping ${PC_ADMIN}`))).toBe(false);
  });
});

describe('concept 3 — l ordre des lignes', () => {
  it('`permit any` en premier rend la ligne suivante MORTE', async () => {
    const { r1, pcWin } = await laboratoire();
    await tape(r1, 'configure terminal',
      'access-list 2 permit any',
      `access-list 2 deny host ${PC_WIN}`,
      'interface GigabitEthernet0/2', 'ip access-group 2 out', 'end');

    expect(passe(await tape(pcWin, `ping ${SRV_LNX}`))).toBe(true);

    const vue = await tape(r1, 'show access-lists 2');
    expect(vue).toMatch(/permit any \(\d+ match/);
    expect(vue).toMatch(/deny\s+192\.168\.10\.20(?! .*\(\d+ match)/);
  });

  it('`no access-list 2` supprime TOUTE la liste', async () => {
    const { r1 } = await laboratoire();
    await tape(r1, 'configure terminal',
      'access-list 2 permit any',
      `access-list 2 deny host ${PC_WIN}`, 'end');

    await tape(r1, 'configure terminal', 'no access-list 2', 'end');

    expect(await tape(r1, 'show access-lists 2')).not.toContain('permit any');
  });
});

describe('concept 4 — l ACL etendue', () => {
  async function politique(r1: CiscoRouter): Promise<void> {
    await tape(r1, 'configure terminal',
      'access-list 100 remark === Politique acces LAN utilisateurs ===',
      `access-list 100 permit tcp 192.168.10.0 0.0.0.255 host ${SRV_LNX} eq 80`,
      `access-list 100 permit tcp 192.168.10.0 0.0.0.255 host ${SRV_WIN} eq 3389`,
      'access-list 100 deny ip 192.168.10.0 0.0.0.255 192.168.30.0 0.0.0.255',
      'access-list 100 permit ip any any',
      'interface GigabitEthernet0/0', 'ip access-group 100 in', 'end');
  }

  it('la config du tutoriel est acceptee telle quelle', async () => {
    const { r1 } = await laboratoire();
    await politique(r1);

    const vue = await tape(r1, 'show access-lists 100');
    expect(vue).toContain('Extended IP access list 100');
    expect(vue).toMatch(/permit tcp 192\.168\.10\.0 0\.0\.0\.255 host 192\.168\.30\.10 eq (www|80)/);
    expect(vue).toContain('eq 3389');
    expect(vue).toContain('permit ip any any');
  });

  it('le web passe, SSH et le ping sont bloques', async () => {
    const { r1, pcLnx } = await laboratoire();
    await politique(r1);

    expect(await tape(pcLnx, `curl -I http://${SRV_LNX}`)).toContain('200');
    expect(passe(await tape(pcLnx, `ping -c 2 ${SRV_LNX}`))).toBe(false);
  });

  it('le reseau d administration reste joignable', async () => {
    const { r1, pcLnx } = await laboratoire();
    await politique(r1);

    expect(passe(await tape(pcLnx, `ping -c 2 ${PC_ADMIN}`))).toBe(true);
  });
});

describe('concept 5 — l ACL nommee et les numeros de sequence', () => {
  async function nommee(r1: CiscoRouter): Promise<void> {
    await tape(r1, 'configure terminal',
      'ip access-list extended USERS-VERS-SERVEURS',
      'remark === Politique acces LAN utilisateurs ===',
      `10 permit tcp 192.168.10.0 0.0.0.255 host ${SRV_LNX} eq 80`,
      `20 permit tcp 192.168.10.0 0.0.0.255 host ${SRV_WIN} eq 3389`,
      '30 deny ip 192.168.10.0 0.0.0.255 192.168.30.0 0.0.0.255',
      '40 permit ip any any', 'exit',
      'interface GigabitEthernet0/0',
      'ip access-group USERS-VERS-SERVEURS in', 'end');
  }

  it('une ACL nommee se declare avec ses numeros de sequence', async () => {
    const { r1 } = await laboratoire();
    await nommee(r1);

    const vue = await tape(r1, 'show access-lists USERS-VERS-SERVEURS');
    expect(vue).toContain('Extended IP access list USERS-VERS-SERVEURS');
    expect(vue).toMatch(/^\s*10 permit tcp/m);
    expect(vue).toMatch(/^\s*40 permit ip any any/m);
  });

  it('une ligne s INSERE a sa place', async () => {
    const { r1 } = await laboratoire();
    await nommee(r1);

    await tape(r1, 'configure terminal',
      'ip access-list extended USERS-VERS-SERVEURS',
      '25 permit icmp 192.168.10.0 0.0.0.255 192.168.30.0 0.0.0.255', 'end');

    const vue = await tape(r1, 'show access-lists USERS-VERS-SERVEURS');
    const lignes = vue.split('\n').filter(l => /^\s*\d+ /.test(l));
    expect(lignes.map(l => l.trim().split(' ')[0]))
      .toEqual(['10', '20', '25', '30', '40']);
  });

  it('la ligne inseree fait REPASSER le ping', async () => {
    const { r1, pcLnx } = await laboratoire();
    await nommee(r1);
    expect(passe(await tape(pcLnx, `ping -c 2 ${SRV_LNX}`))).toBe(false);

    await tape(r1, 'configure terminal',
      'ip access-list extended USERS-VERS-SERVEURS',
      '25 permit icmp 192.168.10.0 0.0.0.255 192.168.30.0 0.0.0.255', 'end');

    expect(passe(await tape(pcLnx, `ping -c 2 ${SRV_LNX}`))).toBe(true);
  });

  it('`no 25` retire la seule ligne 25', async () => {
    const { r1 } = await laboratoire();
    await nommee(r1);
    await tape(r1, 'configure terminal',
      'ip access-list extended USERS-VERS-SERVEURS',
      '25 permit icmp 192.168.10.0 0.0.0.255 192.168.30.0 0.0.0.255',
      'no 25', 'end');

    const vue = await tape(r1, 'show access-lists USERS-VERS-SERVEURS');
    expect(vue).not.toMatch(/^\s*25 /m);
    expect(vue).toMatch(/^\s*30 deny/m);
  });

  it('`ip access-list resequence` renumerote', async () => {
    const { r1 } = await laboratoire();
    await nommee(r1);

    await tape(r1, 'configure terminal',
      'ip access-list resequence USERS-VERS-SERVEURS 100 100', 'end');

    const vue = await tape(r1, 'show access-lists USERS-VERS-SERVEURS');
    expect(vue).toMatch(/^\s*100 permit tcp/m);
    expect(vue).toMatch(/^\s*400 permit ip any any/m);
  });
});

describe('concept 6 — journaliser', () => {
  it('`log` en fin d ACE est accepte et JOURNALISE', async () => {
    const { r1, pcLnx } = await laboratoire();
    await tape(r1, 'configure terminal',
      'logging buffered 16384',
      'service timestamps log datetime msec',
      'ip access-list extended USERS-VERS-SERVEURS',
      `10 permit tcp 192.168.10.0 0.0.0.255 host ${SRV_LNX} eq 80`,
      '30 deny ip 192.168.10.0 0.0.0.255 192.168.30.0 0.0.0.255 log',
      '40 permit ip any any', 'exit',
      'interface GigabitEthernet0/0',
      'ip access-group USERS-VERS-SERVEURS in', 'end');

    await tape(pcLnx, `ssh -o ConnectTimeout=1 user@${SRV_LNX}`);

    const journal = await tape(r1, 'show logging');
    expect(journal).toContain('IPACCESSLOG');
    expect(journal).toContain('USERS-VERS-SERVEURS');
  });
});

describe('concept 7 — access-class sur les VTY', () => {
  it('la config du tutoriel est acceptee telle quelle', async () => {
    const { r1 } = await laboratoire();

    const sortie = await tape(r1, 'configure terminal',
      'ip access-list standard ADMIN-AUTORISE',
      'remark === Postes autorises a administrer R1 ===',
      `permit host ${PC_ADMIN}`, 'exit',
      'line vty 0 15',
      'access-class ADMIN-AUTORISE in',
      'transport input ssh', 'end');

    expect(sortie).not.toMatch(/Invalid input|Unrecognized/);
    expect(await tape(r1, 'show running-config'))
      .toContain('access-class ADMIN-AUTORISE in');
  });

  it('seul PC-ADMIN ouvre une session SSH sur R1', async () => {
    const { r1, pcLnx, pcAdmin } = await laboratoire();
    await tape(r1, 'configure terminal',
      'ip domain-name lab.local',
      'crypto key generate rsa',
      'username admin privilege 15 secret Cisco123',
      'ip access-list standard ADMIN-AUTORISE',
      `permit host ${PC_ADMIN}`, 'exit',
      'line vty 0 15',
      'access-class ADMIN-AUTORISE in',
      'transport input ssh',
      'login local', 'end');

    const refuse = await tape(pcLnx,
      `ssh -o ConnectTimeout=1 admin@192.168.10.1 whoami`);
    expect(refuse).not.toContain('admin');

    const accepte = await tape(pcAdmin,
      `ssh -o ConnectTimeout=1 admin@192.168.20.1 show clock`);
    expect(accepte).not.toMatch(/refused|closed|denied/i);
  });
});

describe('concept 8 — l ACL basee sur le temps', () => {
  it('`time-range` et `periodic weekdays` sont acceptes', async () => {
    const { r1 } = await laboratoire();

    const sortie = await tape(r1, 'configure terminal',
      'clock timezone WAT 1',
      'time-range HEURES-OUVREES',
      'periodic weekdays 08:00 to 18:00', 'end');

    expect(sortie).not.toMatch(/Invalid input|Unrecognized/);
    expect(await tape(r1, 'show time-range')).toContain('HEURES-OUVREES');
  });

  it('`show time-range` dit ACTIVE ou INACTIVE selon l horloge', async () => {
    const { r1 } = await laboratoire();
    await tape(r1, 'configure terminal',
      'time-range HEURES-OUVREES',
      'periodic weekdays 08:00 to 18:00', 'end');

    await tape(r1, 'clock set 14:30:00 22 Aug 2026');
    expect(await tape(r1, 'show time-range')).toContain('(inactive)');

    await tape(r1, 'clock set 09:00:00 24 Aug 2026');
    expect(await tape(r1, 'show time-range')).toContain('(active)');
  });

  it('`show time-range` nomme la liste qui s en sert', async () => {
    const { r1 } = await laboratoire();
    await tape(r1, 'configure terminal',
      'time-range HEURES-OUVREES',
      'periodic weekdays 08:00 to 18:00', 'exit',
      'ip access-list extended HORAIRE',
      '10 permit icmp any any time-range HEURES-OUVREES', 'end');

    expect(await tape(r1, 'show time-range')).toContain('used in: IP ACL entry');
  });

  it('une ACE `time-range` ne filtre que pendant la plage', async () => {
    const { r1, pcLnx } = await laboratoire();
    await tape(r1, 'configure terminal',
      'time-range HEURES-OUVREES',
      'periodic weekdays 08:00 to 18:00', 'exit',
      'ip access-list extended HORAIRE',
      `10 permit icmp any any time-range HEURES-OUVREES`,
      '20 deny ip any any', 'exit',
      'interface GigabitEthernet0/0', 'ip access-group HORAIRE in', 'end');

    await tape(r1, 'clock set 14:30:00 22 Aug 2026');
    expect(passe(await tape(pcLnx, `ping -c 2 ${SRV_LNX}`))).toBe(false);

    await tape(r1, 'clock set 09:00:00 24 Aug 2026');
    expect(passe(await tape(pcLnx, `ping -c 2 ${SRV_LNX}`))).toBe(true);
  });
});

describe('concept 9 — le trafic retour', () => {
  it('`established` et `echo-reply` sont acceptes', async () => {
    const { r1 } = await laboratoire();

    const sortie = await tape(r1, 'configure terminal',
      'ip access-list extended SERVEURS-VERS-USERS',
      'remark === Seul le trafic retour est autorise ===',
      'permit tcp 192.168.30.0 0.0.0.255 192.168.10.0 0.0.0.255 established',
      'permit icmp 192.168.30.0 0.0.0.255 192.168.10.0 0.0.0.255 echo-reply',
      'deny ip 192.168.30.0 0.0.0.255 192.168.10.0 0.0.0.255 log',
      'permit ip any any', 'exit',
      'interface GigabitEthernet0/2',
      'ip access-group SERVEURS-VERS-USERS in', 'end');

    expect(sortie).not.toMatch(/Invalid input|Unrecognized/);
    expect(await tape(r1, 'show access-lists SERVEURS-VERS-USERS'))
      .toContain('established');
  });

  it('le trafic retour passe, un flux initie par le serveur est bloque',
    async () => {
      const { r1, pcLnx, srvLnx } = await laboratoire();
      await tape(r1, 'configure terminal',
        'ip access-list extended SERVEURS-VERS-USERS',
        'permit tcp 192.168.30.0 0.0.0.255 192.168.10.0 0.0.0.255 established',
        'permit icmp 192.168.30.0 0.0.0.255 192.168.10.0 0.0.0.255 echo-reply',
        'deny ip 192.168.30.0 0.0.0.255 192.168.10.0 0.0.0.255 log',
        'permit ip any any', 'exit',
        'interface GigabitEthernet0/2',
        'ip access-group SERVEURS-VERS-USERS in', 'end');

      expect(await tape(pcLnx, `curl -I http://${SRV_LNX}`)).toContain('200');
      expect(passe(await tape(srvLnx, `ping -c 2 ${PC_LNX}`))).toBe(false);
    });

  it('les ACL reflexives : `reflect` et `evaluate` sont acceptes', async () => {
    const { r1 } = await laboratoire();

    const sortie = await tape(r1, 'configure terminal',
      'ip access-list extended SORTIE-VERS-SERVEURS',
      'permit tcp 192.168.10.0 0.0.0.255 any reflect FLUX-RETOUR',
      'permit udp 192.168.10.0 0.0.0.255 any reflect FLUX-RETOUR',
      'permit icmp 192.168.10.0 0.0.0.255 any reflect FLUX-RETOUR', 'exit',
      'ip access-list extended ENTREE-DEPUIS-SERVEURS',
      'evaluate FLUX-RETOUR',
      'deny ip any any log', 'exit',
      'interface GigabitEthernet0/2',
      'ip access-group SORTIE-VERS-SERVEURS out',
      'ip access-group ENTREE-DEPUIS-SERVEURS in', 'end');

    expect(sortie).not.toMatch(/Invalid input|Unrecognized/);
  });

  it('une entree reflexive TEMPORAIRE apparait apres du trafic', async () => {
    const { r1, pcLnx } = await laboratoire();
    await tape(r1, 'configure terminal',
      'ip access-list extended SORTIE-VERS-SERVEURS',
      'permit tcp 192.168.10.0 0.0.0.255 any reflect FLUX-RETOUR',
      'permit icmp 192.168.10.0 0.0.0.255 any reflect FLUX-RETOUR', 'exit',
      'ip access-list extended ENTREE-DEPUIS-SERVEURS',
      'evaluate FLUX-RETOUR',
      'deny ip any any log', 'exit',
      'interface GigabitEthernet0/2',
      'ip access-group SORTIE-VERS-SERVEURS out',
      'ip access-group ENTREE-DEPUIS-SERVEURS in', 'end');

    await tape(pcLnx, `curl -I http://${SRV_LNX}`);

    const vue = await tape(r1, 'show ip access-lists FLUX-RETOUR');
    expect(vue).toContain('Reflexive IP access list FLUX-RETOUR');
    expect(vue).toMatch(/time left \d+/);
    expect(vue).toContain(`host ${SRV_LNX}`);
  });

  /**
   * Le temoin est SRV-WIN, que personne n a contacte.
   *
   * Premiere redaction : le retour teste etait un `ping` de SRV-LNX vers
   * PC-LNX apres un `ping` en sens inverse — or une entree reflexive ICMP
   * ne porte que deux adresses (ICMP n a pas de port), donc la demande
   * d echo du serveur apparie la session ouverte par celle du poste. Un
   * vrai IOS a exactement le meme trou ; c est l assertion qui etait
   * fausse, pas le moteur.
   */
  it('le retour d un flux SORTI passe, celui d un flux jamais sorti non',
    async () => {
      const { r1, pcLnx, srvWin } = await laboratoire();
      await tape(r1, 'configure terminal',
        'ip access-list extended SORTIE-VERS-SERVEURS',
        'permit icmp 192.168.10.0 0.0.0.255 any reflect FLUX-RETOUR', 'exit',
        'ip access-list extended ENTREE-DEPUIS-SERVEURS',
        'evaluate FLUX-RETOUR',
        'deny ip any any log', 'exit',
        'interface GigabitEthernet0/2',
        'ip access-group SORTIE-VERS-SERVEURS out',
        'ip access-group ENTREE-DEPUIS-SERVEURS in', 'end');

      expect(passe(await tape(pcLnx, `ping -c 2 ${SRV_LNX}`))).toBe(true);
      expect(passe(await tape(srvWin, `ping -n 1 -w 500 ${PC_LNX}`))).toBe(false);
    }, 20_000);
});

describe('concept 10 — filtrer sur le commutateur', () => {
  it('une PACL se pose sur un port physique', async () => {
    const { sw1 } = await laboratoire();

    const sortie = await tape(sw1, 'enable', 'configure terminal',
      'ip access-list extended PROTEGE-PC-LNX',
      `deny tcp any host ${PC_LNX} eq 22`,
      'permit ip any any', 'exit',
      'interface FastEthernet0/2',
      'ip access-group PROTEGE-PC-LNX in', 'end');

    expect(sortie).not.toMatch(/Invalid input|Unrecognized/);
    // Pas `show ip interface` : un port de niveau 2 n'a pas d'adresse, et
    // un vrai Catalyst s'arrete la aussi (`Internet protocol processing
    // disabled`). La liaison se relit dans la configuration, qui est
    // aussi ce qui la REFAIT a l'import d'une topologie.
    expect(await tape(sw1, 'show running-config'))
      .toContain('ip access-group PROTEGE-PC-LNX in');
  });

  it('une liste posee sur le commutateur se RETIRE', async () => {
    const { sw1 } = await laboratoire();
    await tape(sw1, 'enable', 'configure terminal',
      'ip access-list extended A-RETIRER', 'permit ip any any', 'exit',
      'access-list 10 permit any', 'end');
    expect(await tape(sw1, 'show running-config')).toContain('A-RETIRER');

    await tape(sw1, 'configure terminal',
      'no ip access-list extended A-RETIRER', 'no access-list 10', 'end');

    const config = await tape(sw1, 'show running-config');
    expect(config).not.toContain('A-RETIRER');
    expect(config).not.toContain('access-list 10');
  });

  /*
   * Ce cas exigeait `% Access list PAS-LA not found`, un refus que ce
   * simulateur avait choisi pour la securite de l'apprenant. Une vraie
   * machine fait l'INVERSE, et la documentation Cisco l'ecrit noir sur
   * blanc : « when you apply an access list that has not yet been
   * defined to an interface, the software acts as if the access list has
   * not been applied to the interface and accepts all packets », en
   * signalant elle-meme que c'est un point de securite a retenir. Le
   * piege EST la lecon ; le supprimer apprend une machine qui n'existe
   * pas, et laissait surtout le routeur et le commutateur repondre deux
   * choses differentes a la meme commande.
   */
  it('une PACL qui designe une liste INEXISTANTE est acceptee, et ne filtre RIEN', async () => {
    const { sw1, pcLnx, pcAdmin } = await laboratoire();

    const sortie = await tape(sw1, 'enable', 'configure terminal',
      'interface FastEthernet0/2', 'ip access-group PAS-LA in');
    expect(sortie).not.toContain('not found');
    expect(sortie).not.toContain('Invalid input');

    await tape(sw1, 'end');
    expect(await tape(sw1, 'show running-config'))
      .toContain('ip access-group PAS-LA in');

    expect(passe(await tape(pcLnx, `ping -c 1 -W 1 ${PC_WIN}`))).toBe(true);
    expect(passe(await tape(pcAdmin, `ping -c 1 -W 1 ${SRV_LNX}`))).toBe(true);
  });

  it('une PACL bloque VRAIMENT le trafic qu elle nomme', async () => {
    const { sw1, pcLnx, pcAdmin } = await laboratoire();
    await tape(sw1, 'enable', 'configure terminal',
      'ip access-list extended MUET',
      'deny icmp any any',
      'permit ip any any', 'exit',
      'interface FastEthernet0/2',
      'ip access-group MUET in', 'end');

    expect(passe(await tape(pcLnx, `ping -c 1 -W 1 ${PC_WIN}`))).toBe(false);
    expect(passe(await tape(pcAdmin, `ping -c 2 ${SRV_LNX}`))).toBe(true);
  }, 20_000);

  it('une VACL filtre a l interieur d un VLAN', async () => {
    const { sw1 } = await laboratoire();

    const sortie = await tape(sw1, 'enable', 'configure terminal',
      'ip access-list extended TRAFIC-SSH-INTERNE',
      'permit tcp any any eq 22', 'exit',
      'vlan access-map FILTRE-VLAN10 10',
      'match ip address TRAFIC-SSH-INTERNE',
      'action drop', 'exit',
      'vlan access-map FILTRE-VLAN10 20',
      'action forward', 'exit',
      'vlan filter FILTRE-VLAN10 vlan-list 10', 'end');

    expect(sortie).not.toMatch(/Invalid input|Unrecognized/);
    const carte = await tape(sw1, 'show vlan access-map');
    expect(carte).toContain('Vlan access-map "FILTRE-VLAN10"  10');
    expect(carte).toContain('    ip  address: TRAFIC-SSH-INTERNE');
    expect(carte).toContain('    drop');
    expect(await tape(sw1, 'show vlan filter'))
      .toContain('VLAN Map FILTRE-VLAN10:');
  });

  it('une VACL ne filtre QUE le trafic apparie', async () => {
    const { sw1, pcLnx, pcAdmin } = await laboratoire();
    await tape(sw1, 'enable', 'configure terminal',
      'ip access-list extended PING-INTERNE',
      'permit icmp any any', 'exit',
      'vlan access-map FILTRE-VLAN1 10',
      'match ip address PING-INTERNE',
      'action drop', 'exit',
      'vlan access-map FILTRE-VLAN1 20',
      'action forward', 'exit',
      'vlan filter FILTRE-VLAN1 vlan-list 1', 'end');

    expect(passe(await tape(pcLnx, `ping -c 2 ${PC_WIN}`))).toBe(false);
  });

  it('`switchport protected` existe comme repli', async () => {
    const { sw1 } = await laboratoire();

    const sortie = await tape(sw1, 'enable', 'configure terminal',
      'interface FastEthernet0/2', 'switchport protected', 'end');

    expect(sortie).not.toMatch(/Invalid input|Unrecognized/);
    expect(await tape(sw1, 'show interfaces FastEthernet0/2 switchport'))
      .toContain('Protected: true');
    expect(await tape(sw1, 'show running-config'))
      .toContain('switchport protected');
  });

  it('deux ports proteges ne se parlent plus, un port ordinaire si',
    async () => {
      const { sw1, pcLnx } = await laboratoire();
      // Fa0/2 porte PC-LNX et Fa0/3 PC-WIN — Fa0/1 est la liaison vers R1.
      await tape(sw1, 'enable', 'configure terminal',
        'interface FastEthernet0/2', 'switchport protected', 'exit',
        'interface FastEthernet0/3', 'switchport protected', 'end');

      expect(passe(await tape(pcLnx, `ping -c 1 -W 1 ${PC_WIN}`))).toBe(false);

      await tape(sw1, 'configure terminal',
        'interface FastEthernet0/3', 'no switchport protected', 'end');
      expect(passe(await tape(pcLnx, `ping -c 2 ${PC_WIN}`))).toBe(true);
    }, 20_000);
});

describe('concept 11 — depanner', () => {
  it('les cinq commandes de la boite a outils repondent', async () => {
    const { r1 } = await laboratoire();
    await tape(r1, 'configure terminal',
      `access-list 1 deny host ${PC_WIN}`,
      'access-list 1 permit any',
      'interface GigabitEthernet0/2', 'ip access-group 1 out', 'end');

    expect(await tape(r1, 'show access-lists')).toContain('access list 1');
    expect(await tape(r1, 'show ip interface GigabitEthernet0/2'))
      .toMatch(/access list is 1|Outgoing access list is 1/);
    expect(await tape(r1, 'show running-config | section access-list'))
      .toContain('access-list 1');
    expect(await tape(r1, 'show logging')).not.toMatch(/Invalid input/);
    expect(await tape(r1, 'clear access-list counters'))
      .not.toMatch(/Invalid input/);
  });

  it('`clear access-list counters` remet vraiment a zero', async () => {
    const { r1, pcWin } = await laboratoire();
    await tape(r1, 'configure terminal',
      `access-list 1 deny host ${PC_WIN}`,
      'access-list 1 permit any',
      'interface GigabitEthernet0/2', 'ip access-group 1 out', 'end');
    await tape(pcWin, `ping ${SRV_LNX}`);
    expect(await tape(r1, 'show access-lists 1')).toMatch(/\(\d+ match/);

    await tape(r1, 'clear access-list counters');

    expect(await tape(r1, 'show access-lists 1')).not.toMatch(/\([1-9]\d* match/);
  });

  it('`reload in 10` et `reload cancel` existent — le filet de securite',
    async () => {
      const { r1 } = await laboratoire();

      expect(await tape(r1, 'reload in 10')).not.toMatch(/Invalid input/);
      expect(await tape(r1, 'reload cancel')).not.toMatch(/Invalid input/);
    });
});
