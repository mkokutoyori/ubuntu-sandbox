/**
 * Deux attributs etaient INTERVERTIS entre `config system global` et
 * `config system settings`, et l'un des deux etait inerte.
 *
 * Mesure de depart, sur un boitier neuf :
 *
 *   config system global   / set firewall-session-dirty ...  -> ACCEPTE
 *   config system settings / set firewall-session-dirty ...  -> refuse
 *   config system settings / set ip-fragment-mem-thresholds  -> ACCEPTE
 *   config system global   / set ip-fragment-mem-thresholds  -> refuse
 *
 * Les deux vraies machines font exactement l'inverse, et les deux
 * autorites concordent. `official_docs/forti-cli-ref-60.txt` place
 * `firewall-session-dirty {check-all | check-new | check-policy-option}`
 * dans `config system settings` -- avec les TROIS valeurs, la troisieme
 * n'ayant de sens qu'a un niveau situe AU-DESSUS des politiques -- et
 * `{check-all | check-new}` sur `config firewall policy` ; il n'est nulle
 * part dans `config system global`. Le module `fortios_system_settings`
 * de la collection Ansible de Fortinet le declare aux memes trois
 * valeurs, avec le libelle que nous reprenons mot pour mot, et le module
 * `fortios_system_global` ne le porte pas. Symetriquement,
 * `ip-fragment-mem-thresholds` est un attribut de `config system global`
 * (« 32M memory threshold », apparu en 7.0.8 / 7.2.4) : il est absent de
 * la reference 6.0.4, qui lui est anterieure, et c'est la documentation
 * courante qui le place.
 *
 * Nos bornes 32 / 32-2047 sont conformes et ne changent pas : seule la
 * TABLE etait fausse, et il ne fallait pas corriger la valeur en croyant
 * corriger la table.
 *
 * `firewall-session-dirty` etait de surcroit ENTIEREMENT INERTE :
 * declare une fois, consomme par personne -- le « critere range que l'on
 * n'evalue pas » que ce depot refuse. Il gouverne desormais ce qu'il
 * promet : quand une politique change, les sessions qu'elle avait
 * acceptees sont purgees ou conservees selon le reglage du VDOM, et
 * `check-policy-option` va lire le reglage de la politique elle-meme --
 * ce pour quoi l'attribut a fallu etre declare AUSSI sur `config
 * firewall policy`, ou la reference l'atteste a deux valeurs.
 *
 * La purge est SELECTIVE et le cas qui l'eprouve compte : elle ne touche
 * que les sessions de la politique modifiee. Purger toute la table
 * serait plus simple et faux -- changer une politique couperait des
 * connexions qu'elle n'a jamais vues.
 *
 * Discrimine par `git stash` sur les cinq fichiers SUIVIS : 5 cas
 * tombent. `SessionDirty.ts` est laisse en place pendant la mesure,
 * etant purement additif -- le code d'avant ne l'importe pas -- et le
 * remiser ne ferait que casser la compilation, ce qui ne discrimine
 * rien.
 *
 * J'avais annonce 8 cas tombants ; la mesure en donne 5, et les 4 qui
 * passent des deux cotes sont nommes ici plutot que le compte ajuste en
 * silence. DEUX d'entre eux passent AVANT correctif POUR UNE RAISON QUI
 * NE PROUVE RIEN, et c'est la meme : rien n'etait purge du tout, donc
 * « `check-new` conserve les sessions » et « la purge ne touche que la
 * politique modifiee » sont vrais d'une machine qui ne purge jamais.
 * Ils gardent que le correctif n'est pas trop LARGE, ce qui reste leur
 * objet. Les deux autres sont :
 *  - le TEMOIN, dont c'est le role : un `curl` a travers le pare-feu
 *    installe une session portant l'identifiant de sa politique, ce qui
 *    a toujours ete vrai et prouve que le laboratoire fonctionne ;
 *  - « le seuil de fragments garde ses bornes », puisque seule la table
 *    changeait et non les bornes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let n = 0;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

function boitier() {
  const fw = new FortiGate('firewall-fortinet', `FGT${++n}`, 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

const run = (sh: FortiShell, ...lignes: string[]) => {
  let dernier = '';
  for (const l of lignes) dernier = sh.execute(l);
  return dernier;
};

async function laboratoire() {
  const { fw, sh } = boitier();
  const poste = new LinuxPC('linux-pc', `POSTE${n}`, -100, 0);
  const serveur = new LinuxServer('linux-server', `WEB${n}`, 100, 0);
  new Cable(`a${n}`).connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable(`b${n}`).connect(fw.getPort('port2')!, serveur.getPort('eth0')!);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end');
  for (const c of ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']) await poste.executeCommand(c);
  for (const c of ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']) await serveur.executeCommand(c);
  await serveur.executeCommand('systemctl start nginx');
  return { fw, sh, poste };
}

function politique(sh: FortiShell, id: string, ...extra: string[]) {
  run(sh, 'config firewall policy', `edit ${id}`, `set name "P${id}"`,
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set action accept',
    'set schedule "always"', 'set service "ALL"', ...extra, 'next', 'end');
}

async function sessionVivante(sh: FortiShell, poste: LinuxPC) {
  politique(sh, '1');
  await poste.executeCommand('curl -sS http://203.0.113.10/');
}

describe('FortiGate : firewall-session-dirty et la table des fragments', () => {
  it('TEMOIN : un curl installe une session portant l id de sa politique', async () => {
    const { fw, sh, poste } = await laboratoire();
    await sessionVivante(sh, poste);
    const vue = fw.getSessionTable().view();
    expect(vue.count()).toBeGreaterThan(0);
    expect(vue.all().map(s => s.policyId)).toContain('1');
  });

  it('`firewall-session-dirty` vit sous system settings, pas sous system global', () => {
    const { fw, sh } = boitier();
    expect(run(sh, 'config system settings', 'set firewall-session-dirty check-new'))
      .toBe('');
    run(sh, 'end');
    expect(fw.getSessionDirtyMode()).toBe('check-new');
    run(sh, 'config system global');
    expect(run(sh, 'set firewall-session-dirty check-new'))
      .toContain('unknown attribute "firewall-session-dirty"');
    run(sh, 'end');
  });

  it('`ip-fragment-mem-thresholds` vit sous system global, pas sous settings', () => {
    const { fw, sh } = boitier();
    expect(run(sh, 'config system global', 'set ip-fragment-mem-thresholds 128')).toBe('');
    run(sh, 'end');
    expect(fw.getFragmentReassembly().getThresholdMegabytes()).toBe(128);
    run(sh, 'config system settings');
    expect(run(sh, 'set ip-fragment-mem-thresholds 64'))
      .toContain('unknown attribute "ip-fragment-mem-thresholds"');
    run(sh, 'end');
  });

  it('le seuil de fragments garde ses bornes', () => {
    const { sh } = boitier();
    run(sh, 'config system global');
    expect(run(sh, 'set ip-fragment-mem-thresholds 4096')).not.toBe('');
    run(sh, 'end');
  });

  it('`check-all` PURGE les sessions de la politique modifiee', async () => {
    const { fw, sh, poste } = await laboratoire();
    run(sh, 'config system settings', 'set firewall-session-dirty check-all', 'end');
    await sessionVivante(sh, poste);
    expect(fw.getSessionTable().view().count()).toBeGreaterThan(0);

    politique(sh, '1', 'set comments "modifiee"');

    expect(fw.getSessionTable().view().all().filter(s => s.policyId === '1'))
      .toHaveLength(0);
  });

  it('`check-new` CONSERVE les sessions deja acceptees', async () => {
    const { fw, sh, poste } = await laboratoire();
    run(sh, 'config system settings', 'set firewall-session-dirty check-new', 'end');
    await sessionVivante(sh, poste);

    politique(sh, '1', 'set comments "modifiee"');

    expect(fw.getSessionTable().view().all().filter(s => s.policyId === '1').length)
      .toBeGreaterThan(0);
  });

  it('`check-policy-option` lit le reglage de la POLITIQUE', async () => {
    const { fw, sh, poste } = await laboratoire();
    run(sh, 'config system settings',
      'set firewall-session-dirty check-policy-option', 'end');
    await sessionVivante(sh, poste);

    politique(sh, '1', 'set firewall-session-dirty check-new');
    expect(fw.getSessionTable().view().all().filter(s => s.policyId === '1').length)
      .toBeGreaterThan(0);

    politique(sh, '1', 'set firewall-session-dirty check-all');
    expect(fw.getSessionTable().view().all().filter(s => s.policyId === '1'))
      .toHaveLength(0);
  });

  it('la purge ne touche QUE la politique modifiee', async () => {
    const { fw, sh, poste } = await laboratoire();
    run(sh, 'config system settings', 'set firewall-session-dirty check-all', 'end');
    await sessionVivante(sh, poste);

    politique(sh, '2');

    expect(fw.getSessionTable().view().all().filter(s => s.policyId === '1').length)
      .toBeGreaterThan(0);
  });

  it('la configuration rendue porte chacun sur SA table', () => {
    const { sh } = boitier();
    run(sh, 'config system settings', 'set firewall-session-dirty check-new', 'end');
    run(sh, 'config system global', 'set ip-fragment-mem-thresholds 128', 'end');
    const global = run(sh, 'show full-configuration system global');
    const settings = run(sh, 'show full-configuration system settings');
    expect(global).toContain('set ip-fragment-mem-thresholds 128');
    expect(global).not.toContain('firewall-session-dirty');
    expect(settings).toContain('set firewall-session-dirty check-new');
    expect(settings).not.toContain('ip-fragment-mem-thresholds');
  });
});
