/**
 * La tabulation DEVELOPPE la ligne entiere, comme sur le Cisco du depot.
 *
 * DEMANDE de l'utilisateur : « conf t + tab devient configure terminal,
 * je voudrais ce meme comportement sur FortiGate ».
 *
 * MESURE DE DEPART, les deux plateformes cote a cote :
 *
 *   CISCO  "conf t"       -> "configure terminal"
 *   FORTI  "conf sys glo" -> "conf sys global"
 *
 * Seul le DERNIER mot est developpe cote FortiOS : la tete de ligne est
 * recopiee telle qu'elle a ete tapee (`${head}${value}` dans
 * `FortiShell.completions`). Deux consequences mesurees en plus :
 *
 *   FORTI  "sh sys int"   -> aucune proposition
 *   FORTI  "get sys stat" -> aucune proposition
 *
 * — les chemins de `show`/`get` parcourent l'arbre avec les mots BRUTS,
 * donc une abreviation n'y resout rien, alors que la meme commande
 * s'EXECUTE parfaitement abregee.
 *
 * L'abreviation est attestee par la documentation Fortinet elle-meme :
 * « The command get system status could be abbreviated to g sy stat.
 * Valid command lines must be unambiguous if abbreviated. » Le cyclage
 * l'est aussi : « The Tab key completes the word with the next available
 * match, and pressing the Tab key multiple times cycles through
 * available matches. »
 *
 *   1. `conf sys glo` se developpe en `config system global`.
 *   2. `conf` se developpe en `config`.
 *   3. `g sy stat` — l'abreviation de la documentation Fortinet — se
 *      developpe en `get system status`.
 *   4. `sh sys int` se developpe en `show system interface`.
 *   5. `diag sys se` developpe sa tete elle aussi.
 *   6. La ligne developpee S'EXECUTE : ce n'est pas un affichage.
 *   7. Le CYCLAGE tient : une tete abregee suivie d'un prefixe ambigu
 *      rend PLUSIEURS propositions, toutes entierement developpees.
 *   8. Une valeur n'est PAS un mot-cle : ce qui ne resout pas reste
 *      verbatim, et les guillemets sont preserves.
 *   9. TEMOIN : le Cisco du depot developpe toujours `conf t`.
 *  10. TEMOIN : un mot inconnu ne propose rien.
 *
 * Discrimine par `git stash push -- src/network/` : 5 cas tombent avant
 * correctif. Les 5 qui passent des DEUX cotes sont nommes ici, et aucun
 * ne prouve la fonction :
 *
 *   - `conf` -> `config` et le TEMOIN Cisco : un seul mot n'a pas de
 *     tete a developper, donc l'ancien code y suffisait ;
 *   - « la ligne developpee s'execute » : l'execution acceptait DEJA la
 *     forme abregee, c'est meme ce qui rendait le defaut invisible ;
 *   - « une valeur reste verbatim » : rien ne developpait, donc rien ne
 *     pouvait mal developper ;
 *   - le TEMOIN du mot inconnu, dont c'est l'objet.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

function neuf(): void {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
}

function pareFeu(): FortiGate {
  neuf();
  return new FortiGate('firewall-fortinet', 'FGT', 0, 0);
}

beforeEach(() => { Logger.reset(); });

describe('la tabulation developpe la ligne entiere', () => {
  it('`conf sys glo` devient `config system global`', () => {
    const fw = pareFeu();

    expect(fw.cliTabCandidates('conf sys glo')).toEqual(['config system global']);
  });

  it('`conf` devient `config`', () => {
    const fw = pareFeu();

    expect(fw.cliTabCandidates('conf')).toEqual(['config']);
  });

  it('`g sy stat` — l\'abreviation de la documentation Fortinet', () => {
    const fw = pareFeu();

    expect(fw.cliTabCandidates('g sy stat')).toEqual(['get system status']);
  });

  it('`sh sys int` devient `show system interface`', () => {
    const fw = pareFeu();

    expect(fw.cliTabCandidates('sh sys int')).toEqual(['show system interface']);
  });

  it('`diag sys se` developpe sa tete', () => {
    const fw = pareFeu();

    for (const candidate of fw.cliTabCandidates('diag sys se')) {
      expect(candidate.startsWith('diagnose ')).toBe(true);
    }
    expect(fw.cliTabCandidates('diag sys se').length).toBeGreaterThan(0);
  });

  it('la ligne developpee s\'execute', () => {
    const fw = pareFeu();
    const developpee = fw.cliTabCandidates('conf sys glo')[0];

    expect(fw.getShell().execute(developpee)).toBe('');
    expect(fw.getPrompt()).toBe('FGT (global) # ');
  });

  it('le cyclage tient : plusieurs propositions, toutes developpees', () => {
    const fw = pareFeu();

    const proposals = fw.cliTabCandidates('conf sys ');

    expect(proposals.length).toBeGreaterThan(1);
    for (const candidate of proposals) {
      expect(candidate.startsWith('config system ')).toBe(true);
    }
  });

  it('une valeur reste verbatim, guillemets compris', () => {
    const fw = pareFeu();
    const shell = fw.getShell();
    shell.execute('config system interface');
    shell.execute('edit "port1"');

    for (const candidate of fw.cliTabCandidates('set allowa')) {
      expect(candidate).toBe('set allowaccess');
    }
    expect(fw.cliTabCandidates('set ip 192.168')).toEqual([]);
  });

  it('TEMOIN : le Cisco du depot developpe toujours `conf t`', async () => {
    neuf();
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');

    expect(r.cliTabCandidates('conf t')).toEqual(['configure terminal']);
  });

  it('TEMOIN : un mot inconnu ne propose rien', () => {
    const fw = pareFeu();

    expect(fw.cliTabCandidates('zorglub')).toEqual([]);
  });
});
