/**
 * `get` ne savait ni compter les sessions ni les lister, et son aide
 * proposait de CONFIGURER ce qu'on ne peut que lire.
 *
 * Trois constats, mesures sur un pare-feu qui relaie et traduit pour de
 * bon.
 *
 * **(1) `get system session status` et `get system session list`
 * n'existaient pas** — « unknown configuration path » — alors que la
 * table de sessions est la meme que celle que `diagnose sys session
 * list` rend deja. Les deux vues ne font pas double emploi et la
 * reference 6.0.4 les distingue : `diagnose` rend le PAVE par session
 * (drapeaux, minuteurs, crochets, numero de serie), `get` rend UNE
 * LIGNE par session en six colonnes, ce qui est la vue qu'on lit quand
 * on cherche « quelle session porte cette adresse ». Les deux formats
 * sont attestes par la reference, en-tete `PROTO EXPIRE SOURCE
 * SOURCE-NAT DESTINATION DESTINATION-NAT` compris, ainsi que la phrase
 * exacte de `session status`.
 *
 * **(2) `get hardware nic` n'existait pas non plus**, alors que la
 * reference 6.0.4 la cite (`get hardware nic internal | grep
 * Current_HWaddr`) : c'est le meme fait que `diagnose hardware
 * deviceinfo nic`. Elle DELEGUE donc, plutot que de recopier un
 * second rendu — deux ecritures d'une meme sortie finiraient par ne
 * plus dire la meme chose du meme port.
 *
 * **(3) L'aide de CHAQUE vue `get` disait « Configure <mot>. »**, et
 * c'etait le cas des vingt et une vues declarees avant ce lot :
 * `get router info routing-table ?` repondait « all — Configure all. »
 * pour une vue en lecture seule. Le repli `branchHelp` sert les
 * branches de configuration, et une vue n'en est pas une. Chaque vue
 * porte desormais sa description, noeuds intermediaires compris, et le
 * repli ne s'applique plus qu'aux vraies branches — un cas verifie que
 * `get vpn certificate`, qui EST configurable, garde bien son texte de
 * configuration.
 *
 * Le nom de protocole est lu par `protocolKeywordFor`, la table IANA
 * que le depot porte deja pour les listes de controle, plutot qu'une
 * seconde table nom/numero.
 *
 * Discrimine par `git stash push -- src/network/` : 8 des 10 cas
 * tombent. Les 2 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « le laboratoire traduit vraiment » est le TEMOIN, et c'est son
 *     objet de passer des deux cotes : sans lui, une colonne SOURCE-NAT
 *     vide et un laboratoire sans traduction seraient indiscernables ;
 *   - « une branche de configuration garde son texte » passe des deux
 *     cotes et le doit : il garde que la description des vues n'a pas
 *     debordé sur ce que le repli sert correctement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
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

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', -200, 0);
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'set nat enable', 'next', 'end');

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0',
    'ip route add default via 10.1.1.1');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.2.2.10/24 dev eth0',
    'ip route add default via 10.2.2.1');

  return { fw, sh, a, b };
}

describe('get system session', () => {
  it('le laboratoire traduit vraiment', async () => {
    const { fw, a } = await laboratoire();

    expect(await runOn(a, 'ping -c 1 10.2.2.10')).toContain('0% packet loss');
    const session = fw.getSessionTable().view().all()[0];
    expect(session?.translation?.translatedSource).toBe('10.2.2.1');
  });

  it('sans trafic, la vue est le seul en-tete et le compte est nul', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('get system session status'))
      .toBe('The total number of sessions for the current VDOM: 0');
    expect(sh.execute('get system session list'))
      .toBe('PROTO     EXPIRE  SOURCE         SOURCE-NAT'
        + '   DESTINATION    DESTINATION-NAT');
  });

  it('compte les sessions reellement ouvertes', async () => {
    const { sh, a } = await laboratoire();
    await runOn(a, 'ping -c 2 10.2.2.10');

    expect(sh.execute('get system session status'))
      .toBe('The total number of sessions for the current VDOM: 2');
  });

  it('rend une ligne par session, en six colonnes', async () => {
    const { sh, a } = await laboratoire();
    await runOn(a, 'ping -c 1 10.2.2.10');

    const lignes = sh.execute('get system session list').split('\n');
    expect(lignes).toHaveLength(2);
    expect(lignes[1].split(' ')).toHaveLength(6);
  });

  it('nomme le protocole et rend la traduction de source', async () => {
    const { sh, a } = await laboratoire();
    await runOn(a, 'ping -c 1 10.2.2.10');

    const [proto, , source, sourceNat, destination, destinationNat] =
      sh.execute('get system session list').split('\n')[1].split(' ');
    expect(proto).toBe('icmp');
    expect(source).toBe('10.1.1.10:1');
    expect(sourceNat).toBe('10.2.2.1:1');
    expect(destination).toBe('10.2.2.10:1');
    expect(destinationNat).toBe('-');
  });

  it('un flux sans traduction porte un tiret des deux cotes', async () => {
    const { sh, a } = await laboratoire();
    run(sh, 'config firewall policy', 'edit 1', 'set nat disable', 'next', 'end');
    await runOn(a, 'ping -c 1 10.2.2.10');

    const colonnes = sh.execute('get system session list').split('\n')[1].split(' ');
    expect(colonnes[3]).toBe('-');
    expect(colonnes[5]).toBe('-');
  });
});

describe('get hardware nic', () => {
  it('rend la meme chose que la commande de diagnostic', async () => {
    const { sh, a } = await laboratoire();
    await runOn(a, 'ping -c 1 10.2.2.10');

    expect(sh.execute('get hardware nic port1'))
      .toBe(sh.execute('diagnose hardware deviceinfo nic port1'));
  });

  it('une interface inconnue est refusee comme par le diagnostic', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('get hardware nic zorglub'))
      .toContain('"zorglub" does not exist');
  });
});

describe('l aide des vues get', () => {
  it('ne propose plus de configurer ce qui se lit', async () => {
    const { sh } = await laboratoire();

    const aide = sh.execute('get router info routing-table ?');
    expect(aide).toContain('Every route.');
    expect(aide).not.toContain('Configure all.');
    expect(sh.execute('get system session ?')).not.toContain('Configure');
  });

  it('une branche de configuration garde son texte', async () => {
    const { sh } = await laboratoire();

    expect(sh.execute('get vpn ?')).toContain('Configure certificate.');
  });
});
