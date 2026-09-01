/**
 * Un FortiGate parle LLDP pour de bon.
 *
 * Mesure de depart : LLDP etait ABSENT du pare-feu, entierement --
 * ni `set lldp-transmission`, ni `set lldp-reception`, ni
 * `diagnose lldprx`, et surtout aucun `LldpAgent`, donc un FortiGate
 * cable a un commutateur Cisco qui fait `lldp run` etait INVISIBLE dans
 * son `show lldp neighbors` et ne voyait rien lui-meme. Ce n'etait donc
 * pas une commande a rendre honnete mais une fonction a ecrire.
 *
 * Discrimine par `git stash` : 8 cas tombent avant correctif.
 *
 * Les 2 qui passent des deux cotes passent pour une RAISON QUI NE PROUVE
 * RIEN, et il faut la dire : la restauration retire aussi le correctif
 * Cisco du meme lot, donc `show lldp neighbors` du commutateur se remet
 * a FABRIQUER ses voisins depuis le plan de cablage -- il annonce donc
 * un FortiGate qu'il n'a jamais entendu (« le voisin VOIT le pare-feu »)
 * et il l'annonce aussi quand seule la reception est active (le cas
 * « la reception seule n'annonce RIEN » echoue alors a echouer pour la
 * meme cause). C'est une demonstration de plus de ce premier defaut, et
 * non une faiblesse de ces deux cas, que le lot complet valide.
 *
 * References mesurees : le schema d'API que la collection Ansible de
 * Fortinet publie (`fortinet-ansible-dev/ansible-galaxy-fortios-collection`,
 * `plugins/modules/fortios_system_interface.py` et
 * `fortios_system_global.py`) donne `lldp-transmission` avec les choix
 * `enable|disable|vdom` sur l'interface et `enable|disable` en global ;
 * la documentation de Fortinet (guide d'administration 6.2.0 a 8.0.0,
 * page « LLDP reception ») atteste `set lldp-reception` aux trois
 * niveaux. La mise en forme de `diagnose lldprx port neighbor details`
 * vient de la capture reelle `ntc-templates`
 * `tests/fortinet/diagnose_lldprx_port_neighbor_details_port-name/`
 * (`chassis.type: 4` / `interface-mac`, `system.caps.available: 0014` /
 * `bridge router`, `address.count`).
 *
 * DEUX limites assumees, ecrites plutot que tues :
 *  - la documentation de Fortinet fait de `device-identification` un
 *    PREALABLE a `lldp-reception` ; le refus n'est pas reproduit ici,
 *    aucune capture n'attestant son libelle exact, et l'inventer serait
 *    un message qu'aucune machine ne rend.
 *  - la capacite annoncee par un FortiGate est `Router`, DEDUITE de ce
 *    que la machine fait (elle achemine) et non d'une capture : aucune
 *    trace d'un FortiGate EMETTEUR n'est atteignable depuis ce reseau.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  VirtualTimeScheduler, __setDefaultScheduler,
} from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

async function labo(...global: string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FGT');
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
  new Cable('c').connect(fw.getPort('port1')!, sw.getPort('FastEthernet0/1')!);
  await fw.executeCommand('config system global');
  for (const c of global) await fw.executeCommand(c);
  await fw.executeCommand('end');
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('lldp run');
  await sw.executeCommand('end');
  horloge.advance(31_000);
  return { fw, sw };
}

describe('FortiGate : LLDP', () => {
  it('sans configuration, le pare-feu n annonce rien', async () => {
    const { fw, sw } = await labo();
    expect(fw.getLldpAgent().getConfig().enabled).toBe(false);
    expect(sw.getLldpAgent().getNeighbors()).toHaveLength(0);
  });

  it('set lldp-transmission enable fait VOIR le pare-feu par le voisin', async () => {
    const { sw } = await labo('set lldp-transmission enable');
    const out = await sw.executeCommand('show lldp neighbors');
    expect(out).toContain('FGT');
    expect(out).toContain('port1');
  });

  it('un FortiGate s annonce ROUTEUR', async () => {
    const { sw } = await labo('set lldp-transmission enable');
    const ligne = (await sw.executeCommand('show lldp neighbors'))
      .split('\n').find(l => l.startsWith('FGT'))!;
    expect(ligne).toMatch(/\bR\b/);
  });

  it('set lldp-reception enable fait APPRENDRE le voisin', async () => {
    const { fw } = await labo('set lldp-reception enable');
    const n = fw.getLldpAgent().getNeighbors();
    expect(n).toHaveLength(1);
    expect(n[0].systemName).toBe('SW1');
  });

  it('la reception seule n annonce RIEN au voisin', async () => {
    const { sw } = await labo('set lldp-reception enable');
    expect(sw.getLldpAgent().getNeighbors()).toHaveLength(0);
  });

  it('vdom sur l interface suit le reglage global', async () => {
    const { fw, sw } = await labo('set lldp-transmission enable');
    expect(fw.getInterfaceLldp('port1').tx).toBe('vdom');
    expect(await sw.executeCommand('show lldp neighbors')).toContain('FGT');
  });

  it('disable sur l interface PRIME le global', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FGT2');
    const sw = new CiscoSwitch('switch-cisco', 'SW2', 4);
    new Cable('c2').connect(fw.getPort('port1')!, sw.getPort('FastEthernet0/1')!);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('lldp run');
    await sw.executeCommand('end');
    for (const c of ['config system interface', 'edit port1',
      'set lldp-transmission disable', 'end',
      'config system global', 'set lldp-transmission enable', 'end']) {
      await fw.executeCommand(c);
    }
    horloge.advance(31_000);
    expect(fw.getInterfaceLldp('port1').tx).toBe('disable');
    expect(sw.getLldpAgent().getNeighborsOnPort('FastEthernet0/1')).toHaveLength(0);
  });

  it('diagnose lldprx rend les TLV, dans la forme de la capture reelle', async () => {
    const { fw } = await labo('set lldp-reception enable');
    const out = await fw.executeCommand('diagnose lldprx port neighbor details port1');
    expect(out).toContain('1 port.txt: port1');
    expect(out).toContain('1 chassis.type: 4');
    expect(out).toContain('1 chassis.type.txt: interface-mac');
    expect(out).toContain('1 port.id.type.txt: interface-name');
    expect(out).toContain('1 system.name.data: SW1');
    expect(out).toContain('1 system.caps.available: 0004');
    expect(out).toContain('1 system.caps.available.txt: bridge');
  });

  it('diagnose lldprx neighbor summary liste ce qui a ete entendu', async () => {
    const { fw } = await labo('set lldp-reception enable');
    const out = await fw.executeCommand('diagnose lldprx neighbor summary');
    expect(out).toContain('port1');
    expect(out).toContain('SW1');
    expect(out).toContain('FastEthernet0/1');
  });

  it('une interface inconnue est refusee, pas inventee', async () => {
    const { fw } = await labo('set lldp-reception enable');
    expect(await fw.executeCommand('diagnose lldprx port neighbor details zorglub'))
      .toContain('does not exist');
  });
});
