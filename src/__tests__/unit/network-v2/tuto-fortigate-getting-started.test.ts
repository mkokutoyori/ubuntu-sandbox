/**
 * Tutoriel « FortiGate : Getting Started from Zero » — la partie CLI.
 *
 * Ce fichier est ecrit A L'AVEUGLE depuis le tutoriel, avant toute
 * exploration du code : ce qu'il mesure est ce qu'un lecteur du tutoriel
 * tape, dans l'ordre ou il le tape, et ce que FortiOS lui repond.
 *
 * Trois choses le distinguent d'une liste de commandes :
 *
 * 1. **L'ARBRE de configuration est le sujet.** FortiOS n'applique pas a
 *    la frappe comme IOS : on entre par `config`, on edite par `edit`, on
 *    valide par `end` et on ANNULE par `abort`. Un simulateur qui accepte
 *    les commandes mais applique tout immediatement enseignerait le
 *    contraire de ce que fait la machine.
 *
 * 2. **`show` et `get` ne repondent pas a la meme question** — l'un rend
 *    la configuration ecrite, l'autre l'etat operationnel. Les confondre
 *    est le malentendu le plus courant du debutant FortiOS, et le
 *    tutoriel lui consacre une section.
 *
 * 3. **Le boitier a des interfaces qui ont un ROLE.** `wan1` regarde
 *    Internet, `port1` le reseau interne, la console est le canal
 *    physique qui marche quand le reste est casse. Un pare-feu dont tous
 *    les ports se ressemblent ne peut pas porter la lecon centrale du
 *    tutoriel : une politique se declare d'une interface VERS une autre.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn?(): void;
  executeCommand(command: string): Promise<string>;
  getPrompt?(): string;
  getPortNames?(): string[];
}

async function fortigate(...lignes: string[]): Promise<Cli> {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  fw.powerOn?.();
  for (const ligne of lignes) await fw.executeCommand(ligne);
  return fw;
}

const REFUS = /Unknown action|command parse error|Invalid|Incomplete|not found|Command fail/i;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

/** Le pare-feu du tutoriel, monte jusqu'a la fin de la partie 6. */
async function labo(): Promise<Cli> {
  return fortigate(
    'config system global',
    'set hostname FW-BANQUE-01',
    'end',
    'config system interface',
    'edit wan1',
    'set mode static',
    'set ip 203.0.113.2 255.255.255.248',
    'set allowaccess ping',
    'next',
    'edit port1',
    'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping https ssh',
    'set alias "LAN-INTERNE"',
    'end',
    'config router static',
    'edit 1',
    'set gateway 203.0.113.1',
    'set device wan1',
    'end',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Partie 2 et 5.1 — le boitier a des interfaces, et elles ont un role
// ─────────────────────────────────────────────────────────────────────

describe('Partie 2 — le boitier a les ports que le tutoriel decrit', () => {
  it('un FortiGate neuf porte `wan1` et des ports internes', async () => {
    const fw = await fortigate();
    const noms = (fw.getPortNames?.() ?? []).map(n => n.toLowerCase());

    expect(noms, 'wan1').toContain('wan1');
    expect(noms.some(n => /^port\d+$/.test(n)), `ports internes: ${noms.join(',')}`).toBe(true);
  });

  /*
   * La CONSOLE est le canal du TERMINAL, pas un port de donnees : sur un
   * vrai FortiGate c'est une liaison serie, et `show system interface`
   * ne la liste pas. Ce qu'elle doit garantir est qu'on parle au boitier
   * meme sans reseau — donc AVANT toute adresse, et depuis un chassis
   * dont aucun port n'est cable. La sonde attendait d'abord un port
   * nomme `console` : c'etait une invention, corrigee ici.
   */
  it('la CONSOLE parle au boitier sans qu aucun reseau soit monte', async () => {
    const fw = await fortigate();

    expect(refuse(await fw.executeCommand('get system status'))).toBe(false);
    expect(fw.getPrompt?.() ?? '').toMatch(/#\s*$/);
  });

  it('et elle n est PAS une interface reseau — un cable RJ45 n y passe pas', async () => {
    const fw = await fortigate();
    const noms = (fw.getPortNames?.() ?? []).map(n => n.toLowerCase());

    expect(noms).not.toContain('console');
    expect(await fw.executeCommand('show system interface')).not.toContain('console');
  });

  it('`show system interface` rend la configuration des interfaces', async () => {
    const fw = await fortigate();
    const sortie = await fw.executeCommand('show system interface');

    expect(sortie).toContain('config system interface');
    expect(sortie).toContain('edit "wan1"');
    expect(sortie).toContain('set vdom "root"');
    expect(sortie).toMatch(/end\s*$/);
  });

  it('et chaque interface porte le ROLE que le tutoriel lui donne', async () => {
    const fw = await fortigate();
    const sortie = await fw.executeCommand('show system interface');
    const debut = sortie.indexOf('edit "wan1"');

    expect(sortie.slice(debut, sortie.indexOf('next', debut))).toMatch(/set role wan/);
    expect(sortie).toMatch(/set role lan/);
  });

  it('le port LAN porte l adresse d usine 192.168.1.99/24', async () => {
    const fw = await fortigate();

    expect(await fw.executeCommand('show system interface')).toContain('192.168.1.99');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 5.4 — le VDOM
// ─────────────────────────────────────────────────────────────────────

describe('Partie 5.4 — un FortiGate de base a un seul VDOM, `root`', () => {
  it('`get system status` nomme le VDOM courant', async () => {
    const fw = await fortigate();

    expect(await fw.executeCommand('get system status')).toMatch(/Current virtual domain:\s*root/);
  });

  it('et le mode multi-VDOM est desactive', async () => {
    const fw = await fortigate();

    expect(await fw.executeCommand('get system status'))
      .toMatch(/Virtual domain configuration:\s*disable/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 6.1 — hostname et fuseau horaire
// ─────────────────────────────────────────────────────────────────────

describe('Partie 6.1 — `config system global`', () => {
  it('`config system global` change l invite', async () => {
    const fw = await fortigate('config system global');

    expect(fw.getPrompt?.() ?? '').toMatch(/\(global\)\s*#/);
  });

  it('`set hostname` change le nom, et l invite le montre', async () => {
    const fw = await fortigate('config system global', 'set hostname FW-BANQUE-01', 'end');

    expect(fw.getPrompt?.() ?? '').toContain('FW-BANQUE-01');
  });

  it('`set timezone 15` est accepte', async () => {
    const fw = await fortigate('config system global');

    expect(refuse(await fw.executeCommand('set timezone 15'))).toBe(false);
  });

  it('un parametre inconnu est REFUSE — sinon un reglage se perd en silence', async () => {
    const fw = await fortigate('config system global');

    expect(refuse(await fw.executeCommand('set zorglub 42'))).toBe(true);
  });

  it('`end` ramene a la racine', async () => {
    const fw = await fortigate('config system global', 'end');

    expect(fw.getPrompt?.() ?? '').not.toMatch(/\(global\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 9.1 — `abort` annule ce que `end` valide
// ─────────────────────────────────────────────────────────────────────

describe('Partie 9.1 — `end` valide, `abort` annule', () => {
  it('`abort` sort de la section SANS appliquer', async () => {
    const fw = await fortigate(
      'config system global', 'set hostname NE-DOIT-PAS-RESTER', 'abort');

    expect(fw.getPrompt?.() ?? '').not.toContain('NE-DOIT-PAS-RESTER');
  });

  it('et `end` applique, lui — le temoin', async () => {
    const fw = await fortigate('config system global', 'set hostname DOIT-RESTER', 'end');

    expect(fw.getPrompt?.() ?? '').toContain('DOIT-RESTER');
  });

  it('`abort` sur une interface laisse l adresse d avant', async () => {
    const fw = await fortigate(
      'config system interface', 'edit port1',
      'set ip 10.9.9.9 255.255.255.0', 'abort');

    expect(await fw.executeCommand('show system interface')).not.toContain('10.9.9.9');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 6.2 et 6.3 — les interfaces WAN et LAN
// ─────────────────────────────────────────────────────────────────────

describe('Partie 6.2 — l interface WAN', () => {
  it('`edit wan1` change l invite pour le nom de l interface', async () => {
    const fw = await fortigate('config system interface', 'edit wan1');

    expect(fw.getPrompt?.() ?? '').toMatch(/\(wan1\)\s*#/);
  });

  it('`set mode dhcp` est accepte et rendu', async () => {
    const fw = await fortigate(
      'config system interface', 'edit wan1', 'set mode dhcp', 'end');

    expect(await fw.executeCommand('show system interface')).toMatch(/set mode dhcp/);
  });

  it('`set mode static` + `set ip` posent l adresse publique', async () => {
    const fw = await fortigate(
      'config system interface', 'edit wan1', 'set mode static',
      'set ip 203.0.113.2 255.255.255.248', 'end');

    expect(await fw.executeCommand('show system interface'))
      .toContain('203.0.113.2 255.255.255.248');
  });

  it('`set allowaccess ping` est accepte et rendu', async () => {
    const fw = await fortigate(
      'config system interface', 'edit wan1', 'set allowaccess ping', 'end');
    const sortie = await fw.executeCommand('show system interface');

    const debut = sortie.indexOf('edit "wan1"');
    expect(sortie.slice(debut, sortie.indexOf('next', debut)))
      .toMatch(/set allowaccess .*ping/);
  });

  it('un protocole d acces INVENTE est refuse', async () => {
    const fw = await fortigate('config system interface', 'edit wan1');

    expect(refuse(await fw.executeCommand('set allowaccess zorglub'))).toBe(true);
  });

  it('une interface qui n existe pas ne se cree pas par `edit` sur un port physique',
    async () => {
      const fw = await fortigate('config system interface');
      const sortie = await fw.executeCommand('edit wan99');

      expect(refuse(sortie) || sortie === '', 'wan99').toBe(true);
    });
});

describe('Partie 6.3 — l interface LAN', () => {
  it('`set ip` pose l adresse de passerelle du LAN', async () => {
    const fw = await fortigate(
      'config system interface', 'edit port1',
      'set ip 192.168.1.1 255.255.255.0', 'end');

    expect(await fw.executeCommand('show system interface'))
      .toContain('192.168.1.1 255.255.255.0');
  });

  it('`set allowaccess ping https ssh` prend les TROIS', async () => {
    const fw = await fortigate(
      'config system interface', 'edit port1',
      'set allowaccess ping https ssh', 'end');
    const sortie = await fw.executeCommand('show system interface');
    const bloc = sortie.slice(sortie.indexOf('edit "port1"'));

    for (const acces of ['ping', 'https', 'ssh']) {
      expect(bloc.slice(0, 400), acces).toContain(acces);
    }
  });

  it('`set alias` nomme l interface pour l operateur', async () => {
    const fw = await fortigate(
      'config system interface', 'edit port1', 'set alias "LAN-INTERNE"', 'end');

    expect(await fw.executeCommand('show system interface')).toContain('LAN-INTERNE');
  });

  it('une adresse malformee est refusee', async () => {
    const fw = await fortigate('config system interface', 'edit port1');

    expect(refuse(await fw.executeCommand('set ip 999.1.1.1 255.255.255.0'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 6.2 — la route par defaut
// ─────────────────────────────────────────────────────────────────────

describe('Partie 6.2 — `config router static`', () => {
  it('une route par defaut se declare par sa passerelle et son interface', async () => {
    const fw = await fortigate(
      'config router static', 'edit 1',
      'set gateway 203.0.113.1', 'set device wan1', 'end');
    const sortie = await fw.executeCommand('show router static');

    expect(sortie).toContain('config router static');
    expect(sortie).toContain('set gateway 203.0.113.1');
    expect(sortie).toContain('set device "wan1"');
  });

  it('et elle apparait dans la table de routage', async () => {
    const fw = await labo();

    expect(await fw.executeCommand('get router info routing-table all'))
      .toMatch(/0\.0\.0\.0\/0.*203\.0\.113\.1/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 6.4 — le serveur DHCP
// ─────────────────────────────────────────────────────────────────────

describe('Partie 6.4 — `config system dhcp server`', () => {
  async function avecDhcp(): Promise<Cli> {
    return fortigate(
      'config system interface', 'edit port1',
      'set ip 192.168.1.1 255.255.255.0', 'end',
      'config system dhcp server',
      'edit 1',
      'set interface port1',
      'set dns-service default',
      'config ip-range',
      'edit 1',
      'set start-ip 192.168.1.100',
      'set end-ip 192.168.1.200',
      'next',
      'end',
      'set netmask 255.255.255.0',
      'set default-gateway 192.168.1.1',
      'end',
    );
  }

  it('la plage imbriquee `config ip-range` est acceptee', async () => {
    const fw = await avecDhcp();
    const sortie = await fw.executeCommand('show system dhcp server');

    expect(sortie).toContain('config system dhcp server');
    expect(sortie).toContain('192.168.1.100');
    expect(sortie).toContain('192.168.1.200');
  });

  it('le serveur porte son interface, son masque et sa passerelle', async () => {
    const fw = await avecDhcp();
    const sortie = await fw.executeCommand('show system dhcp server');

    expect(sortie).toMatch(/set interface "?port1"?/);
    expect(sortie).toContain('255.255.255.0');
    expect(sortie).toContain('192.168.1.1');
  });

  it('un sous-mode imbrique rend l invite du niveau ou l on est', async () => {
    const fw = await fortigate(
      'config system dhcp server', 'edit 1', 'config ip-range', 'edit 1');

    expect(fw.getPrompt?.() ?? '').toMatch(/\(1\)\s*#/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 6.5 — le DNS
// ─────────────────────────────────────────────────────────────────────

describe('Partie 6.5 — `config system dns`', () => {
  it('les deux serveurs sont poses et rendus', async () => {
    const fw = await fortigate(
      'config system dns', 'set primary 8.8.8.8', 'set secondary 8.8.4.4', 'end');
    const sortie = await fw.executeCommand('show system dns');

    expect(sortie).toContain('set primary 8.8.8.8');
    expect(sortie).toContain('set secondary 8.8.4.4');
  });

  it('une adresse DNS malformee est refusee', async () => {
    const fw = await fortigate('config system dns');

    expect(refuse(await fw.executeCommand('set primary zorglub'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 7 — la politique de pare-feu
// ─────────────────────────────────────────────────────────────────────

describe('Partie 7 — `config firewall policy`', () => {
  async function avecPolitique(): Promise<Cli> {
    const fw = await labo();
    for (const ligne of [
      'config firewall policy',
      'edit 1',
      'set name "LAN-vers-Internet"',
      'set srcintf "port1"',
      'set dstintf "wan1"',
      'set srcaddr "all"',
      'set dstaddr "all"',
      'set action accept',
      'set schedule "always"',
      'set service "ALL"',
      'set nat enable',
      'set logtraffic all',
      'end',
    ]) await fw.executeCommand(ligne);
    return fw;
  }

  it('la politique du tutoriel est acceptee de bout en bout', async () => {
    const fw = await labo();
    await fw.executeCommand('config firewall policy');
    await fw.executeCommand('edit 1');

    for (const ligne of [
      'set name "LAN-vers-Internet"', 'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set action accept',
      'set schedule "always"', 'set service "ALL"', 'set nat enable',
      'set logtraffic all',
    ]) {
      expect(refuse(await fw.executeCommand(ligne)), ligne).toBe(false);
    }
  });

  it('`show firewall policy` la rend telle qu elle a ete ecrite', async () => {
    const fw = await avecPolitique();
    const sortie = await fw.executeCommand('show firewall policy');

    expect(sortie).toContain('config firewall policy');
    expect(sortie).toContain('edit 1');
    expect(sortie).toContain('set name "LAN-vers-Internet"');
    expect(sortie).toContain('set srcintf "port1"');
    expect(sortie).toContain('set dstintf "wan1"');
    expect(sortie).toContain('set action accept');
    expect(sortie).toContain('set nat enable');
    expect(sortie).toContain('next');
  });

  it('une ACTION inventee est refusee', async () => {
    const fw = await fortigate('config firewall policy', 'edit 1');

    expect(refuse(await fw.executeCommand('set action zorglub'))).toBe(true);
  });

  it('une interface source qui n existe pas est refusee', async () => {
    const fw = await fortigate('config firewall policy', 'edit 1');

    expect(refuse(await fw.executeCommand('set srcintf "zorglub"'))).toBe(true);
  });

  it('l invite porte le NUMERO de la politique editee', async () => {
    const fw = await fortigate('config firewall policy', 'edit 1');

    expect(fw.getPrompt?.() ?? '').toMatch(/\(1\)\s*#/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 8 — les verifications
// ─────────────────────────────────────────────────────────────────────

describe('Partie 8.1 — `get system status`', () => {
  it('rend les champs que le tutoriel montre', async () => {
    const fw = await labo();
    const sortie = await fw.executeCommand('get system status');

    for (const champ of ['Version', 'Hostname', 'Operation Mode', 'Serial-Number']) {
      expect(sortie, champ).toContain(champ);
    }
  });

  it('le nom rendu est celui qui a ete pose', async () => {
    const fw = await labo();

    expect(await fw.executeCommand('get system status')).toContain('FW-BANQUE-01');
  });

  it('le mode d operation est NAT', async () => {
    const fw = await fortigate();

    expect(await fw.executeCommand('get system status')).toMatch(/Operation Mode:\s*NAT/);
  });
});

describe('Partie 8.2 — `get system interface physical`', () => {
  it('rend le nom, l adresse et l etat de chaque interface', async () => {
    const fw = await labo();
    const sortie = await fw.executeCommand('get system interface physical');

    expect(sortie).toContain('wan1');
    expect(sortie).toContain('port1');
    expect(sortie).toMatch(/ip:\s*192\.168\.1\.1/);
    expect(sortie).toMatch(/status:\s*(up|down)/);
  });

  it('`get` decrit l ETAT la ou `show` decrit la configuration', async () => {
    const fw = await labo();
    const etat = await fw.executeCommand('get system interface physical');
    const config = await fw.executeCommand('show system interface');

    expect(etat).not.toContain('config system interface');
    expect(config).toContain('config system interface');
  });
});

describe('Partie 8.3 — `get router info routing-table all`', () => {
  it('rend la legende et les routes connectees', async () => {
    const fw = await labo();
    const sortie = await fw.executeCommand('get router info routing-table all');

    expect(sortie).toMatch(/Codes:/);
    expect(sortie).toMatch(/192\.168\.1\.0\/24 is directly connected, port1/);
  });
});

describe('Partie 8.5 et 8.6 — sessions et journaux', () => {
  it('`diagnose sys session list` repond', async () => {
    const fw = await labo();

    expect(refuse(await fw.executeCommand('diagnose sys session list'))).toBe(false);
  });

  it('`execute log filter category 1` puis `execute log display` repondent', async () => {
    const fw = await labo();

    expect(refuse(await fw.executeCommand('execute log filter category 1'))).toBe(false);
    expect(refuse(await fw.executeCommand('execute log display'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 7.2 — le ping depuis le pare-feu
// ─────────────────────────────────────────────────────────────────────

describe('Partie 7.2 — `execute ping`', () => {
  it('`execute ping` rend une statistique, pas une erreur de syntaxe', async () => {
    const fw = await labo();
    const sortie = await fw.executeCommand('execute ping 203.0.113.1');

    expect(sortie).toMatch(/PING|packet loss|bytes from/i);
  });

  it('`execute ping` sans cible est refuse', async () => {
    const fw = await labo();

    expect(refuse(await fw.executeCommand('execute ping'))).toBe(true);
  });

  it('`execute traceroute` existe', async () => {
    const fw = await labo();

    expect(refuse(await fw.executeCommand('execute traceroute 203.0.113.1'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 10 — sauvegarde, restauration, remise a zero
// ─────────────────────────────────────────────────────────────────────

describe('Partie 10 — la configuration se sauvegarde et se relit', () => {
  it('`show full-configuration` rend la configuration ENTIERE', async () => {
    const fw = await labo();
    const sortie = await fw.executeCommand('show full-configuration');

    expect(sortie).toContain('config system global');
    expect(sortie).toContain('config system interface');
    expect(sortie).toContain('FW-BANQUE-01');
  });

  it('`show` seul rend la meme configuration', async () => {
    const fw = await labo();

    expect(await fw.executeCommand('show')).toContain('config system');
  });

  it('`execute backup config tftp` TENTE un vrai transfert', async () => {
    const fw = await labo();
    const sortie = await fw.executeCommand(
      'execute backup config tftp fw.conf 192.168.1.100');

    expect(sortie).toMatch(/192\.168\.1\.100/);
    expect(sortie).toMatch(/Timed out|did not take/i);
  });

  it('`execute factoryreset` DEMANDE confirmation avant d effacer', async () => {
    const fw = await labo() as unknown as {
      getShell(): { interactionPlanFor(line: string): {
        steps: readonly { kind: string; prompt?: string; lines?: readonly string[] }[];
      } | null };
    };
    const plan = fw.getShell().interactionPlanFor('execute factoryreset');

    expect(plan).not.toBeNull();
    const texte = JSON.stringify(plan);
    expect(texte).toMatch(/factory default/i);
    expect(texte).toMatch(/continue\?/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 11 — le firmware
// ─────────────────────────────────────────────────────────────────────

describe('Partie 11 — la version du firmware', () => {
  it('`get system status` annonce une version FortiOS', async () => {
    const fw = await fortigate();

    expect(await fw.executeCommand('get system status')).toMatch(/v7\.\d+/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Partie 9 — ce que la CLI refuse
// ─────────────────────────────────────────────────────────────────────

describe('Partie 9 — la CLI refuse ce qui n existe pas', () => {
  it('une section inventee est refusee', async () => {
    const fw = await fortigate();

    expect(refuse(await fw.executeCommand('config zorglub machin'))).toBe(true);
  });

  it('une commande inventee a la racine est refusee', async () => {
    const fw = await fortigate();

    expect(refuse(await fw.executeCommand('zorglub'))).toBe(true);
  });

  it('`set` hors d une section est refuse', async () => {
    const fw = await fortigate();

    expect(refuse(await fw.executeCommand('set hostname X'))).toBe(true);
  });

  it('`get system status` est lisible depuis la racine', async () => {
    const fw = await fortigate();

    expect(refuse(await fw.executeCommand('get system status'))).toBe(false);
  });
});
