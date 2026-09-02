/**
 * LLDP sur FortiGate se regle a TROIS niveaux, et le niveau du milieu
 * n'existait pas.
 *
 * Mesure de depart : `config system settings` / `set lldp-transmission
 * enable` -- la facon dont on allume LLDP pour un VDOM entier sur une
 * vraie machine -- repondait `unknown attribute "lldp-transmission"
 * under 'config system settings'`. Le niveau VDOM etait absent des deux
 * attributs, et la consequence depasse la commande refusee : la valeur
 * par defaut d'une interface est `vdom`, mot qui NOMME ce niveau, et
 * elle etait resolue directement contre `config system global`. Un
 * operateur qui coupait LLDP pour son VDOM voyait donc ses interfaces
 * continuer d'emettre en suivant le reglage global -- l'inverse de ce
 * que la commande promet.
 *
 * La chaine attestee, et chaque mot-cle d'heritage nomme le niveau du
 * dessus :
 *
 *   interface  `enable | disable | vdom`    defaut `vdom`
 *   settings   `enable | disable | global`  defaut `global`
 *   global     `enable | disable`           defaut `disable`
 *
 * References mesurees. Le niveau VDOM et son defaut viennent du texte
 * meme de Fortinet, `FortiOS Handbook - CLI Reference 6.0.4`
 * (`official_docs/forti-cli-ref-60.txt`, depose dans le depot) : la
 * table `config system settings` declare `set lldp-transmission {enable
 * | disable | global}` et sa section « additional information » ecrit
 * « Enable or disable Link Layer Discovery Protocol (LLDP) for this
 * VDOM, or apply a global setting specified by lldp-transmission in
 * system global. The default value is global. » La meme reference donne
 * `config system global` `{enable | disable}` « Default is disable » et
 * `config system interface` `{enable | disable | vdom}`. `lldp-reception`
 * est ABSENT de cette reference-la, parce qu'il n'existe qu'a partir de
 * FortiOS 6.2 -- il est atteste par la page « LLDP reception » du guide
 * d'administration (6.2.0 a 8.0.0), qui le donne aux memes trois
 * niveaux ; notre boitier annonce 7.6.3, donc il l'a.
 *
 * Un piege de mesure ecrit plutot que tu : la collection Ansible de
 * Fortinet ne modelise PAS `lldp_reception` dans ses modules
 * `system_global`, `system_settings` ni `system_interface`. Conclure de
 * cette absence que l'attribut n'existe pas serait faux, et je l'avais
 * conclu avant de verifier -- un schema d'API qui ne suit pas est un
 * silence, pas un refus.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import {
  VirtualTimeScheduler, __setDefaultScheduler,
} from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;
let compteur = 0;

beforeEach(() => {
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});

interface Reglages {
  readonly global?: readonly string[];
  readonly settings?: readonly string[];
  readonly iface?: readonly string[];
}

async function labo(reglages: Reglages = {}) {
  const n = ++compteur;
  const fw = new FortiGate('firewall-fortinet', `FGT${n}`);
  const sw = new CiscoSwitch('switch-cisco', `SW${n}`, 4);
  new Cable(`c${n}`).connect(fw.getPort('port1')!, sw.getPort('FastEthernet0/1')!);

  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('lldp run');
  await sw.executeCommand('end');

  const bloc = async (entree: string, lignes: readonly string[] | undefined,
    edition?: string) => {
    if (!lignes || lignes.length === 0) return;
    await fw.executeCommand(entree);
    if (edition) await fw.executeCommand(edition);
    for (const l of lignes) await fw.executeCommand(l);
    await fw.executeCommand('end');
  };

  await bloc('config system global', reglages.global);
  await bloc('config system settings', reglages.settings);
  await bloc('config system interface', reglages.iface, 'edit port1');

  horloge.advance(31_000);
  return { fw, sw };
}

const voitLePareFeu = async (sw: CiscoSwitch, nom: string) =>
  (await sw.executeCommand('show lldp neighbors')).includes(nom);

describe('FortiGate : LLDP a trois niveaux', () => {
  it('le niveau VDOM EXISTE, pour les deux attributs', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FGT-S');
    expect(await fw.executeCommand('config system settings')).toBe('');
    expect(await fw.executeCommand('set lldp-transmission enable')).toBe('');
    expect(await fw.executeCommand('set lldp-reception enable')).toBe('');
    expect(await fw.executeCommand('end')).toBe('');
  });

  it('allumer le VDOM fait EMETTRE, le global restant eteint', async () => {
    const { fw, sw } = await labo({ settings: ['set lldp-transmission enable'] });
    expect(await voitLePareFeu(sw, fw.getName())).toBe(true);
  });

  it('allumer le VDOM fait RECEVOIR, le global restant eteint', async () => {
    const { fw } = await labo({ settings: ['set lldp-reception enable'] });
    const voisins = fw.getLldpAgent().getNeighbors();
    expect(voisins).toHaveLength(1);
    expect(voisins[0].systemName).toMatch(/^SW/);
  });

  it('une interface `vdom` lit le VDOM et NON le global', async () => {
    const { fw, sw } = await labo({
      global: ['set lldp-transmission enable'],
      settings: ['set lldp-transmission disable'],
    });
    expect(fw.getInterfaceLldp('port1').tx).toBe('vdom');
    expect(fw.transmitsLldpOn('port1')).toBe(false);
    horloge.advance(130_000);
    expect(await voitLePareFeu(sw, fw.getName())).toBe(false);
  });

  it('un VDOM `global` DEFERE au global', async () => {
    const { fw, sw } = await labo({
      global: ['set lldp-transmission enable'],
      settings: ['set lldp-transmission global'],
    });
    expect(fw.getVdomLldp().tx).toBe('global');
    expect(await voitLePareFeu(sw, fw.getName())).toBe(true);
  });

  it('l interface PRIME le VDOM, qui PRIME le global', async () => {
    const { fw, sw } = await labo({
      global: ['set lldp-transmission disable'],
      settings: ['set lldp-transmission disable'],
      iface: ['set lldp-transmission enable'],
    });
    expect(await voitLePareFeu(sw, fw.getName())).toBe(true);
  });

  it('la configuration rendue reproduit les deux lignes du VDOM', async () => {
    const { fw } = await labo({
      settings: ['set lldp-transmission enable', 'set lldp-reception enable'],
    });
    const rendu = await fw.executeCommand('show system settings');
    expect(rendu).toContain('set lldp-transmission enable');
    expect(rendu).toContain('set lldp-reception enable');
  });

  it('chaque niveau refuse le mot-cle d heritage de l AUTRE niveau', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FGT-V');
    await fw.executeCommand('config system settings');
    expect(await fw.executeCommand('set lldp-transmission vdom')).toContain('parse error');
    await fw.executeCommand('end');
    await fw.executeCommand('config system interface');
    await fw.executeCommand('edit port1');
    expect(await fw.executeCommand('set lldp-transmission global')).toContain('parse error');
    await fw.executeCommand('next');
    await fw.executeCommand('end');
  });

  it('TEMOIN : aux trois defauts, le pare-feu n emet ni n apprend rien', async () => {
    const { fw, sw } = await labo();
    expect(fw.getInterfaceLldp('port1').tx).toBe('vdom');
    expect(await voitLePareFeu(sw, fw.getName())).toBe(false);
    expect(fw.getLldpAgent().getNeighbors()).toHaveLength(0);
  });

  it('TEMOIN : allumer le GLOBAL fait toujours emettre', async () => {
    const { fw, sw } = await labo({ global: ['set lldp-transmission enable'] });
    expect(await voitLePareFeu(sw, fw.getName())).toBe(true);
  });
});
