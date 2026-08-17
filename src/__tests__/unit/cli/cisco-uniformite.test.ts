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
