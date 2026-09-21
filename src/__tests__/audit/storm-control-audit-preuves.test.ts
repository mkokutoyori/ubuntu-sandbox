/**
 * AUDIT SECURITE — SECOND PASSAGE, constat S-01 : `storm-control'.
 *
 * `docs/AUDIT-SECURITE-INFRA.md' §5 listait huit controles POSES et
 * ACCEPTES qu'aucune attaque n'avait eprouves, en concluant que chacun
 * etait << un candidat serieux au defaut du §6 >>. Le second passage les
 * a attaques. `storm-control' en etait un.
 *
 * MESURE AVANT (relevee par
 * `src/__tests__/debug/infra/second-passage-attaques.debug.test.ts') :
 *
 *   storm-control broadcast level 1.00   accepte, silence
 *   show storm-control                   Fa0/1 Forwarding 1.00% 1.00%
 *   running-config                       la ligne est rendue
 *   53 diffusions a travers le port      53 passent, AUCUNE supprimee
 *   show interfaces status               Fa0/1 connected
 *
 * Analyse, confirmee par lecture : le reglage etait analyse, REFUSE s'il
 * etait incomplet, stocke comme ligne de configuration et rendu par
 * `show storm-control' et `show running-config' — et le plan de
 * commutation ne le consultait NULLE PART. C'est exactement ce que
 * CLAUDE.md §6 nomme le pire des trois cas : toutes les apparences
 * d'exister sauf l'effet. Pour un controle de securite, cela produit une
 * FAUSSE ASSURANCE — un operateur croit son port protege de l'inondation.
 *
 * MESURE APRES, et c'est ce que ce banc assoit desormais :
 *
 *   40 diffusions, seuil 10 pps, sans action -> 10 relayees, 30 supprimees
 *   le port reste `connected'
 *   une trame UNICAST CONNUE passe pendant la tempete
 *   avec `action shutdown' -> le port passe `disabled'
 *
 * Le troisieme point est celui qu'il faut tenir : `storm-control
 * broadcast' ne doit RIEN faire a l'unicast. Un limiteur qui deborde sur
 * les autres classes de trafic serait un defaut plus grave que son
 * absence.
 *
 * Discrimination : 2 cas sur 6 sous `git stash push -- src/network'. Les
 * quatre autres, et pourquoi ils passent des deux cotes :
 *
 *   - << le port reste en service >> et << une tempete de DIFFUSION ne
 *     touche pas l'unicast >> : la base laissait DEJA tout passer sans
 *     jamais rien fermer, elle avait donc raison par accident sur ces
 *     deux-la. Ils gardent que la correction n'a pas deborde — c'est
 *     leur seule raison d'etre, et elle compte : un limiteur qui
 *     coupe l'unicast serait pire que pas de limiteur.
 *   - << un port SANS storm-control laisse tout passer >> : le TEMOIN.
 *     Il n'interroge que les compteurs de trames, jamais l'API neuve,
 *     pour pouvoir passer des deux cotes ; une premiere version lisait
 *     `getSuppressedFrames()' et tombait sur la base faute d'accesseur,
 *     ce qui n'aurait rien prouve.
 *   - << `no storm-control ...` rend le port a son etat libre >> : meme
 *     raison, la base ne limitait rien avant comme apres.
 *
 * Les seuils sont eprouves en `pps' parce que cette unite est EXACTE :
 * un pourcentage de bande passante depend de la vitesse du port et rend
 * la mesure dependante d'un debit simule. Le moteur evalue les trois
 * unites (`percent', `pps', `bps') ; le banc choisit celle qui se
 * verifie sans ambiguite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Port } from '@/network/hardware/Port';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function cli(sw: CiscoSwitch, lignes: string[]): Promise<void> {
  for (const ligne of lignes) await sw.executeCommand(ligne);
}

function banc() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  const a = new LinuxPC('linux-pc', 'PC-A', -150, -50);
  const b = new LinuxPC('linux-pc', 'PC-B', -150, 50);
  sw.powerOn(); a.powerOn(); b.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  return { sw, entree: sw.getPort('FastEthernet0/1')!, sortie: sw.getPort('FastEthernet0/2')! };
}

type Trame = Parameters<Port['receiveFrame']>[0];

function trame(destination: MACAddress): Trame {
  return {
    srcMAC: new MACAddress('aa:bb:cc:00:00:01'),
    dstMAC: destination,
    etherType: 0x0800,
    payload: { type: 'test' },
  } as unknown as Trame;
}

const inonder = (port: Port, combien: number, destination: MACAddress): void => {
  for (let i = 0; i < combien; i++) port.receiveFrame(trame(destination));
};

describe('S-01 — storm-control limite reellement le trafic de diffusion', () => {
  it('l excedent au-dela du seuil est supprime', async () => {
    const { sw, entree, sortie } = banc();
    await cli(sw, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'storm-control broadcast level pps 10', 'end']);

    const avant = sortie.getCounters().framesOut;
    inonder(entree, 40, MACAddress.broadcast());

    expect(sortie.getCounters().framesOut - avant).toBe(10);
    expect(entree.getStormControl().getSuppressedFrames()).toBe(30);
  });

  it('sans action declaree, le port reste en service', async () => {
    const { sw, entree } = banc();
    await cli(sw, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'storm-control broadcast level pps 10', 'end']);

    inonder(entree, 40, MACAddress.broadcast());

    const etat = await sw.executeCommand('show interfaces FastEthernet0/1 status');
    expect(etat).toMatch(/Fa0\/1\s+connected/);
  });

  it('une tempete de DIFFUSION ne touche pas l unicast connue', async () => {
    const { sw, entree, sortie } = banc();
    await cli(sw, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'storm-control broadcast level pps 10', 'end']);

    inonder(entree, 40, MACAddress.broadcast());
    const apresTempete = sortie.getCounters().framesOut;
    entree.receiveFrame(trame(new MACAddress('aa:bb:cc:00:00:02')));

    expect(sortie.getCounters().framesOut - apresTempete).toBe(1);
  });

  it('`action shutdown` err-disable le port', async () => {
    const { sw, entree } = banc();
    await cli(sw, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'storm-control broadcast level pps 10',
      'storm-control action shutdown', 'end']);

    inonder(entree, 40, MACAddress.broadcast());

    const etat = await sw.executeCommand('show interfaces FastEthernet0/1 status');
    expect(etat).toMatch(/Fa0\/1\s+disabled/);
  });

  it('un port SANS storm-control laisse tout passer — le temoin du banc', async () => {
    const { entree, sortie } = banc();
    const avant = sortie.getCounters().framesOut;
    inonder(entree, 40, MACAddress.broadcast());

    expect(sortie.getCounters().framesOut - avant).toBe(40);
  });

  it('`no storm-control broadcast level` rend le port a son etat libre', async () => {
    const { sw, entree, sortie } = banc();
    await cli(sw, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'storm-control broadcast level pps 10',
      'no storm-control broadcast level', 'end']);

    const avant = sortie.getCounters().framesOut;
    inonder(entree, 40, MACAddress.broadcast());

    expect(sortie.getCounters().framesOut - avant).toBe(40);
  });
});
