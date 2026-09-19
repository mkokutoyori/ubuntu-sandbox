/**
 * `get system interface' rendait la mise en page de `get system interface
 * physical', et cette derniere n'etait juste ni dans son en-tete, ni dans
 * son indentation, ni dans ses champs.
 *
 * MESURE DE DEPART sur `9d09a151' :
 *
 *   get system interface            == [port1]
 *                                   <TAB>mode: static
 *                                   <TAB>ip: 192.168.100.99 255.255.255.0
 *                                   <TAB>ipv6: ::/0
 *                                   <TAB>status: up
 *                                   <TAB>speed: 1000Mbps (Duplex: full)
 *   get system interface physical   la MEME chose
 *
 * Une seule fonction rendait les deux, son booleen `physicalOnly' ne
 * faisant que FILTRER. Or ce sont deux vues differentes sur un vrai
 * FortiOS, et aucune des deux n'a cette forme-la.
 *
 * AUTORITE. Les deux sorties CAPTUREES que `ntc-templates' conserve.
 *
 * `get system interface' ecrit UNE LIGNE par interface, precedee d'un
 * en-tete a espaces INTERIEURS :
 *
 *   == [ wan ]
 *   name: wan   mode: static    ip: 10.180.1.229 255.255.255.252   status: up    netbios-forward: disable    type: physical   ...
 *
 * Les separateurs ne sont pas uniformes, et c'est mesure champ par champ
 * sur les lignes de la capture : TROIS espaces apres la valeur de `name:',
 * de `ip:' et de `type:', QUATRE apres toutes les autres. Ce n'est donc
 * pas un tableau a ecart constant mais une suite de `printf' dont chacun
 * porte son propre blanc — et la capture le confirme sur ses formes
 * courtes, `name: lan1   status: up    type: physical'.
 *
 * `get system interface physical' est une vue EMBOITEE, et sa forme a
 * change avec les versions. Les captures 5.6, 6.0 et 6.2 indentent de huit
 * puis seize espaces ; celle de 7.4 de QUATRE puis HUIT, et ajoute `FEC:'
 * et `FEC_cap:'. Cet equipement annonce `v7.6.3' par `get system status',
 * donc c'est la forme de 7.4 :
 *
 *   == [onboard]
 *       ==[ha]
 *           mode: static
 *           ip: 0.0.0.0 0.0.0.0
 *           ipv6: ::/0
 *           status: up
 *           speed: 1000Mbps (Duplex: full)
 *           FEC: none
 *           FEC_cap: none
 *
 * Trois details que la capture fixe et qu'on mettrait mal autrement :
 * l'en-tete de groupe `== [onboard]' porte un espace avant le crochet et
 * l'interface `==[ha]' n'en porte PAS ; l'indentation est faite d'ESPACES
 * la ou nous ecrivions une tabulation ; et `FEC' n'apparait pas avant 7.4.
 *
 * `FEC: none' n'est pas une invention de colonne : la correction d'erreur
 * anticipee ne s'applique qu'aux optiques rapides, et ces ports simules
 * negocient 1000Mbps sur cuivre, ou `none' est la valeur VRAIE.
 *
 * CE QUE LA LIGNE DE `get system interface' NE PORTE PAS. La capture
 * nomme une douzaine de champs de plus — `netbios-forward', `src-check',
 * `netflow-sampler', `sflow-sampler', `explicit-web-proxy',
 * `explicit-ftp-proxy', `proxy-captive-portal', `mtu-override', `wccp',
 * `drop-overlapped-fragment', `drop-fragment'. Aucun n'est declare dans le
 * schema `system interface' de ce simulateur : les rendre a `disable'
 * donnerait a croire qu'un interrupteur existe la ou il n'y a rien, ce que
 * la regle 6 refuse. Ils sont donc absents, et la capture montre elle-meme
 * des lignes courtes — `name: lan1   status: up    type: physical' — donc
 * la forme reduite est attestee. Les declarer ET les faire decider est un
 * lot a soi, nomme ici pour qu'il ne se perde pas.
 *
 * MESURE : 8 cas tombent sur 10.
 * Les 2 qui passent des deux cotes sont nommes :
 *   - TEMOIN : `diagnose ip address list' montrait DEJA l'adresse posee.
 *     Sans lui, « la mise en page est fausse » et « le lab n'a rien
 *     configure » seraient indiscernables ;
 *   - NON-REGRESSION : les deux vues nommaient deja l'interface et son
 *     adresse, et la refonte ne devait pas les perdre en chemin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function laboratoire(): Promise<FortiGate> {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const r1 = new CiscoRouter('R1-EDGE', 200, 0);
  new Cable('transit').connect(fgt.getPort('port1')!, r1.getPort('GigabitEthernet0/1')!);
  await taper(r1, ['enable', 'configure terminal', 'interface GigabitEthernet0/1',
    'ip address 192.168.100.1 255.255.255.0', 'no shutdown', 'end']);
  await taper(fgt, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.100.99 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
  ]);
  return fgt;
}

const vue = (fgt: FortiGate, cmd: string): Promise<string> =>
  fgt.executeCommand(cmd).then(String);

const LIGNE_PORT1 = 'name: port1   mode: static    ip: 192.168.100.99 255.255.255.0'
  + '   status: up    type: physical   src-check: enable'
  + '    drop-overlapped-fragment: disable    drop-fragment: disable';

describe('les deux vues d_interface de FortiOS ne sont pas la meme vue', () => {
  it('TEMOIN : l adresse est bien posee, une autre vue le montre', async () => {
    const fgt = await laboratoire();
    expect(await vue(fgt, 'diagnose ip address list')).toContain('192.168.100.99');
  }, 30000);

  it('`get system interface` : l en-tete porte ses espaces interieurs', async () => {
    const fgt = await laboratoire();
    expect((await vue(fgt, 'get system interface')).split('\n')).toContain('== [ port1 ]');
  }, 30000);

  it('`get system interface` : une SEULE ligne de champs par interface', async () => {
    const fgt = await laboratoire();
    const lignes = (await vue(fgt, 'get system interface')).split('\n');
    expect(lignes.filter(l => l.startsWith('name: port1 ')).length).toBe(1);
    expect(lignes.filter(l => l.trim().startsWith('mode:')).length).toBe(0);
  }, 30000);

  it('`get system interface` : les separateurs mesures, champ par champ', async () => {
    const fgt = await laboratoire();
    expect((await vue(fgt, 'get system interface')).split('\n')).toContain(LIGNE_PORT1);
  }, 30000);

  it('`get system interface physical` : la vue s ouvre par le groupe onboard', async () => {
    const fgt = await laboratoire();
    expect((await vue(fgt, 'get system interface physical')).split('\n')[0])
      .toBe('== [onboard]');
  }, 30000);

  it('`get system interface physical` : l interface est `    ==[port1]`', async () => {
    const fgt = await laboratoire();
    expect((await vue(fgt, 'get system interface physical')).split('\n'))
      .toContain('    ==[port1]');
  }, 30000);

  it('`get system interface physical` : les champs sont indentes de HUIT espaces', async () => {
    const fgt = await laboratoire();
    const lignes = (await vue(fgt, 'get system interface physical')).split('\n')
      .filter(l => l.includes('mode:') || l.includes('status:'));
    expect(lignes.length).toBeGreaterThan(0);
    for (const l of lignes) expect(l.startsWith('        ')).toBe(true);
    expect(lignes.some(l => l.includes('\t'))).toBe(false);
  }, 30000);

  it('`get system interface physical` : `FEC` et `FEC_cap` sont rendus', async () => {
    const fgt = await laboratoire();
    const lignes = (await vue(fgt, 'get system interface physical')).split('\n');
    expect(lignes).toContain('        FEC: none');
    expect(lignes).toContain('        FEC_cap: none');
  }, 30000);

  it('les deux vues ne se confondent plus', async () => {
    const fgt = await laboratoire();
    const simple = await vue(fgt, 'get system interface');
    const physique = await vue(fgt, 'get system interface physical');
    expect(simple).not.toBe(physique);
    expect(simple).not.toContain('== [onboard]');
    expect(physique).not.toContain('name: port1');
  }, 30000);

  it('NON-REGRESSION : les deux vues nomment l interface et son adresse', async () => {
    const fgt = await laboratoire();
    for (const c of ['get system interface', 'get system interface physical']) {
      const rendu = await vue(fgt, c);
      expect(rendu).toContain('port1');
      expect(rendu).toContain('192.168.100.99 255.255.255.0');
    }
  }, 30000);
});
