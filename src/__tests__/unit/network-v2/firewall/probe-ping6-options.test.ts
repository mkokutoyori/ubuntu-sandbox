/**
 * `execute ping6-options` existe, et les deux familles ont chacune leur
 * magasin.
 *
 * Mesure de depart, sur un boitier neuf :
 *
 *   execute ping-options reset      -> unknown ping option "reset"
 *   execute ping6-options <n importe quoi> -> unknown action "ping6-options"
 *   execute ping-options ?          -> « <cr> » et « LINE », rien d autre
 *
 * Trois defauts d une seule famille. (1) `reset` est documente par la
 * reference et `PingOptions.reset()` etait ECRITE, sans aucun appelant --
 * un moteur sans porte, comme ce depot en referme regulierement. (2) La
 * commande v6 n existait pas du tout, et `FirewallPing6` ne recevait
 * AUCUNE option : `execute ping6` ignorait donc le compte comme la
 * taille, quoi qu on ait configure. (3) L aide ne nommait aucune option,
 * donc elles etaient indecouvrables -- la place etait un `REST` sans
 * alternatives.
 *
 * La reference tranche le detail qui compte. `official_docs/forti-cli-ref-60.txt`
 * donne pour `ping-options` : adaptive-ping, data-size, df-bit,
 * interface, interval, pattern, repeat-count, reset, source, timeout,
 * tos, ttl, validate-reply, view-settings ; et pour `ping6-options`
 * exactement les memes SAUF `df-bit`. Ce n est pas un oubli de la
 * documentation : l en-tete IPv6 n a pas de bit « Don t Fragment », la
 * fragmentation y etant de bout en bout. C est la seule difference entre
 * les deux listes, et le cas qui l epingle est celui qui distingue un
 * portage honnete d une copie.
 *
 * Une SEULE classe sert les deux familles, parametree plutot que
 * dupliquee : `PING_OPTION_SPECS` declare le vocabulaire une fois,
 * `pingOptionsFor(family)` en derive la liste, et cette meme declaration
 * est lue par le magasin (ce qu il accepte), par l aide et par la
 * tabulation (ce qu elles annoncent). Les trois ne peuvent donc pas se
 * contredire. Mais les INSTANCES sont deux, parce qu un vrai FortiGate
 * garde deux etats independants -- regler le compte en v4 ne doit pas
 * deplacer celui de v6.
 *
 * Limite assumee et ecrite plutot que tue : la reference ne donne pas la
 * sortie de `execute ping6-options view-settings`. La notre reprend la
 * mise en forme attestee de la v4 en OMETTANT la ligne du bit DF, ce qui
 * est deduit par symetrie de l absence de l option, non capture. De
 * meme, l annotation de type que la reference porte sur
 * `ping6-options source` est `{xxx.xxx.xxx.xxx}` alors que sa propre
 * description dit « <source interface IP> | Auto » : c est un artefact de
 * documentation recopie de la v4, et le magasin v6 attend donc une
 * adresse IPv6.
 *
 * DEUX corrections de MA propre sonde, ecrites plutot qu effacees.
 * (1) Le premier `ping6` d un laboratoire perd son paquet de sequence 0,
 * le cache de voisinage etant froid -- comportement anterieur, visible
 * aussi bien sur un ping par defaut, mais qui rendait la mesure du
 * compte illisible ; le laboratoire chauffe donc le cache avant de
 * mesurer, ce qu un operateur fait de toute facon. (2) Mon TEMOIN
 * verifiait `toContain('0% packet loss')` et passait sur « 20% packet
 * loss », qui la CONTIENT -- exactement le piege de sous-chaine que ce
 * depot a deja paye sur `nat-acl-evaluation-order`. Il est ancre sur
 * `, 0% packet loss`.
 *
 * Discrimine par `git stash` sur les cinq fichiers cables : 7 cas
 * tombent. Le seul qui passe des deux cotes est le TEMOIN, dont c est
 * l objet : `execute ping6` repond deja sur ce laboratoire, et sans lui
 * un labo mal bati et une option ignoree seraient indiscernables.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function run(sh: FortiShell, ...lignes: string[]): string {
  let dernier = '';
  for (const ligne of lignes) dernier = sh.execute(ligne);
  return dernier;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

function boitier(): FortiShell {
  return new FortiGate('firewall-fortinet', 'FGT', 0, 0).getShell() as FortiShell;
}

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const poste = new LinuxPC('linux-pc', 'PC', 200, 0);
  poste.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, poste.getPorts()[0]);
  for (const c of ['ip link set eth0 up', 'ip addr add 2001:db8::10/64 dev eth0']) {
    await poste.executeCommand(c);
  }
  run(sh, 'config system interface', 'edit "port1"', 'config ipv6',
    'set ip6-address 2001:db8::1/64', 'set ip6-allowaccess ping',
    'end', 'next', 'end');
  run(sh, 'execute ping6 2001:db8::10');
  return { fw, sh };
}

const mots = (sh: FortiShell, ligne: string) =>
  sh.help(ligne).map(l => l.trim().split(/\s{2,}/)[0]).filter(w => w !== '<cr>');

describe('FortiGate : execute ping6-options', () => {
  it('TEMOIN : `execute ping6` repond sur ce laboratoire', async () => {
    const { sh } = await laboratoire();
    expect(run(sh, 'execute ping6 2001:db8::10')).toContain(', 0% packet loss');
  });

  it('`execute ping-options reset` remet les defauts', () => {
    const sh = boitier();
    run(sh, 'execute ping-options repeat-count 9');
    expect(run(sh, 'execute ping-options reset')).toBe('');
    expect(run(sh, 'execute ping-options view-settings')).toContain('Repeat Count: 5');
  });

  it('`execute ping6-options` existe et se regle', () => {
    const sh = boitier();
    expect(run(sh, 'execute ping6-options repeat-count 7')).toBe('');
    expect(run(sh, 'execute ping6-options view-settings')).toContain('Repeat Count: 7');
  });

  it('les deux familles ont des magasins INDEPENDANTS', () => {
    const sh = boitier();
    run(sh, 'execute ping-options repeat-count 3');
    run(sh, 'execute ping6-options repeat-count 7');
    expect(run(sh, 'execute ping-options view-settings')).toContain('Repeat Count: 3');
    expect(run(sh, 'execute ping6-options view-settings')).toContain('Repeat Count: 7');
  });

  it('`df-bit` existe en v4 et PAS en v6, l en-tete IPv6 n en ayant pas', () => {
    const sh = boitier();
    expect(run(sh, 'execute ping-options df-bit yes')).toBe('');
    expect(run(sh, 'execute ping6-options df-bit yes'))
      .toContain('unknown ping option "df-bit"');
    expect(run(sh, 'execute ping-options view-settings')).toContain('DF bit: set');
    expect(run(sh, 'execute ping6-options view-settings')).not.toContain('DF bit');
  });

  it('l aide NOMME les options, et les deux listes different du seul df-bit', () => {
    const sh = boitier();
    const v4 = mots(sh, 'execute ping-options ');
    const v6 = mots(sh, 'execute ping6-options ');
    expect(v4).toContain('repeat-count');
    expect(v4).toContain('reset');
    expect(v4.filter(w => !v6.includes(w))).toEqual(['df-bit']);
    expect(v6.filter(w => !v4.includes(w))).toEqual([]);
    expect(sh.completions('execute ping6-options rep'))
      .toEqual(['execute ping6-options repeat-count']);
  });

  it('`ping6` HONORE le compte, et le v4 ne le deplace pas', async () => {
    const { sh } = await laboratoire();
    run(sh, 'execute ping6-options repeat-count 2');
    expect(run(sh, 'execute ping6 2001:db8::10'))
      .toContain('2 packets transmitted, 2 packets received');

    run(sh, 'execute ping-options repeat-count 9');
    expect(run(sh, 'execute ping6 2001:db8::10'))
      .toContain('2 packets transmitted, 2 packets received');
  });

  it('`ping6` HONORE la taille des donnees', async () => {
    const { sh } = await laboratoire();
    run(sh, 'execute ping6-options data-size 100');
    const vu = run(sh, 'execute ping6 2001:db8::10');
    expect(vu).toContain('100 data bytes');
    expect(vu).toContain('108 bytes from 2001:db8::10');
  });
});
