/**
 * `?` descend dans l'arbre, et l'interface parle anglais.
 *
 * Deux defauts signales depuis le terminal graphique, ecrits ici A
 * L'AVEUGLE avant tout correctif :
 *
 *   1. **`config ?` rendait la liste de la RACINE.** `FortiGate.cliHelp`
 *      recevait le texte tape avant le `?` et le JETAIT — sa signature
 *      nommait l'argument `_inputBeforeQuestion` — puis appelait
 *      `FortiShell.help()`, qui interrogeait le moteur avec la chaine
 *      vide. Le moteur de commandes partage faisait donc son travail
 *      correctement et personne ne lui posait la bonne question. C'est
 *      la difference entre « la completion est incoherente » et « la
 *      porte est mal branchee », et seule la seconde etait vraie.
 *   2. **Les refus etaient rediges en francais.** L'interface d'un
 *      equipement se lit dans la langue de l'equipement ; un FortiGate
 *      ne dit pas « il manque la suite de la commande ».
 *
 * Un noeud intermediaire porte desormais sa propre legende : sans elle
 * `describe()` recopie la description du premier descendant, donc
 * `firewall` s'annoncait « Configure IPv4 addresses. » — la description
 * d'une AUTRE commande.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function shell(): { fw: FortiGate; sh: FortiShell } {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

beforeEach(() => { Logger.reset(); });

describe('`?` descend dans l\'arbre', () => {
  it('la racine annonce les cinq verbes', () => {
    const { sh } = shell();

    const vu = run(sh, '?');

    for (const verbe of ['config', 'diagnose', 'execute', 'get', 'show']) {
      expect(vu).toContain(verbe);
    }
  });

  it('`config ?` annonce les BRANCHES, pas la racine', () => {
    const { sh } = shell();

    const vu = run(sh, 'config ?');

    expect(vu).toContain('firewall');
    expect(vu).toContain('system');
    expect(vu).toContain('router');
    expect(vu).not.toContain('diagnose');
    expect(vu).not.toContain('execute');
  });

  it('`config firewall ?` annonce les tables du pare-feu', () => {
    const { sh } = shell();

    const vu = run(sh, 'config firewall ?');

    expect(vu).toContain('policy');
    expect(vu).toContain('address');
    expect(vu).toContain('vip');
    expect(vu).not.toContain('interface');
  });

  it('une branche porte sa propre legende, pas celle de son premier enfant', () => {
    const { sh } = shell();

    const vu = run(sh, 'config ?');

    expect(vu).toMatch(/firewall\s+Configure firewall\./);
    expect(vu).not.toMatch(/firewall\s+Configure IPv4 addresses\./);
  });

  it('`cliHelp` de l\'equipement lit ce qui precede le `?`', () => {
    const { fw } = shell();

    const vu = fw.cliHelp('config ');

    expect(vu).toContain('firewall');
    expect(vu).not.toContain('diagnose');
  });

  it('un mot partiel filtre les propositions', () => {
    const { sh } = shell();

    const vu = run(sh, 'config sys?');

    expect(vu).toContain('system');
    expect(vu).not.toContain('firewall');
  });

  it('`?` dans un objet ouvert annonce ses attributs', () => {
    const { sh } = shell();

    run(sh, 'config firewall policy', 'edit 1');
    const vu = run(sh, 'set ?');

    expect(vu).toContain('srcintf');
    expect(vu).toContain('dstaddr');
    expect(vu).toContain('action');
  });
});

describe('l\'interface parle anglais', () => {
  it('une commande inconnue se refuse en anglais', () => {
    const { sh } = shell();

    const vu = run(sh, 'nimportequoi');

    expect(vu).toContain('Unknown action 0');
    expect(vu).toMatch(/unknown command/i);
    expect(vu).not.toMatch(/[àâçéèêëîïôùûü]/);
  });

  it('une commande incomplete se refuse en anglais', () => {
    const { sh } = shell();

    const vu = run(sh, 'config');

    expect(vu).toContain('Command fail. Return code -61');
    expect(vu).toMatch(/is missing/);
    expect(vu).not.toMatch(/[àâçéèêëîïôùûü]/);
  });

  it('un chemin inconnu se refuse en anglais', () => {
    const { sh } = shell();

    const vu = run(sh, 'config nimportequoi');

    expect(vu).toMatch(/unknown configuration path/);
    expect(vu).not.toMatch(/[àâçéèêëîïôùûü]/);
  });

  it('un attribut inconnu se refuse en anglais', () => {
    const { sh } = shell();

    run(sh, 'config firewall policy', 'edit 1');
    const vu = run(sh, 'set nimportequoi 1');

    expect(vu).toMatch(/unknown attribute/);
    expect(vu).not.toMatch(/[àâçéèêëîïôùûü]/);
  });

  it('une reference absente se refuse en anglais', () => {
    const { sh } = shell();

    run(sh, 'config firewall policy', 'edit 1');
    const vu = run(sh, 'set srcaddr "ABSENT"');

    expect(vu).toContain('entry not found in datasource');
    expect(vu).toMatch(/does not exist/);
    expect(vu).not.toMatch(/[àâçéèêëîïôùûü]/);
  });

  it('aucun refus de la grammaire ne contient d\'accent', () => {
    const { sh } = shell();

    const refus = [
      run(sh, 'write memory'),
      run(sh, 'edit 1'),
      run(sh, 'set nom valeur'),
      run(sh, 'next'),
      run(sh, 'config firewall address', 'move 1 before 2'),
      run(sh, 'delete ABSENT'),
      run(sh, 'end', 'config firewall policy', 'edit 1', 'set policyid 7'),
    ];

    for (const texte of refus) expect(texte).not.toMatch(/[àâçéèêëîïôùûü]/);
  });
});
