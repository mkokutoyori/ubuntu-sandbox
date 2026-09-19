/**
 * `show interfaces status` compare a ses captures reelles.
 *
 * AUTORITE : les quatre captures que `ntc-templates` conserve
 * (`tests/cisco_ios/show_interfaces_status/`), plus celle de la variante
 * `err-disabled`. Elles fixent la mise en page a la colonne pres et le
 * VOCABULAIRE de chaque colonne :
 *
 *   Port      Name               Status       Vlan       Duplex  Speed Type
 *   Gi1/0/2   AccessPoint        connected    8          a-full a-1000 10/100/1000BaseTX
 *   Gi1/0/1                      notconnect   1            auto   auto 10/100/1000BaseTX
 *   Twe1/0/2  Device 2           disabled     456          auto   auto 10/100/1000BaseTX SFP
 *   Fa0/2     funky trunk port   notconnect   trunk        auto   auto 10/100BaseTX
 *   Fa0/3     routed magic       notconnect   routed       auto   auto 10/100BaseTX
 *
 * GEOMETRIE MESUREE sur la capture canonique, par arithmetique de
 * colonnes : `Port` a 0 sur 10, `Name` a 10 sur 19, `Status` a 29 sur
 * 13, `Vlan` a 42 sur 11, `Duplex` CALE A DROITE et finissant a 58,
 * `Speed` cale a droite finissant a 65, `Type` a 67. L'en-tete et les
 * donnees tombent sur les memes bords, sans exception dans les quatre
 * captures.
 *
 * LE PREFIXE `a-` EST LE POINT DE CE LOT. Il ne decore pas : il dit que
 * la valeur a ete NEGOCIEE. Un port connecte rend `a-full` / `a-1000` ;
 * un port sans lien rend `auto` / `auto` -- ni vitesse ni duplex n'ont
 * encore ete decides ; un port force rend `full` / `10G`, sans prefixe.
 * Les trois formes sont attestees dans les captures, et ce sont trois
 * etats differents de la meme machine.
 *
 * Le nom est TRONQUE a 18 caracteres : `*** connected to U` dans la
 * capture `with_keywords_in_name` est la fin d'une description plus
 * longue, coupee pour garder le blanc de separation.
 *
 * LE TYPE est lui aussi un mot des captures et non une etiquette
 * choisie : un port cuivre gigabit y porte `10/100/1000BaseTX`, un
 * cent-megabit `10/100BaseTX`. Aucune des cinq captures n'ecrit
 * `1000BASE-T`.
 *
 * Sonde ecrite AVANT lecture du rendu, contre ces captures seules.
 *
 * Discrimine par `git stash push -- src/network` : 2 cas sur 9 tombent,
 * et c'est la mesure honnete -- cette vue etait DEJA fidele pour
 * l'essentiel (l'alignement a droite de `Duplex` et `Speed`, le prefixe
 * `a-`, `trunk`, `disabled`, les bords de colonnes). Les 7 qui passent
 * des deux cotes sont des NON-REGRESSIONS : elles gardent ce qu'un lot
 * precedent avait mesure, et sans elles un correctif de troncature
 * pourrait deplacer une colonne sans que rien ne le dise.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const ENTETE =
  'Port      Name               Status       Vlan       Duplex  Speed Type';

type Dev = { executeCommand(c: string): Promise<string> };

async function taper(d: Dev, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

async function commutateur(nom: string, ...config: string[]): Promise<CiscoSwitch> {
  const s = new CiscoSwitch('switch-cisco', nom, 8);
  await taper(s, ['enable', 'configure terminal', ...config, 'end']);
  return s;
}

const vue = (s: CiscoSwitch): Promise<string> =>
  s.executeCommand('show interfaces status').then(String);

function ligne(sortie: string, port: string): string {
  return sortie.split('\n').find(l => l.startsWith(`${port} `) || l === port) ?? '';
}

function colonnes(l: string): Record<string, string> {
  return {
    port: l.slice(0, 10).trim(),
    name: l.slice(10, 29).trim(),
    status: l.slice(29, 42).trim(),
    vlan: l.slice(42, 53).trim(),
    duplex: l.slice(53, 59).trim(),
    speed: l.slice(59, 66).trim(),
    type: l.slice(67).trim(),
  };
}

describe('show interfaces status — la capture decide', () => {
  it('TEMOIN : la vue repond et porte une ligne par port', async () => {
    const s = await commutateur('SW0');
    const lignes = (await vue(s)).split('\n').filter(l => l.trim() !== '');
    expect(lignes.length).toBeGreaterThan(4);
  });

  it('l en-tete est CELUI de la capture, caractere pour caractere', async () => {
    const s = await commutateur('SW1');
    expect((await vue(s)).split('\n')[0]).toBe(ENTETE);
  });

  it('un port SANS lien rend notconnect, auto et auto', async () => {
    const s = await commutateur('SW2');
    const c = colonnes(ligne(await vue(s), 'Fa0/1'));
    expect(c.status).toBe('notconnect');
    expect(c.vlan).toBe('1');
    expect(c.duplex).toBe('auto');
    expect(c.speed).toBe('auto');
  });

  it('un port CONNECTE rend ses valeurs NEGOCIEES, prefixees `a-`', async () => {
    const a = await commutateur('SW3');
    const b = await commutateur('SW4');
    new Cable('c').connect(a.getPort('FastEthernet0/1')!, b.getPort('FastEthernet0/1')!);
    const c = colonnes(ligne(await vue(a), 'Fa0/1'));
    expect(c.status).toBe('connected');
    expect(c.duplex).toBe('a-full');
    expect(c.speed).toBe('a-100');
  });

  it('un port ETEINT rend disabled', async () => {
    const s = await commutateur('SW5', 'interface FastEthernet0/2', 'shutdown');
    expect(colonnes(ligne(await vue(s), 'Fa0/2')).status).toBe('disabled');
  });

  it('un port en TRUNK le dit dans la colonne Vlan', async () => {
    const s = await commutateur('SW6',
      'interface FastEthernet0/3', 'switchport mode trunk');
    expect(colonnes(ligne(await vue(s), 'Fa0/3')).vlan).toBe('trunk');
  });

  it('la description parait dans Name, tronquee a dix-huit', async () => {
    const s = await commutateur('SW7',
      'interface FastEthernet0/4', 'description AccessPoint',
      'interface FastEthernet0/5',
      'description une description beaucoup trop longue pour la colonne');
    expect(colonnes(ligne(await vue(s), 'Fa0/4')).name).toBe('AccessPoint');
    const longue = colonnes(ligne(await vue(s), 'Fa0/5')).name;
    expect(longue).toHaveLength(18);
    expect('une description beaucoup trop longue pour la colonne')
      .toContain(longue);
  });

  it('le TYPE d un port est celui que les captures ecrivent', async () => {
    const s = await commutateur('SW9');
    expect(colonnes(ligne(await vue(s), 'Fa0/1')).type).toBe('10/100BaseTX');
    const avecUplinks = new CiscoSwitch('switch-cisco', 'SW10', 26);
    await taper(avecUplinks, ['enable']);
    expect(colonnes(ligne(await vue(avecUplinks), 'Gi0/1')).type)
      .toBe('10/100/1000BaseTX');
  });

  it('les colonnes tombent sur les bords de la capture', async () => {
    const s = await commutateur('SW8', 'interface FastEthernet0/6',
      'description AccessPoint');
    const l = ligne(await vue(s), 'Fa0/6');
    expect(l.indexOf('AccessPoint')).toBe(10);
    expect(l.indexOf('notconnect')).toBe(29);
    expect(/\bauto\b/.exec(l.slice(53, 59))).not.toBeNull();
    expect(l.slice(53, 59)).toBe('  auto');
    expect(l.slice(59, 66)).toBe('   auto');
  });
});
