/**
 * `get system arp' annoncait une colonne `Age(min)' qui valait TOUJOURS
 * zero, et ses colonnes ne tombaient pas ou la reference les met.
 *
 * MESURE DE DEPART sur `cddd9033', sur un pare-feu dont le voisin est
 * appris depuis quatre minutes :
 *
 *   Address           Age(min)  Hardware Addr       Interface
 *   192.168.10.5      0         02:00:00:00:00:0f   port2
 *
 * L'age etait ecrit `age: '0'` dans le rendu, sans jamais etre calcule.
 * `ARPEntry' porte pourtant un `timestamp' depuis toujours — c'est lui qui
 * fait vieillir l'entree dans `ArpService' — donc la valeur existait et
 * seule la vue l'ignorait. Une colonne affichee que rien ne soutient est
 * exactement ce que la regle 6 nomme : toute l'apparence d'exister, sauf
 * l'effet.
 *
 * AUTORITE pour la mise en page : la sortie CAPTUREE que `ntc-templates'
 * conserve pour `fortinet_get_system_arp'.
 *
 *   Address           Age(min)   Hardware Addr      Interface
 *   192.168.1.4       0          b0:a8:6e:01:61:81 lan
 *   192.168.1.114     4          40:cb:c0:ce:81:85 lan
 *
 * LA VRAIE BOITE DESALIGNE SON PROPRE EN-TETE, et c'est mesure. Dans
 * l'en-tete, `Interface' tombe a la colonne 48 ; dans CHACUNE des lignes
 * de donnees, le nom d'interface tombe a la colonne 47. L'ecart est d'un
 * caractere, constant, sur les quatre lignes de la capture : la colonne
 * de l'adresse materielle est large de 19 dans l'en-tete et de 18 dans les
 * donnees. C'est la signature d'un en-tete ecrit a la main a cote d'un
 * `printf' de donnees — precisement le defaut que `TextTable' existe pour
 * empecher CHEZ NOUS.
 *
 * On le reproduit quand meme, parce que c'est ce qu'un apprenant compare,
 * mais DECLARE plutot que dessine : une colonne peut desormais annoncer
 * une largeur d'en-tete distincte de sa largeur de donnees. Le rendu
 * reste sorti d'un seul calcul, et l'ecart est une valeur qu'on lit dans
 * la declaration au lieu d'un accident entre deux chaines.
 *
 * `Age(min)' est un age en minutes depuis l'apprentissage, comme sur les
 * autres plateformes qui portent cette colonne. Deux cas le tiennent : il
 * vaut zero juste apres l'echange, et il suit l'horloge de l'equipement.
 *
 * MESURE : 4 cas tombent sur 7.
 * Les 3 qui passent des deux cotes sont nommes :
 *   - TEMOIN : l'echange apprend vraiment le voisin. Sans lui, « l'age est
 *     faux » et « le cache est vide » seraient indiscernables ;
 *   - NON-REGRESSION : `diagnose ip arp list' rend toujours la meme
 *     entree, et la refonte de la table ne l'emporte pas ;
 *   - « l'age vaut zero juste apres l'apprentissage » passe des deux
 *     cotes parce que l'ancien rendu ECRIVAIT zero. Il est garde parce
 *     qu'il epingle l'absence d'un decalage d'une unite dans le calcul,
 *     mais sa force vient des deux cas qui le suivent, pas de lui.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const DEPART = Date.parse('2026-07-15T12:00:00Z');

async function laboratoire(): Promise<{ fgt: FortiGate; avance: (ms: number) => void }> {
  let instant = DEPART;
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0,
    { now: () => instant });
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await taper(pc, ['ip addr add 192.168.10.5/24 dev eth0', 'ip link set eth0 up']);
  await taper(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
  ]);
  await pc.executeCommand('ping -c 2 192.168.10.1');
  return { fgt, avance: (ms) => { instant += ms; } };
}

const table = (fgt: FortiGate): Promise<string> =>
  fgt.executeCommand('get system arp').then(String);

function ligneDuVoisin(vue: string): string {
  return vue.split('\n').find(l => l.startsWith('192.168.10.5')) ?? '';
}

function age(vue: string): number {
  return Number(/^192\.168\.10\.5\s+(\d+)/.exec(ligneDuVoisin(vue))?.[1] ?? Number.NaN);
}

describe('`get system arp` compte l_age et pose ses colonnes comme la reference', () => {
  it('TEMOIN : l echange a bien appris le voisin', async () => {
    const { fgt } = await laboratoire();
    expect(await table(fgt)).toContain('192.168.10.5');
  }, 30000);

  it('l age vaut zero juste apres l apprentissage', async () => {
    const { fgt } = await laboratoire();
    expect(age(await table(fgt))).toBe(0);
  }, 30000);

  it('et il suit l horloge de l equipement', async () => {
    const { fgt, avance } = await laboratoire();
    avance(3 * 60_000);

    expect(age(await table(fgt))).toBe(3);
  }, 30000);

  it('il ne compte que les minutes ENTIERES', async () => {
    const { fgt, avance } = await laboratoire();
    avance(119_000);

    expect(age(await table(fgt))).toBe(1);
  }, 30000);

  it('l en-tete pose ses colonnes a 0, 18, 29 et 48', async () => {
    const { fgt } = await laboratoire();
    const entete = (await table(fgt)).split('\n')[0];

    expect(entete.indexOf('Address')).toBe(0);
    expect(entete.indexOf('Age(min)')).toBe(18);
    expect(entete.indexOf('Hardware Addr')).toBe(29);
    expect(entete.indexOf('Interface')).toBe(48);
  }, 30000);

  it('une ligne de donnees pose les siennes a 0, 18, 29 et 47', async () => {
    const { fgt } = await laboratoire();
    const ligne = ligneDuVoisin(await table(fgt));
    const mac = /([0-9a-f]{2}:){5}[0-9a-f]{2}/.exec(ligne);

    expect(ligne.indexOf('192.168.10.5')).toBe(0);
    expect(/^\S+\s+/.exec(ligne)?.[0].length).toBe(18);
    expect(mac?.index).toBe(29);
    expect(ligne.indexOf('port2')).toBe(47);
  }, 30000);

  it('NON-REGRESSION : `diagnose ip arp list` rend toujours le voisin', async () => {
    const { fgt } = await laboratoire();
    expect(await fgt.executeCommand('diagnose ip arp list'))
      .toContain('192.168.10.5');
  }, 30000);
});
