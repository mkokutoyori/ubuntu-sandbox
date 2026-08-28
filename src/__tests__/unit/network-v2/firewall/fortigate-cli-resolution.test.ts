/**
 * La RESOLUTION d'une commande, ses suggestions, sa complétion — 2e volet.
 *
 * Le premier volet (Tab qui défile, `get`/`show` qui proposent l'arbre) est
 * livré. Écrit A L'AVEUGLE contre ce qu'une vraie machine fait, ce fichier
 * mesure ce qui restait EN AMONT de la complétion : 17 des 25 cas tombent.
 *
 *   1. **Une commande s'abrège jusqu'au plus court non ambigu, chemin
 *      compris.** Fortinet en donne l'exemple lui-même : « the command
 *      `get system status` could be abbreviated to `g sy stat` ». Le VERBE
 *      s'abrégeait ; le CHEMIN de `get`/`show` ne s'abrégeait pas, faute
 *      d'être un chemin de mots-clés. `get sys status` répondait « unknown
 *      configuration path ».
 *   2. **`execute pin 1.1.1.1` répondait « is not implemented in this
 *      simulator »** — pour une commande qui l'est. Le message envoie
 *      chercher une limite de produit là où il n'y a qu'une abréviation
 *      non résolue, et c'est le plus coûteux des défauts mesurés ici.
 *   3. **`execute ` proposait 4 sous-commandes sur 9.** La commande est
 *      UNE spec dont l'argument `REST` avale la ligne, et la répartition
 *      une chaîne de `if` : les noms ne vivaient nulle part où `?`, Tab ou
 *      la résolution puissent les lire.
 *   4. **`edit ` ne proposait RIEN**, table peuplée ou non. Les clés
 *      étaient pourtant déclarées en `alternatives` — c'est le socle
 *      partagé qui les jetait, filtrant les valeurs proposables sur
 *      `/^[a-z]…/`, donc sur leur CASSE. Un objet FortiOS s'appelle
 *      `SRV-WEB` : aucun n'était proposable, sur aucun constructeur.
 *
 * Deux prémisses de la sonde ont été RENVERSÉES par la mesure, et les deux
 * fois c'est la sonde qui avait tort : `exe pin` est bel et bien ambigu
 * (`ping` et `ping-options`), et `get s status` ne l'est pas (`system` est
 * la seule branche en `s`). Les cas disent maintenant ce que la règle
 * décide vraiment, y compris qu'un mot EXACT l'emporte sur le préfixe
 * qu'il partage.
 *
 * Un second passage, mesuré après le premier, a trouvé trois choses de
 * plus — et les deux premières sont ce qu'un opérateur tape le plus
 * souvent, parce que le tutoriel lui-même écrit `set srcaddr "NET-LAN"` :
 *
 *   5. **Une valeur commencée ENTRE GUILLEMETS ne se complétait pas.**
 *      `set srcaddr "N` + Tab ne proposait rien : le guillemet ouvrant
 *      faisait partie du préfixe comparé, et aucun candidat ne commence
 *      par `"`. La complétion travaille maintenant sur la valeur nue et
 *      rend le guillemet — ouvrant ET fermant — comme un vrai FortiGate.
 *   6. **`show firewall address ` ne proposait aucune CLÉ**, et
 *      `show system ` aucune sous-branche : les alternatives d'un chemin
 *      libre sont statiques, donc bornées au premier niveau. La
 *      complétion descend désormais l'arbre au niveau déjà tapé, et
 *      propose les entrées quand le chemin nomme une table.
 *   7. **Une LISTE de valeurs ne se complétait qu'à la première.**
 *      `set srcaddr NET-LAN ` ne proposait plus rien, alors que
 *      `set srcaddr "NET-LAN" "NET-DMZ"` est la forme ordinaire. La place
 *      d'une valeur multiple est un `REST` : le curseur y voit tout ce qui
 *      reste, et compare donc `NET-LAN ` aux candidats. La porte FortiOS
 *      interroge maintenant le socle sur le SEUL mot en cours, et
 *      seulement quand l'attribut accepte vraiment plusieurs valeurs —
 *      `set action accept ` ne propose rien après lui.
 *   8. Trois cas vérifient tout cela **dans le terminal**, là où
 *      l'opérateur tape vraiment — pas seulement sur le shell.
 *
 * Les trois cas de GARDE : toute sous-commande déclarée
 * répond, toute vue déclarée rend quelque chose, et la liste proposée est
 * exactement la liste déclarée. Sans eux, les deux vocabulaires déclarés
 * ici pourraient dériver en silence vers une promesse fausse — ce qui est
 * précisément le défaut n°2.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { openFortiConsole } from './fortiConsoleHarness';
import { FortiTerminalSession } from '@/terminal/sessions';
import {
  FORTI_EXECUTE_COMMANDS,
} from '@/network/devices/firewall/vendors/fortios/execute/executeVocabulary';
import {
  FORTI_GET_VIEWS,
} from '@/network/devices/firewall/vendors/fortios/view/pathResolution';

function shell(): { fgt: FortiGate; sh: FortiShell } {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  return { fgt, sh: new FortiShell(fgt) };
}

function taper(sh: FortiShell, ...lignes: string[]): string {
  let derniere = '';
  for (const ligne of lignes) derniere = sh.execute(ligne);
  return derniere;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

describe('une commande s\'abrege jusqu\'au plus court non ambigu', () => {
  it('`g sy stat` est l\'exemple de Fortinet lui-meme', () => {
    const { sh } = shell();
    expect(sh.execute('g sy stat')).toContain('Version: FortiGate-VM64');
  });

  it('`sh sys glo` rend la configuration comme `show system global`', () => {
    const { sh } = shell();
    taper(sh, 'config system global', 'set hostname "PAREFEU"', 'end');
    expect(sh.execute('sh sys glo')).toBe(sh.execute('show system global'));
    expect(sh.execute('sh sys glo')).toContain('set hostname "PAREFEU"');
  });

  it('`conf sys int` ouvre bien `config system interface`', () => {
    const { sh } = shell();
    expect(taper(sh, 'conf sys int', 'edit "port1"',
      'set ip 10.0.0.1 255.255.255.0', 'next', 'end')).toBe('');
    expect(sh.execute('show system interface port1')).toContain('set ip 10.0.0.1');
  });

  it('un chemin AMBIGU est refuse en nommant les candidats', () => {
    const { sh } = shell();
    const refus = sh.execute('show f address');
    expect(refus).toMatch(/ambiguous/i);
    expect(refus).toContain('firewall');
    expect(refus).toContain('file-filter');
  });

  it('un prefixe qui ne designe qu\'UNE branche suffit', () => {
    const { sh } = shell();
    taper(sh, 'config system dns', 'set primary 9.9.9.9', 'end');
    expect(sh.execute('show sy dns')).toContain('set primary 9.9.9.9');
  });

  it('l\'abreviation vaut AUSSI dans la profondeur du chemin', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address', 'edit "SRV"',
      'set subnet 10.0.0.1 255.255.255.255', 'next', 'end');
    expect(sh.execute('show fire polic')).toContain('config firewall policy');
    expect(sh.execute('show fire addr')).toMatch(/ambiguous/i);
  });

  it('un mot COMPLET l\'emporte sur la table dont il est le prefixe', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address', 'edit "SRV"',
      'set subnet 10.0.0.1 255.255.255.255', 'next', 'end');
    expect(sh.execute('show firewall address')).toContain('edit "SRV"');
    expect(sh.execute('show fire addre'))
      .toMatch(/ambiguous.*address, address6/i);
  });

  it('un chemin qui ne correspond a RIEN garde le mot tape', () => {
    const { sh } = shell();
    expect(sh.execute('get zzz status')).toContain('zzz');
  });

  it('l\'aide d\'un chemin inconnu nomme le VERBE tape', () => {
    const { sh } = shell();
    expect(sh.execute('get zzz')).toContain('get ?');
    expect(sh.execute('show zzz')).toContain('show ?');
  });
});

describe('`execute` connait ses sous-commandes', () => {
  it('`exe trac` resout vers `execute traceroute`', () => {
    const { sh } = shell();
    const sortie = sh.execute('exe trac 10.9.9.9');
    expect(sortie).not.toMatch(/not implemented in this simulator/);
    expect(sortie).not.toMatch(/ambiguous/i);
    expect(sortie).toMatch(/traceroute|Unable|unreachable|\*/i);
  });

  it('`pin` est AMBIGU, parce que `ping-options` existe aussi', () => {
    const { sh } = shell();
    const refus = sh.execute('exe pin 10.9.9.9');
    expect(refus).toMatch(/ambiguous/i);
    expect(refus).toContain('ping');
    expect(refus).toContain('ping-options');
  });

  it('`ping` EXACT l\'emporte sur le prefixe qu\'il partage', () => {
    const { sh } = shell();
    const sortie = sh.execute('execute ping 10.9.9.9');
    expect(sortie).not.toMatch(/ambiguous/i);
    expect(sortie).toMatch(/Unable to send|PING|packet loss/);
  });

  it('une sous-commande VRAIMENT inconnue le dit sans parler du simulateur', () => {
    const { sh } = shell();
    const refus = sh.execute('execute zorglub');
    expect(refus).not.toMatch(/not implemented in this simulator/);
    expect(refus).toMatch(/unknown|invalid/i);
    expect(refus).toContain('zorglub');
  });

  it('une abreviation AMBIGUE d\'`execute` est refusee', () => {
    const { sh } = shell();
    const refus = sh.execute('execute d');
    expect(refus).toMatch(/ambiguous/i);
    expect(refus).toContain('date');
    expect(refus).toContain('dhcp');
  });

  it('la completion propose les sous-commandes reelles', () => {
    const { sh } = shell();
    const proposees = sh.completions('execute ');
    for (const attendue of ['ping', 'traceroute', 'date', 'time', 'log', 'ha']) {
      expect(proposees).toContain(`execute ${attendue}`);
    }
  });

  it('la completion FILTRE sur le prefixe tape', () => {
    const { sh } = shell();
    expect(sh.completions('execute p')).toContain('execute ping');
    expect(sh.completions('execute p')).toContain('execute ping-options');
    expect(sh.completions('execute p')).not.toContain('execute date');
  });

  it('`execute ?` decrit chaque sous-commande', () => {
    const { sh } = shell();
    const aide = sh.execute('execute ?');
    expect(aide).toContain('ping');
    expect(aide).toContain('traceroute');
    expect(aide).toMatch(/ping\s+\S/);
  });
});

describe('`edit` propose les cles qui existent', () => {
  it('la completion rend les entrees de la table ouverte', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address',
      'edit "SRV-WEB"', 'set subnet 10.0.0.1 255.255.255.255', 'next',
      'edit "SRV-MAIL"', 'set subnet 10.0.0.2 255.255.255.255', 'next', 'end');
    taper(sh, 'config firewall address');

    const proposees = sh.completions('edit ');
    expect(proposees).toContain('edit SRV-WEB');
    expect(proposees).toContain('edit SRV-MAIL');
  });

  it('`edit ?` liste les entrees ET garde la place libre', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address',
      'edit "SRV-WEB"', 'set subnet 10.0.0.1 255.255.255.255', 'next', 'end');
    taper(sh, 'config firewall address');

    const aide = sh.execute('edit ?');
    expect(aide).toContain('SRV-WEB');
    expect(aide).toMatch(/WORD|<string>/);
  });

  it('une table VIDE ne propose rien, et `edit` cree quand meme', () => {
    const { sh } = shell();
    taper(sh, 'config firewall vip');
    expect(sh.completions('edit ')).toHaveLength(0);
    expect(taper(sh, 'edit "NEUVE"', 'set extip 203.0.113.9',
      'set mappedip "10.0.0.9"', 'next', 'end')).toBe('');
  });

  it('la proposition suit la table OUVERTE, pas une autre', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address',
      'edit "ADRESSE"', 'set subnet 10.0.0.1 255.255.255.255', 'next', 'end');
    taper(sh, 'config firewall policy');

    expect(sh.completions('edit ')).not.toContain('edit ADRESSE');
  });
});

describe('ce que le premier volet a livre continue de valoir', () => {
  it('la completion d\'un attribut filtre toujours sur son prefixe', () => {
    const { sh } = shell();
    taper(sh, 'config firewall policy', 'edit 1');
    expect(sh.completions('set src')).toContain('set srcaddr');
    expect(sh.completions('set src')).not.toContain('set dstaddr');
  });

  it('la completion d\'une valeur de reference rend les interfaces', () => {
    const { sh } = shell();
    taper(sh, 'config firewall policy', 'edit 1');
    expect(sh.completions('set srcintf ')).toContain('set srcintf port1');
  });
});

describe('une valeur ENTRE GUILLEMETS se complete quand meme', () => {
  it('un nom d\'objet commence a etre tape entre guillemets', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address', 'edit "NET-LAN"',
      'set subnet 192.168.10.0 255.255.255.0', 'next', 'end');
    taper(sh, 'config firewall policy', 'edit 1');

    expect(sh.completions('set srcaddr "N')).toContain('set srcaddr "NET-LAN"');
  });

  it('la meme valeur SANS guillemets se complete sans en ajouter', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address', 'edit "NET-LAN"',
      'set subnet 192.168.10.0 255.255.255.0', 'next', 'end');
    taper(sh, 'config firewall policy', 'edit 1');

    expect(sh.completions('set srcaddr N')).toContain('set srcaddr NET-LAN');
  });

  it('une cle de table se complete aussi entre guillemets', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address', 'edit "SRV-WEB"',
      'set subnet 10.0.0.1 255.255.255.255', 'next', 'end');
    taper(sh, 'config firewall address');

    expect(sh.completions('edit "SRV')).toContain('edit "SRV-WEB"');
  });

  it('un guillemet ouvert qui ne correspond a RIEN ne propose rien', () => {
    const { sh } = shell();
    taper(sh, 'config firewall policy', 'edit 1');
    expect(sh.completions('set srcaddr "zzz')).toHaveLength(0);
  });
});

describe('`show` et `get` proposent les CLES de la table nommee', () => {
  it('les entrees de la table sont proposees apres son chemin', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address',
      'edit "SRV-WEB"', 'set subnet 10.0.0.1 255.255.255.255', 'next',
      'edit "SRV-MAIL"', 'set subnet 10.0.0.2 255.255.255.255', 'next', 'end');

    const proposees = sh.completions('show firewall address ');
    expect(proposees).toContain('show firewall address SRV-WEB');
    expect(proposees).toContain('show firewall address SRV-MAIL');
  });

  it('`get` propose les memes cles', () => {
    const { sh } = shell();
    taper(sh, 'config firewall address', 'edit "SRV-WEB"',
      'set subnet 10.0.0.1 255.255.255.255', 'next', 'end');

    expect(sh.completions('get firewall address ')).toContain(
      'get firewall address SRV-WEB');
  });

  it('un chemin qui n\'est pas une table ne propose pas de cle', () => {
    const { sh } = shell();
    expect(sh.completions('show system global ')).toHaveLength(0);
  });

  it('les BRANCHES continuent de se proposer sous un chemin partiel', () => {
    const { sh } = shell();
    expect(sh.completions('show system ')).toContain('show system interface');
  });
});

describe('une liste de valeurs se complete a chaque valeur', () => {
  function labo() {
    const { fgt, sh } = shell();
    taper(sh, 'config firewall address',
      'edit "NET-LAN"', 'set subnet 192.168.10.0 255.255.255.0', 'next',
      'edit "NET-DMZ"', 'set subnet 192.168.20.0 255.255.255.0', 'next', 'end');
    taper(sh, 'config firewall policy', 'edit 1');
    return { fgt, sh };
  }

  it('la DEUXIEME valeur se propose comme la premiere', () => {
    const { sh } = labo();
    expect(sh.completions('set srcaddr NET-LAN ')).toContain(
      'set srcaddr NET-LAN NET-DMZ');
  });

  it('elle se propose aussi ENTRE GUILLEMETS', () => {
    const { sh } = labo();
    expect(sh.completions('set srcaddr "NET-LAN" "NET-D')).toContain(
      'set srcaddr "NET-LAN" "NET-DMZ"');
  });

  it('le prefixe de la deuxieme valeur FILTRE', () => {
    const { sh } = labo();
    const proposees = sh.completions('set srcaddr NET-LAN NET-D');
    expect(proposees).toContain('set srcaddr NET-LAN NET-DMZ');
    expect(proposees).not.toContain('set srcaddr NET-LAN NET-LAN');
  });

  it('`append` et `select` completent de la meme facon', () => {
    const { sh } = labo();
    expect(sh.completions('append srcaddr NET-LAN ')).toContain(
      'append srcaddr NET-LAN NET-DMZ');
  });

  it('une valeur UNIQUE ne propose rien apres elle', () => {
    const { sh } = labo();
    expect(sh.completions('set action accept ')).toHaveLength(0);
  });
});

describe('un vocabulaire declare ne ment pas', () => {
  it('chaque sous-commande d\'`execute` declaree REPOND', () => {
    for (const command of FORTI_EXECUTE_COMMANDS) {
      const { sh } = shell();
      const sortie = sh.execute(`execute ${command.name}`);
      expect(sortie, command.name).not.toMatch(/unknown action/i);
      expect(sortie, command.name).not.toMatch(/not implemented in this simulator/);
    }
  });

  it('chaque vue de `get` declaree REND quelque chose', () => {
    for (const view of FORTI_GET_VIEWS) {
      const { sh } = shell();
      const sortie = sh.execute(`get ${view.join(' ')}`);
      expect(sortie, view.join(' ')).not.toMatch(/unknown configuration path/i);
      expect(sortie, view.join(' ')).not.toMatch(/Unknown action/);
    }
  });

  it('chaque sous-commande declaree est PROPOSEE, et l\'inverse aussi', () => {
    const { sh } = shell();
    const proposees = sh.completions('execute ')
      .map(ligne => ligne.slice('execute '.length));
    const declarees = FORTI_EXECUTE_COMMANDS.map(command => command.name);

    for (const nom of declarees) expect(proposees).toContain(nom);
    for (const nom of proposees) expect(declarees).toContain(nom);
  });
});

const touche = (k: string) => ({
  key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
}) as never;

const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

async function terminal(fgt: FortiGate): Promise<FortiTerminalSession> {
  return openFortiConsole(fgt);
}

async function tab(session: FortiTerminalSession, saisie: string): Promise<string> {
  session.setInput(saisie);
  session.handleKey(touche('Tab'));
  await tick();
  return session.input;
}

describe('la meme chose DANS LE TERMINAL, la ou l\'operateur tape', () => {
  it('Tab complete un nom d\'objet entre guillemets', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const session = await terminal(fgt);
    for (const ligne of ['config firewall address', 'edit "NET-LAN"',
      'set subnet 192.168.10.0 255.255.255.0', 'next', 'end',
      'config firewall policy', 'edit 1']) await fgt.executeCommand(ligne);

    expect(await tab(session, 'set srcaddr "N')).toBe('set srcaddr "NET-LAN" ');
  });

  it('Tab descend dans le chemin d\'un `show`', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    const session = await terminal(fgt);
    expect(await tab(session, 'show system inte')).toBe('show system interface ');
  });

  it('une commande abregee s\'execute depuis le terminal', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    expect(await fgt.executeCommand('g sy stat')).toContain('Version: FortiGate-VM64');
  });
});
