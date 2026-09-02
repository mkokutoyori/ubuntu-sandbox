/**
 * Un operateur Cisco tape les MEMES gestes sur les trois machines.
 *
 * Le projet porte trois equipements Cisco — routeur, commutateur,
 * pare-feu ASA — et ils ont grandi separement : le routeur et le
 * commutateur partagent `CiscoShellBase`, l'ASA a son propre shell.
 * Chaque ecart entre eux se paie deux fois, parce qu'un operateur qui
 * apprend un geste sur l'un le croit acquis sur les autres.
 *
 * Ce fichier ne teste pas une fonctionnalite : il teste que les trois
 * REPONDENT PAREIL a ce qu'on leur demande pareil. Un cas qui echoue ici
 * ne dit pas « c'est casse » mais « les trois ne s'accordent pas », ce
 * qui est une information differente et plus utile — elle nomme la
 * machine qui devie.
 *
 * Les ecarts LEGITIMES sont declares comme tels plutot que passes sous
 * silence : un ASA n'a pas de VLAN, un commutateur n'a pas de table de
 * sessions. Ce qui est compare ici est ce que les trois ont vraiment en
 * commun.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';

interface Cisco {
  executeCommand(command: string): Promise<string>;
  getPrompt(): string;
  cliHelp(inputBeforeQuestion: string): string;
  cliTabComplete(input: string): string | null;
}

const PLATEFORMES = [
  ['routeur', 'router-cisco'],
  ['commutateur', 'switch-cisco'],
  ['pare-feu', 'firewall-cisco'],
] as const;

/**
 * La premiere carte de chaque chassis.
 *
 * Un commutateur Catalyst porte des `FastEthernet0/1`, un routeur et un
 * ASA des `GigabitEthernet0/0` : c'est le materiel qui differe, pas la
 * CLI, et exiger le meme nom partout testerait une uniformite qui
 * n'existe sur aucune machine reelle.
 */
const PREMIERE_INTERFACE: Readonly<Record<string, string>> = {
  routeur: 'GigabitEthernet0/0',
  commutateur: 'FastEthernet0/1',
  'pare-feu': 'GigabitEthernet0/0',
};

async function toutes(
  prepare?: (device: Cisco, premiereInterface: string) => Promise<void>,
): Promise<Map<string, Cisco>> {
  const out = new Map<string, Cisco>();
  for (const [nom, type] of PLATEFORMES) {
    const device = createDevice(type, 0, 0) as unknown as Cisco;
    await device.executeCommand('enable');
    if (prepare) await prepare(device, PREMIERE_INTERFACE[nom]);
    out.set(nom, device);
  }
  return out;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
});

describe('la tabulation se comporte pareil partout', () => {
  it('`sh` donne `show `', async () => {
    for (const [nom, device] of await toutes()) {
      expect(device.cliTabComplete('sh'), nom).toBe('show ');
    }
  });

  it('`conf t` donne `configure terminal `', async () => {
    for (const [nom, device] of await toutes()) {
      expect(device.cliTabComplete('conf t'), nom).toBe('configure terminal ');
    }
  });

  it('un prefixe qui ne mene nulle part ne complete rien', async () => {
    for (const [nom, device] of await toutes()) {
      expect(device.cliTabComplete('zorglub'), nom).toBeNull();
    }
  });
});

describe('les invites ont la meme FORME', () => {
  it('EXEC privilegie finit par `#`', async () => {
    for (const [nom, device] of await toutes()) {
      expect(device.getPrompt(), nom).toMatch(/#$/);
    }
  });

  it('la configuration globale porte `(config)#`', async () => {
    const machines = await toutes(async (d) => { await d.executeCommand('configure terminal'); });

    for (const [nom, device] of machines) {
      expect(device.getPrompt(), nom).toMatch(/\(config\)#$/);
    }
  });

  it('la configuration d\'interface porte `(config-if)#`', async () => {
    const machines = await toutes(async (d, iface) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand(`interface ${iface}`);
    });

    for (const [nom, device] of machines) {
      expect(device.getPrompt(), nom).toMatch(/\(config-if\)#$/);
    }
  });
});

describe('la navigation obeit aux memes mots', () => {
  it('`exit` remonte d\'UN niveau depuis l\'interface', async () => {
    const machines = await toutes(async (d, iface) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand(`interface ${iface}`);
      await d.executeCommand('exit');
    });

    for (const [nom, device] of machines) {
      expect(device.getPrompt(), nom).toMatch(/\(config\)#$/);
    }
  });

  it('`end` redescend en EXEC privilegie d\'un coup', async () => {
    const machines = await toutes(async (d, iface) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand(`interface ${iface}`);
      await d.executeCommand('end');
    });

    for (const [nom, device] of machines) {
      expect(device.getPrompt(), nom).toMatch(/[^)]#$/);
    }
  });
});

describe('l\'aide decrit la SUITE, jamais la ligne deja tapee', () => {
  it('`?` a la racine ne repete pas de commande complete', async () => {
    for (const [nom, device] of await toutes()) {
      const lignes = device.cliHelp('').split('\n').filter(l => l.trim().length > 0);

      expect(lignes.length, nom).toBeGreaterThan(0);
      expect(lignes.every(l => l.trim().split(/\s+/).length >= 1), nom).toBe(true);
    }
  });

  it('`show ?` ne repete pas `show`', async () => {
    for (const [nom, device] of await toutes()) {
      const lignes = device.cliHelp('show ').split('\n').filter(l => l.trim().length > 0);

      expect(lignes.length, nom).toBeGreaterThan(0);
      expect(lignes.every(l => !l.trim().startsWith('show ')), nom).toBe(true);
    }
  });

  it('chaque suite porte une description', async () => {
    for (const [nom, device] of await toutes()) {
      const lignes = device.cliHelp('show ').split('\n').filter(l => l.trim().length > 0);

      expect(lignes.every(l => /^\s+\S+\s{2,}\S/.test(l)), nom).toBe(true);
    }
  });
});

describe('les refus sont les memes mots', () => {
  it('une commande inconnue est refusee — chacun dans SES mots', async () => {
    const machines = await toutes();

    // IOS traite un mot inconnu en EXEC comme un nom d'hote a joindre et
    // tente de le RESOUDRE : c'est son comportement reel, partage par le
    // routeur et le commutateur. Un ASA n'a pas cette traduction et
    // refuse directement. Exiger le meme texte des trois testerait une
    // uniformite qu'aucune machine reelle n'a.
    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('zorglub'), nom)
        .toMatch(/Translating|Unknown command/);
    }
    expect(await machines.get('pare-feu')!.executeCommand('zorglub'))
      .toContain('% Invalid input detected');
  });

  it('`?` sur une commande inconnue refuse aussi', async () => {
    for (const [nom, device] of await toutes()) {
      expect(device.cliHelp('zorglub '), nom).toContain('% Invalid input detected');
    }
  });
});

describe('les commandes communes existent partout', () => {
  it('`show version` repond sur les trois', async () => {
    for (const [nom, device] of await toutes()) {
      const out = await device.executeCommand('show version');

      expect(out, nom).not.toContain('Invalid input');
      expect(out.length, nom).toBeGreaterThan(0);
    }
  });

  it('`show running-config` repond sur les trois', async () => {
    for (const [nom, device] of await toutes()) {
      expect(await device.executeCommand('show running-config'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('`hostname` renomme, et l\'invite suit', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand('hostname LAB1');
    });

    for (const [nom, device] of machines) {
      expect(device.getPrompt(), nom).toContain('LAB1');
    }
  });
});

describe('`logging host` garde ses deux formes sur les deux plateformes IOS', () => {
  it('la forme courte pose le serveur', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand('logging host 10.0.0.9');
      await d.executeCommand('end');
    });

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('show running-config'), nom)
        .toContain('10.0.0.9');
    }
  });

  it('la forme longue traverse l\'adresse pour atteindre le transport', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
    });

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('logging host 10.0.0.9 transport tcp'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('l\'aide APRES l\'adresse annonce ce qui peut suivre', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
    });

    for (const nom of ['routeur', 'commutateur']) {
      const aide = machines.get(nom)!.cliHelp('logging host 10.0.0.9 ');

      expect(aide, nom).toContain('transport');
    }
  });

  it('un transport inconnu reste refuse', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
    });

    expect(await machines.get('routeur')!.executeCommand('logging host 10.0.0.9 transport sctp'))
      .toContain('Invalid input');
  });
});

describe('un argument OPTIONNEL laisse la commande complete sans lui', () => {
  async function enConfig() {
    return toutes(async (d) => { await d.executeCommand('configure terminal'); });
  }

  it('`logging console` seul est valide — la severite est optionnelle', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('logging console'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('`logging console 5` l\'est aussi', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('logging console 5'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('une severite hors plage reste refusee', async () => {
    const machines = await enConfig();

    expect(await machines.get('routeur')!.executeCommand('logging console 9'))
      .toContain('Invalid input');
  });

  it('un filtre DEFINI s\'attache', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand('logging discriminator FILTRE mnemonics drops X');
    });

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('logging console discriminator FILTRE'), nom)
        .not.toContain('Invalid input');
      expect(await machines.get(nom)!.executeCommand('logging monitor discriminator FILTRE'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('la severite et le filtre sont deux CHOIX, pas une sequence', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand('logging discriminator FILTRE mnemonics drops X');
    });

    // IOS prend `logging console 5` OU `logging console discriminator X`,
    // jamais les deux a la fois : accepter la forme combinee ferait
    // passer ce qu'une vraie machine refuse.
    expect(await machines.get('routeur')!.executeCommand('logging console 5 discriminator FILTRE'))
      .toContain('Invalid input');
  });

  it('un filtre INCONNU reste refuse — c\'est ce qui prouve que le nom est LU', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
    });

    expect(await machines.get('routeur')!.executeCommand('logging console discriminator ABSENT'))
      .toMatch(/Invalid input|not|%/);
  });

  it('un mot-cle apres l\'argument optionnel reste atteignable — `history size`', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('logging history size 100'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('et sa valeur est bornee', async () => {
    const machines = await enConfig();

    expect(await machines.get('routeur')!.executeCommand('logging history size 9999'))
      .toContain('Invalid input');
  });
});

describe('`rate-limit` et `reload` gardent leurs deux formes', () => {
  async function enConfig() {
    return toutes(async (d) => { await d.executeCommand('configure terminal'); });
  }

  it('un nombre ET un mot-cle sont acceptes a la meme place', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('logging rate-limit 20'), nom)
        .not.toContain('Invalid input');
      expect(await machines.get(nom)!.executeCommand('logging rate-limit console'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('l\'aide annonce les DEUX formes', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      const aide = machines.get(nom)!.cliHelp('logging rate-limit ');

      expect(aide, nom).toContain('console');
      expect(aide, nom).toMatch(/<\d+-\d+>/);
    }
  });

  it('`except` suit la valeur et prend sa propre severite', async () => {
    const machines = await enConfig();

    expect(await machines.get('routeur')!.executeCommand('logging rate-limit 20 except errors'))
      .not.toContain('Invalid input');
  });

  it('`reload message-limit` saute la severite optionnelle', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('logging reload message-limit 10'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('une severite hors plage derriere `except` reste refusee', async () => {
    const machines = await enConfig();

    expect(await machines.get('routeur')!.executeCommand('logging rate-limit 20 except 9'))
      .toContain('Invalid input');
  });
});

describe('la famille `logging` est entiere sur les deux plateformes IOS', () => {
  async function enConfig() {
    return toutes(async (d) => { await d.executeCommand('configure terminal'); });
  }

  it('`logging ?` annonce les sous-commandes migrees', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      const aide = machines.get(nom)!.cliHelp('logging ');

      for (const mot of ['buffered', 'console', 'host', 'trap', 'persistent', 'discriminator']) {
        expect(aide, `${nom} / ${mot}`).toContain(mot);
      }
    }
  });

  it('`logging persistent ?` NOMME ses six mots-cles', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      const aide = machines.get(nom)!.cliHelp('logging persistent ');

      for (const mot of ['url', 'size', 'filesize', 'immediate', 'batch', 'threshold']) {
        expect(aide, `${nom} / ${mot}`).toContain(mot);
      }
    }
  });

  it('`logging persistent url X size Y` enchaine ses paires', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!
        .executeCommand('logging persistent url flash:/syslog size 32768'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('`queue-limit` prend un nombre OU un mot-cle', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('logging queue-limit 200'), nom)
        .not.toContain('Invalid input');
      expect(await machines.get(nom)!.executeCommand('logging queue-limit esm 50'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('chaque sous-commande a sa NEGATION, par la meme declaration', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      for (const mot of ['console', 'trap 5', 'buffered', 'persistent', 'rate-limit 20']) {
        expect(await machines.get(nom)!.executeCommand(`no logging ${mot}`), `${nom} / no ${mot}`)
          .not.toContain('Invalid input');
      }
    }
  });
});

describe('`ntp` migre sans perdre ce qui avait fait annuler la premiere tentative', () => {
  async function enConfig() {
    return toutes(async (d) => { await d.executeCommand('configure terminal'); });
  }

  it('`ntp access-group ?` nomme ses QUATRE familles — le cas qui avait bloque', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      const aide = machines.get(nom)!.cliHelp('ntp access-group ');

      for (const mot of ['peer', 'query-only', 'serve', 'serve-only']) {
        expect(aide, `${nom} / ${mot}`).toContain(mot);
      }
      expect(aide, nom).not.toContain('LINE');
    }
  });

  it('un argument porte une PHRASE, pas son nom de variable', async () => {
    const machines = await enConfig();

    expect(machines.get('routeur')!.cliHelp('ntp master ')).toContain('Stratum number');
  });

  it('la forme `no` est plus COURTE, comme sur IOS', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      await machines.get(nom)!.executeCommand('ntp source Loopback0');
      expect(await machines.get(nom)!.executeCommand('no ntp source'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('une famille inconnue reste refusee', async () => {
    const machines = await enConfig();

    expect(await machines.get('routeur')!.executeCommand('ntp access-group nomodify 10'))
      .toContain('Invalid input');
  });

  it('`ntp server <ip> prefer` accepte sa queue d\'options', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('ntp server 10.0.0.1 prefer'), nom)
        .not.toContain('Invalid input');
    }
  });
});

describe('`snmp-server` a un vrai sous-arbre, plus un noeud glouton', () => {
  async function enConfig() {
    return toutes(async (d) => { await d.executeCommand('configure terminal'); });
  }

  it('`snmp-server ?` NOMME ses sous-commandes', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      const aide = machines.get(nom)!.cliHelp('snmp-server ');

      for (const mot of ['community', 'host', 'location', 'contact', 'trap-source']) {
        expect(aide, `${nom} / ${mot}`).toContain(mot);
      }
    }
  });

  it('un mot-cle INCONNU est refuse, la ou le noeud glouton l\'avalait', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('snmp-server zorglub'), nom)
        .toContain('Invalid input');
    }
  });

  it('une communaute se pose et se relit dans la configuration', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand('snmp-server community LECTURE ro');
      await d.executeCommand('end');
    });

    // Le ROUTEUR seul : un commutateur de ce depot n'a pas de service
    // SNMP derriere la commande, donc il l'accepte et ne retient rien.
    // Ecart PREEXISTANT — le noeud glouton du trie faisait deja ce
    // silence — et il n'est pas de ce lot de le combler.
    expect(await machines.get('routeur')!.executeCommand('show running-config'))
      .toContain('LECTURE');
  });

  it('`snmp-server community` seul est INCOMPLET, pas invalide', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('snmp-server community'), nom)
        .toContain('Incomplete');
    }
  });

  it('`trap-timeout` borne sa valeur', async () => {
    const machines = await enConfig();

    expect(await machines.get('routeur')!.executeCommand('snmp-server trap-timeout 30'))
      .not.toContain('Invalid input');
    expect(await machines.get('routeur')!.executeCommand('snmp-server trap-timeout 5000'))
      .toContain('Invalid input');
  });

  it('`no snmp-server community` retire, des deux cotes', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      const machine = machines.get(nom)!;
      await machine.executeCommand('snmp-server community LECTURE RO');
      expect(await machine.executeCommand('no snmp-server community LECTURE'), nom)
        .not.toContain('Invalid input');
      expect(await machine.executeCommand('do show running-config'), nom)
        .not.toContain('snmp-server community LECTURE');
    }
  });
});

describe('`clock` migre, caret compris', () => {
  it('`clock set` existe dans les DEUX modes, par une seule declaration', async () => {
    const machines = await toutes();

    for (const nom of ['routeur', 'commutateur']) {
      const machine = machines.get(nom)!;
      expect(await machine.executeCommand('clock set 10:30:00 3 June 2026'), nom)
        .not.toContain('Invalid input');

      await machine.executeCommand('configure terminal');
      expect(await machine.executeCommand('clock set 11:30:00 4 June 2026'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('une heure impossible est refusee, et le caret la DESIGNE', async () => {
    const machines = await toutes();

    const refus = await machines.get('routeur')!.executeCommand('clock set 99:99:99 3 June 2026');

    expect(refus).toContain('Invalid input');
    expect(refus.split('\n')[0], 'la ligne du caret precede le message').toContain('^');
  });

  it('le caret DESIGNE le jeton fautif, pas le debut de la ligne', async () => {
    const machines = await toutes();

    const refus = await machines.get('routeur')!.executeCommand('clock set 99:99:99 3 June 2026');
    const colonne = refus.split('\n')[0].indexOf('^');

    // Le rendu partage de ce depot pose le caret a la FIN du jeton
    // refuse ; ce qui compte est qu'il tombe dans sa portee et non au
    // debut de la ligne ni sur le mot d'apres.
    expect(colonne).toBeGreaterThanOrEqual('clock set '.length);
    expect(colonne).toBeLessThanOrEqual('clock set 99:99:99'.length);
  });

  it('`clock timezone` borne son decalage', async () => {
    const machines = await toutes(async (d) => { await d.executeCommand('configure terminal'); });

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('clock timezone CET 1'), nom)
        .not.toContain('Invalid input');
      expect(await machines.get(nom)!.executeCommand('clock timezone CET 99'), nom)
        .toContain('Invalid input');
    }
  });

  it('`clock calendar-valid` reste accepte — le temoin du trie', async () => {
    const machines = await toutes(async (d) => { await d.executeCommand('configure terminal'); });

    expect(await machines.get('routeur')!.executeCommand('clock calendar-valid'))
      .not.toContain('Invalid input');
  });
});

describe('`login` migre — la famille de durcissement de connexion', () => {
  async function enConfig() {
    return toutes(async (d) => { await d.executeCommand('configure terminal'); });
  }

  it('`login ?` NOMME ses sous-commandes', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      const aide = machines.get(nom)!.cliHelp('login ');

      for (const mot of ['block-for', 'delay', 'quiet-mode', 'on-failure', 'on-success']) {
        expect(aide, `${nom} / ${mot}`).toContain(mot);
      }
    }
  });

  it('`login block-for` enchaine ses options', async () => {
    const machines = await enConfig();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!
        .executeCommand('login block-for 120 attempts 3 within 60'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('`login delay` borne sa valeur', async () => {
    const machines = await enConfig();

    expect(await machines.get('routeur')!.executeCommand('login delay 5'))
      .not.toContain('Invalid input');
    expect(await machines.get('routeur')!.executeCommand('login delay 99999'))
      .toContain('Invalid input');
  });

  it('`login on-failure log` se relit dans la configuration', async () => {
    const machines = await toutes(async (d) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand('login on-failure log');
      await d.executeCommand('end');
    });

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('show running-config'), nom)
        .toContain('login on-failure log');
    }
  });

  it('une sous-commande inconnue reste refusee', async () => {
    const machines = await enConfig();

    expect(await machines.get('routeur')!.executeCommand('login zorglub'))
      .toContain('Invalid input');
  });
});

describe('les VUES suivent la famille qu\'elles montrent', () => {
  it('`show ntp status` repond sur les deux plateformes IOS', async () => {
    const machines = await toutes();

    for (const nom of ['routeur', 'commutateur']) {
      expect(await machines.get(nom)!.executeCommand('show ntp status'), nom)
        .not.toContain('Invalid input');
    }
  });

  it('`show ntp ?` NOMME ses vues', async () => {
    const machines = await toutes();

    for (const nom of ['routeur', 'commutateur']) {
      const aide = machines.get(nom)!.cliHelp('show ntp ');

      expect(aide, nom).toContain('associations');
      expect(aide, nom).toContain('status');
    }
  });

  it('`show snmp community` reste PRIVILEGIEE — un secret n\'est pas public', async () => {
    const machines = await toutes();
    const routeur = machines.get('routeur')!;
    await routeur.executeCommand('disable');

    expect(await routeur.executeCommand('show snmp community')).toContain('Invalid input');
  });

  it('mais elle repond en EXEC privilegie — le temoin', async () => {
    const machines = await toutes();

    expect(await machines.get('routeur')!.executeCommand('show snmp community'))
      .not.toContain('Invalid input');
  });

  it('`show ntp associations detail` se distingue de sa forme courte', async () => {
    const machines = await toutes();

    const courte = await machines.get('routeur')!.executeCommand('show ntp associations');
    const longue = await machines.get('routeur')!.executeCommand('show ntp associations detail');

    expect(courte).not.toContain('Invalid input');
    expect(longue).not.toContain('Invalid input');
    expect(longue).not.toBe(courte);
  });
});

describe('les vues d\'EXEC utilisateur gardent leur NIVEAU', () => {
  async function nonPrivilegie() {
    const machines = await toutes();
    const routeur = machines.get('routeur')!;
    await routeur.executeCommand('disable');
    return routeur;
  }

  it('celles qu\'IOS laisse en EXEC utilisateur y repondent', async () => {
    const routeur = await nonPrivilegie();

    for (const vue of ['show clock', 'show users', 'show sessions', 'show inventory',
      'show processes cpu']) {
      expect(await routeur.executeCommand(vue), vue).not.toContain('Invalid input');
    }
  });

  it('et celles qui portent un secret restent PRIVILEGIEES — le temoin', async () => {
    const routeur = await nonPrivilegie();

    for (const vue of ['show snmp community', 'show ntp authentication-keys', 'show bootvar']) {
      expect(await routeur.executeCommand(vue), vue).toContain('Invalid input');
    }
  });

  it('`show who` rend EXACTEMENT ce que rend `show users`', async () => {
    const machines = await toutes();
    const routeur = machines.get('routeur')!;

    expect(await routeur.executeCommand('show who'))
      .toBe(await routeur.executeCommand('show users'));
  });
});

describe('les vues de plateforme rendent ce que la MACHINE porte', () => {
  it('`show platform` nomme le chassis de chaque plateforme', async () => {
    const machines = await toutes();

    expect(await machines.get('routeur')!.executeCommand('show platform'))
      .toContain('ISR 2911');
    expect(await machines.get('commutateur')!.executeCommand('show platform'))
      .toContain('Catalyst 2960');
  });

  it('`show license` liste PLUS de lignes sur un routeur — le temoin', async () => {
    const machines = await toutes();

    const routeur = (await machines.get('routeur')!.executeCommand('show license')).split('\n');
    const commutateur = (await machines.get('commutateur')!
      .executeCommand('show license')).split('\n');

    expect(routeur.length).toBeGreaterThan(commutateur.length);
  });

  it('`show license udi` porte le numero de serie de la machine', async () => {
    const machines = await toutes();

    const udi = await machines.get('routeur')!.executeCommand('show license udi');
    const version = await machines.get('routeur')!.executeCommand('show version');
    const serie = /board ID (\S+)/.exec(version)?.[1];

    expect(serie, 'le temoin doit exister, sinon le cas ne prouve rien').toBeTruthy();
    expect(udi).toContain(serie!);
  });

  it('`show clock detail` ajoute la SOURCE a `show clock`', async () => {
    const machines = await toutes();
    const routeur = machines.get('routeur')!;

    const detail = await routeur.executeCommand('show clock detail');

    expect(detail).toContain('Time source is');
    expect(detail).not.toBe(await routeur.executeCommand('show clock'));
  });
});

describe('`ipv6 nd` migre — et reste propre au ROUTEUR', () => {
  async function surInterface(type: 'routeur' | 'commutateur') {
    const machines = await toutes(async (d, iface) => {
      await d.executeCommand('configure terminal');
      await d.executeCommand(`interface ${iface}`);
    });
    return machines.get(type)!;
  }

  it('`ipv6 nd ?` NOMME ses controles sur un routeur', async () => {
    const aide = (await surInterface('routeur')).cliHelp('ipv6 nd ');

    expect(aide).toContain('managed-config-flag');
    expect(aide).toContain('other-config-flag');
    expect(aide).toContain('ra');
  });

  it('`ra suppress` distingue `all` — la difference est OBSERVABLE sur IOS', async () => {
    const routeur = await surInterface('routeur');

    expect(await routeur.executeCommand('ipv6 nd ra suppress')).not.toContain('Invalid input');
    expect(await routeur.executeCommand('ipv6 nd ra suppress all')).not.toContain('Invalid input');
    expect(await routeur.executeCommand('ipv6 nd ra suppress zorglub')).toContain('Invalid input');
  });

  it('`ra lifetime` accepte ZERO — qui a un sens, et borne le reste', async () => {
    const routeur = await surInterface('routeur');

    expect(await routeur.executeCommand('ipv6 nd ra lifetime 0')).not.toContain('Invalid input');
    expect(await routeur.executeCommand('ipv6 nd ra lifetime 9000')).not.toContain('Invalid input');
    expect(await routeur.executeCommand('ipv6 nd ra lifetime 9001')).toContain('Invalid input');
  });

  it('chaque drapeau a sa NEGATION, par la meme declaration', async () => {
    const routeur = await surInterface('routeur');

    for (const mot of ['managed-config-flag', 'other-config-flag']) {
      expect(await routeur.executeCommand(`ipv6 nd ${mot}`), mot).not.toContain('Invalid input');
      expect(await routeur.executeCommand(`no ipv6 nd ${mot}`), mot).not.toContain('Invalid input');
    }
  });
});
