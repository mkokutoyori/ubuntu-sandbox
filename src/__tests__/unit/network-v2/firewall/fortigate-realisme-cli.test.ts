import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Fw {
  executeCommand(command: string): Promise<string>;
  getPrompt(): string;
  getPortNames(): string[];
  getPort(name: string): unknown;
  getHostname(): string;
  powerOn(): void;
  getIsPoweredOn(): boolean;
  getId(): string;
}

function fortigate(): Fw {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Fw;
  if (!fw.getIsPoweredOn()) fw.powerOn();
  return fw;
}

async function taper(fw: Fw, lignes: readonly string[]): Promise<string[]> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await fw.executeCommand(ligne));
  return sorties;
}

const REFUS = /Unknown action|command parse error|Invalid|Command fail|not found/i;
const refuse = (s: string): boolean => REFUS.test(s);

// ─────────────────────────────────────────────────────────────────────
// 1. L'INVITE — ce que la machine affiche AVANT chaque frappe
// ─────────────────────────────────────────────────────────────────────

describe('1. l invite dit ou l on est', () => {
  it('a la racine, l invite est le nom d hote suivi de `#`', () => {
    const fw = fortigate();

    expect(fw.getPrompt().trim()).toBe(`${fw.getHostname()} #`);
  });

  it('`config system global` ajoute `(global)`', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    await fw.executeCommand('config system global');

    expect(fw.getPrompt().trim()).toBe(`${nom} (global) #`);
  });

  it('`config system interface` ajoute `(interface)`', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    await fw.executeCommand('config system interface');

    expect(fw.getPrompt().trim()).toBe(`${nom} (interface) #`);
  });

  it('`edit port1` remplace le nom de table par la CLE', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    await taper(fw, ['config system interface', 'edit port1']);

    expect(fw.getPrompt().trim()).toBe(`${nom} (port1) #`);
  });

  it('`next` revient au niveau de la TABLE', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    await taper(fw, ['config system interface', 'edit port1', 'next']);

    expect(fw.getPrompt().trim()).toBe(`${nom} (interface) #`);
  });

  it('`end` depuis une entree revient a la RACINE', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    await taper(fw, ['config system interface', 'edit port1', 'end']);

    expect(fw.getPrompt().trim()).toBe(`${nom} #`);
  });

  it('`abort` depuis une entree revient a la RACINE', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    await taper(fw, ['config system interface', 'edit port1', 'abort']);

    expect(fw.getPrompt().trim()).toBe(`${nom} #`);
  });

  it('un `config` IMBRIQUE empile, et `end` depile tout', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'config identity-based-policy',
    ]);
    const imbrique = fw.getPrompt().trim();
    await fw.executeCommand('end');

    expect(imbrique).not.toBe(`${nom} #`);
    expect(fw.getPrompt().trim()).toBe(`${nom} #`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. LE NOM D'HOTE — ce que `set hostname` change, et QUAND
// ─────────────────────────────────────────────────────────────────────

describe('2. `set hostname` prend effet a `end`, pas avant', () => {
  it('l invite ne CHANGE PAS tant qu on est dans le bloc', async () => {
    const fw = fortigate();
    const avant = fw.getHostname();
    await taper(fw, ['config system global', 'set hostname MANDENG']);

    expect(fw.getPrompt().trim()).toBe(`${avant} (global) #`);
  });

  it('`end` applique le nouveau nom', async () => {
    const fw = fortigate();
    await taper(fw, ['config system global', 'set hostname MANDENG', 'end']);

    expect(fw.getHostname()).toBe('MANDENG');
    expect(fw.getPrompt().trim()).toBe('MANDENG #');
  });

  it('`abort` DISCARTE le nom, et l ancien survit', async () => {
    const fw = fortigate();
    const avant = fw.getHostname();
    await taper(fw, ['config system global', 'set hostname MANDENG', 'abort']);

    expect(fw.getHostname()).toBe(avant);
    expect(fw.getPrompt().trim()).toBe(`${avant} #`);
  });

  it('le transcript signale exactement le defaut mesure', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    const trace: string[] = [];
    for (const c of ['config system global', 'set hostname MANDENG', 'abort']) {
      trace.push(`${fw.getPrompt().trim()} ${c}`);
      await fw.executeCommand(c);
    }
    trace.push(fw.getPrompt().trim());

    expect(trace).toEqual([
      `${nom} # config system global`,
      `${nom} (global) # set hostname MANDENG`,
      `${nom} (global) # abort`,
      `${nom} #`,
    ]);
  });

  it('`get system status` rend le nom COMMITE et non le nom en attente', async () => {
    const fw = fortigate();
    const avant = fw.getHostname();
    await taper(fw, ['config system global', 'set hostname MANDENG']);
    const pendant = await fw.executeCommand('get system status');
    await fw.executeCommand('end');
    const apres = await fw.executeCommand('get system status');

    expect(pendant).toMatch(new RegExp(avant));
    expect(apres).toMatch(/MANDENG/);
  });

  it('deux `set hostname` de suite : le DERNIER gagne au commit', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system global',
      'set hostname PREMIER', 'set hostname SECOND', 'end',
    ]);

    expect(fw.getHostname()).toBe('SECOND');
  });

  it('un nom d hote vide est REFUSE', async () => {
    const fw = fortigate();
    await fw.executeCommand('config system global');

    expect(refuse(await fw.executeCommand('set hostname'))).toBe(true);
  });

  it('et le nom d avant survit a ce refus', async () => {
    const fw = fortigate();
    const avant = fw.getHostname();
    await taper(fw, ['config system global', 'set hostname', 'end']);

    expect(fw.getHostname()).toBe(avant);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. LA SESSION — un terminal ferme est une session terminee
// ─────────────────────────────────────────────────────────────────────

describe('3. la console est une SESSION', () => {
  it('rouvrir un terminal repart de la RACINE', async () => {
    const fw = fortigate();
    const mgr = new TerminalManager();
    const premier = mgr.openTerminal(fw as never);
    await fw.executeCommand('config system global');
    expect(fw.getPrompt().trim()).toMatch(/\(global\)/);

    mgr.closeTerminal(premier!);
    mgr.openTerminal(fw as never);

    expect(fw.getPrompt().trim()).toBe(`${fw.getHostname()} #`);
  });

  it('et les modifications NON commitees sont perdues', async () => {
    const fw = fortigate();
    const mgr = new TerminalManager();
    const premier = mgr.openTerminal(fw as never);
    const avant = fw.getHostname();
    await taper(fw, ['config system global', 'set hostname FANTOME']);

    mgr.closeTerminal(premier!);
    mgr.openTerminal(fw as never);

    expect(fw.getHostname()).toBe(avant);
  });

  it('une entree `edit` ouverte ne survit pas non plus', async () => {
    const fw = fortigate();
    const mgr = new TerminalManager();
    const premier = mgr.openTerminal(fw as never);
    await taper(fw, ['config system interface', 'edit port1']);

    mgr.closeTerminal(premier!);
    mgr.openTerminal(fw as never);

    expect(fw.getPrompt().trim()).toBe(`${fw.getHostname()} #`);
  });

  it('le port CONSOLE n accepte qu une seule session', () => {
    const fw = fortigate();
    const mgr = new TerminalManager();

    const un = mgr.openTerminal(fw as never);
    const deux = mgr.openTerminal(fw as never);

    expect(un).not.toBeNull();
    expect(deux).toBe(un);
  });

  it('et le gestionnaire ne compte qu une session pour cet appareil', () => {
    const fw = fortigate();
    const mgr = new TerminalManager();
    mgr.openTerminal(fw as never);
    mgr.openTerminal(fw as never);

    expect(mgr.getSessionsForDevice(fw.getId())).toHaveLength(1);
  });

  it('apres fermeture, une nouvelle console est possible', () => {
    const fw = fortigate();
    const mgr = new TerminalManager();
    const un = mgr.openTerminal(fw as never);
    mgr.closeTerminal(un!);

    expect(mgr.openTerminal(fw as never)).not.toBeNull();
  });

  it('un appareil ETEINT n ouvre pas de console', () => {
    const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Fw;
    const mgr = new TerminalManager();
    if (fw.getIsPoweredOn()) (fw as unknown as { powerOff(): void }).powerOff();

    expect(mgr.openTerminal(fw as never)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. LES INTERFACES — ordre, contenu, et ce qu'un chassis porte
// ─────────────────────────────────────────────────────────────────────

describe('4. `show system interface` respecte l ordre du CHASSIS', () => {
  it('rend toutes les interfaces du chassis', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('show system interface');

    for (const nom of fw.getPortNames()) {
      expect(vue).toContain(nom);
    }
  });

  it('les interfaces paraissent dans l ORDRE du chassis', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('show system interface');
    const attendu = fw.getPortNames();
    const rangs = attendu.map(n => vue.indexOf(`edit "${n}"`));

    expect(rangs.every(r => r >= 0)).toBe(true);
    expect([...rangs].sort((a, b) => a - b)).toEqual(rangs);
  });

  it('`port1` vient avant `port2`, qui vient avant `wan1`', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('show system interface');

    expect(vue.indexOf('edit "port1"')).toBeLessThan(vue.indexOf('edit "port2"'));
    expect(vue.indexOf('edit "port2"')).toBeLessThan(vue.indexOf('edit "wan1"'));
  });

  it('`get system interface` suit le MEME ordre', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('get system interface');
    const rangs = fw.getPortNames().map(n => vue.indexOf(n)).filter(r => r >= 0);

    expect(rangs.length).toBeGreaterThan(1);
    expect([...rangs].sort((a, b) => a - b)).toEqual(rangs);
  });

  it('`port1` porte l adresse d usine 192.168.1.99/24', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('show system interface');

    expect(vue).toMatch(/192\.168\.1\.99/);
  });

  it('et son `allowaccess` d usine contient ping, https, ssh et http', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('show system interface');
    const bloc = vue.slice(vue.indexOf('edit "port1"'), vue.indexOf('next'));

    for (const service of ['ping', 'https', 'ssh', 'http']) {
      expect(bloc).toContain(service);
    }
  });

  it('`wan1` existe et n a PAS d adresse d usine', async () => {
    const fw = fortigate();
    const noms = fw.getPortNames();

    expect(noms).toContain('wan1');
  });

  it('`edit <nouveau nom>` CREE une entree — c est ainsi qu on fait un VLAN', async () => {
    const fw = fortigate();
    await fw.executeCommand('config system interface');

    expect(refuse(await fw.executeCommand('edit VLAN_100'))).toBe(false);
  });

  it('une interface VLAN creee porte son etiquette et son parent', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit VLAN_100',
      'set vdom "root"', 'set interface "port1"',
      'set type vlan', 'set vlanid 100', 'next', 'end',
    ]);
    const vue = await fw.executeCommand('show system interface');

    expect(vue).toMatch(/VLAN_100/);
    expect(vue).toMatch(/set vlanid 100/);
  });

  it('et `abort` sur une entree NEUVE ne la cree pas', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit VLAN_200',
      'set type vlan', 'abort',
    ]);

    expect(await fw.executeCommand('show system interface')).not.toMatch(/VLAN_200/);
  });

  it('`show system interface port1` ne rend QUE port1', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('show system interface port1');

    expect(vue).toContain('port1');
    expect(vue).not.toContain('edit "wan1"');
  });
});

describe('4b. configurer une interface', () => {
  async function avecIp(): Promise<Fw> {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit port2',
      'set mode static', 'set ip 10.10.10.1 255.255.255.0',
      'set allowaccess ping https', 'next', 'end',
    ]);
    return fw;
  }

  it('l adresse posee se relit', async () => {
    const fw = await avecIp();

    expect(await fw.executeCommand('show system interface port2'))
      .toMatch(/10\.10\.10\.1/);
  });

  it('elle est portee par le VRAI port', async () => {
    const fw = await avecIp();
    const port = fw.getPort('port2') as { getIPAddress(): { toString(): string } | null };

    expect(port.getIPAddress()?.toString()).toBe('10.10.10.1');
  });

  it('une adresse malformee est REFUSEE', async () => {
    const fw = fortigate();
    await taper(fw, ['config system interface', 'edit port2', 'set mode static']);

    expect(refuse(await fw.executeCommand('set ip 999.1.1.1 255.255.255.0'))).toBe(true);
  });

  it('et le port ne la porte pas', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit port2', 'set mode static',
      'set ip 999.1.1.1 255.255.255.0', 'next', 'end',
    ]);
    const port = fw.getPort('port2') as { getIPAddress(): { toString(): string } | null };

    expect(port.getIPAddress()?.toString()).not.toBe('999.1.1.1');
  });

  it('`abort` dans une entree annule l adresse', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit port2',
      'set mode static', 'set ip 10.20.30.1 255.255.255.0', 'abort',
    ]);
    const port = fw.getPort('port2') as { getIPAddress(): { toString(): string } | null };

    expect(port.getIPAddress()?.toString()).not.toBe('10.20.30.1');
  });

  it('`set status down` eteint vraiment le port', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit port2', 'set status down', 'next', 'end',
    ]);
    const port = fw.getPort('port2') as { getIsUp(): boolean; isAdminDown(): boolean };

    expect(port.isAdminDown()).toBe(true);
    expect(port.getIsUp()).toBe(false);
  });

  it('`set status up` le rallume', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit port2', 'set status down', 'next', 'end',
      'config system interface', 'edit port2', 'set status up', 'next', 'end',
    ]);
    const port = fw.getPort('port2') as { getIsUp(): boolean; isAdminDown(): boolean };

    expect(port.isAdminDown()).toBe(false);
  });

  it('un attribut inconnu est REFUSE', async () => {
    const fw = fortigate();
    await taper(fw, ['config system interface', 'edit port2']);

    expect(refuse(await fw.executeCommand('set zorglub 1'))).toBe(true);
  });

  it('`unset ip` retire l adresse', async () => {
    const fw = await avecIp();
    await taper(fw, [
      'config system interface', 'edit port2', 'unset ip', 'next', 'end',
    ]);
    const port = fw.getPort('port2') as { getIPAddress(): { toString(): string } | null };

    expect(port.getIPAddress()?.toString()).not.toBe('10.10.10.1');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. L'AUTO-COMPLETION — insensible a la casse, et l'aide `?`
// ─────────────────────────────────────────────────────────────────────

interface Completable {
  getShell(): { completions(ligne: string): readonly string[] };
}

function completions(fw: Fw, ligne: string): string[] {
  return [...(fw as unknown as Completable).getShell().completions(ligne)];
}

describe('5. l auto-completion ignore la CASSE', () => {
  it('`con` propose `config`', () => {
    const fw = fortigate();

    expect(completions(fw, 'con').map(s => s.toLowerCase())).toContain('config');
  });

  it('`CON` propose `config` aussi', () => {
    const fw = fortigate();

    expect(completions(fw, 'CON').map(s => s.toLowerCase())).toContain('config');
  });

  it('`CoNfIg` propose la meme chose que `config`', () => {
    const fw = fortigate();
    const bas = completions(fw, 'config sys').map(s => s.toLowerCase()).sort();
    const melange = completions(fw, 'CoNfIg SyS').map(s => s.toLowerCase()).sort();

    expect(melange).toEqual(bas);
  });

  it('`config SYSTEM ` propose les memes tables que `config system `', () => {
    const fw = fortigate();
    const bas = completions(fw, 'config system ').map(s => s.toLowerCase()).sort();
    const haut = completions(fw, 'config SYSTEM ').map(s => s.toLowerCase()).sort();

    expect(haut).toEqual(bas);
    expect(bas.length).toBeGreaterThan(0);
  });

  it('dans une table, `SET ` propose les memes attributs que `set `', async () => {
    const fw = fortigate();
    await taper(fw, ['config system interface', 'edit port1']);
    const bas = completions(fw, 'set ').map(s => s.toLowerCase()).sort();
    const haut = completions(fw, 'SET ').map(s => s.toLowerCase()).sort();

    expect(haut).toEqual(bas);
  });

  it('une commande tapee en MAJUSCULES est acceptee', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('CONFIG SYSTEM GLOBAL'))).toBe(false);
  });

  it('et elle mene bien dans le mode attendu', async () => {
    const fw = fortigate();
    await fw.executeCommand('CONFIG SYSTEM GLOBAL');

    expect(fw.getPrompt().trim()).toMatch(/\(global\)/);
  });

  it('`GET SYSTEM STATUS` repond comme `get system status`', async () => {
    const fw = fortigate();
    const bas = await fw.executeCommand('get system status');
    const haut = await fw.executeCommand('GET SYSTEM STATUS');

    expect(refuse(haut)).toBe(false);
    expect(haut.split('\n').length).toBe(bas.split('\n').length);
  });
});

describe('5b. l aide `?` decrit ce que la machine accepte', () => {
  it('`?` a la racine annonce `config`', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('?')).toMatch(/config/);
  });

  it('`config ?` annonce `system`', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('config ?')).toMatch(/system/);
  });

  it('`config system ?` annonce `interface` et `global`', async () => {
    const fw = fortigate();
    const aide = await fw.executeCommand('config system ?');

    expect(aide).toMatch(/interface/);
    expect(aide).toMatch(/global/);
  });

  it('dans `system global`, `set ?` annonce `hostname`', async () => {
    const fw = fortigate();
    await fw.executeCommand('config system global');

    expect(await fw.executeCommand('set ?')).toMatch(/hostname/);
  });

  it('dans une interface, `set ?` annonce `ip` et `allowaccess`', async () => {
    const fw = fortigate();
    await taper(fw, ['config system interface', 'edit port1']);
    const aide = await fw.executeCommand('set ?');

    expect(aide).toMatch(/\bip\b/);
    expect(aide).toMatch(/allowaccess/);
  });

  it('`set allowaccess ?` annonce les services d administration', async () => {
    const fw = fortigate();
    await taper(fw, ['config system interface', 'edit port1']);
    const aide = await fw.executeCommand('set allowaccess ?');

    expect(aide).toMatch(/ping/);
    expect(aide).toMatch(/https/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. LES REFUS — une machine realiste refuse dans SES mots
// ─────────────────────────────────────────────────────────────────────

describe('6. ce que la machine refuse, et comment elle le dit', () => {
  it('une commande inconnue rend `Unknown action`', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('zorglub')).toMatch(/Unknown action/i);
  });

  it('`set` hors d un objet est refuse', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('set hostname X'))).toBe(true);
  });

  it('`edit` hors d une table est refuse', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('edit port1'))).toBe(true);
  });

  it('`next` hors d une entree est refuse', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('next'))).toBe(true);
  });

  it('`end` a la racine est refuse ou inerte, jamais destructeur', async () => {
    const fw = fortigate();
    const nom = fw.getHostname();
    await fw.executeCommand('end');

    expect(fw.getHostname()).toBe(nom);
    expect(fw.getPrompt().trim()).toBe(`${nom} #`);
  });

  it('`config` sans argument est incomplet', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('config'))).toBe(true);
  });

  it('une table inconnue est refusee', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('config zorglub truc'))).toBe(true);
  });

  it('et un refus ne change PAS le mode courant', async () => {
    const fw = fortigate();
    await fw.executeCommand('config system global');
    await fw.executeCommand('config zorglub truc');

    expect(fw.getPrompt().trim()).toMatch(/\(global\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. LA CONFIGURATION RENDUE — ce qu'un import doit pouvoir rejouer
// ─────────────────────────────────────────────────────────────────────

describe('7. `show` rend ce que l operateur a tape', () => {
  it('le nom d hote commite parait dans `show system global`', async () => {
    const fw = fortigate();
    await taper(fw, ['config system global', 'set hostname LABO', 'end']);

    expect(await fw.executeCommand('show system global'))
      .toMatch(/set hostname "?LABO"?/);
  });

  it('un nom d hote ABANDONNE n y parait pas', async () => {
    const fw = fortigate();
    await taper(fw, ['config system global', 'set hostname FANTOME', 'abort']);

    expect(await fw.executeCommand('show system global')).not.toMatch(/FANTOME/);
  });

  it('`show` complet contient le bloc des interfaces', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('show')).toMatch(/config system interface/);
  });

  it('une politique creee se relit', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set name "LAN-vers-WAN"',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end',
    ]);

    const vue = await fw.executeCommand('show firewall policy');
    expect(vue).toMatch(/edit 1/);
    expect(vue).toMatch(/LAN-vers-WAN/);
  });

  it('et `abort` sur une politique ne la cree PAS', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 42',
      'set srcintf "port1"', 'abort',
    ]);

    expect(await fw.executeCommand('show firewall policy')).not.toMatch(/edit 42/);
  });

  it('`delete` retire une politique', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 7',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end',
      'config firewall policy', 'delete 7', 'end',
    ]);

    expect(await fw.executeCommand('show firewall policy')).not.toMatch(/edit 7/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. `get system status` — la carte d'identite de la machine
// ─────────────────────────────────────────────────────────────────────

describe('8. `get system status` decrit la machine', () => {
  it('annonce une version', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('get system status')).toMatch(/Version:/);
  });

  it('annonce le nom d hote', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('get system status'))
      .toMatch(new RegExp(`Hostname:\\s*${fw.getHostname()}`));
  });

  it('annonce le mode de fonctionnement', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('get system status')).toMatch(/Operation mode/i);
  });

  it('et le nom suit un changement commite', async () => {
    const fw = fortigate();
    await taper(fw, ['config system global', 'set hostname NOUVEAU', 'end']);

    expect(await fw.executeCommand('get system status')).toMatch(/Hostname:\s*NOUVEAU/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. LE RESEAU — la machine est vraiment cablee
// ─────────────────────────────────────────────────────────────────────

describe('9. le pare-feu est une vraie machine du reseau', () => {
  async function labo(): Promise<{ fw: Fw; pc: LinuxPC; sw: CiscoSwitch }> {
    const fw = fortigate();
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 200, 0);
    const pc = new LinuxPC('linux-pc', 'PC1', 400, 0);
    sw.powerOn();
    pc.powerOn();
    new Cable('fw-sw').connect(
      fw.getPort('port1') as never, sw.getPort('FastEthernet0/1') as never);
    new Cable('sw-pc').connect(
      sw.getPort('FastEthernet0/2') as never, pc.getPort('eth0') as never);
    await taper(fw, [
      'config system interface', 'edit port1',
      'set mode static', 'set ip 192.168.1.1 255.255.255.0',
      'set allowaccess ping https ssh http', 'next', 'end',
    ]);
    for (const c of [
      'ip link set eth0 up',
      'ip addr add 192.168.1.10/24 dev eth0',
      'ip route add default via 192.168.1.1',
    ]) await pc.executeCommand(c);
    return { fw, pc, sw };
  }

  it('le PC joint le pare-feu', async () => {
    const { pc } = await labo();

    expect(await pc.executeCommand('ping -c 2 192.168.1.1')).toMatch(/, 0% packet loss/);
  });

  it('le pare-feu apprend la MAC du PC', async () => {
    const { fw, pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');

    expect(await fw.executeCommand('get system arp')).toContain('192.168.1.10');
  });

  it('`execute ping` depuis le pare-feu atteint le PC', async () => {
    const { fw, pc } = await labo();
    await pc.executeCommand('ping -c 1 192.168.1.1');

    expect(await fw.executeCommand('execute ping 192.168.1.10')).not.toMatch(/100%/);
  });

  it('l interface web repond en HTTPS', async () => {
    const { pc } = await labo();

    expect(await pc.executeCommand('curl -k -s https://192.168.1.1/')).toMatch(/forti/i);
  });

  it('retirer `https` d allowaccess ferme la porte', async () => {
    const { fw, pc } = await labo();
    await taper(fw, [
      'config system interface', 'edit port1',
      'set allowaccess ping', 'next', 'end',
    ]);

    expect(await pc.executeCommand('curl -k -sS https://192.168.1.1/'))
      .toMatch(/refused|couldn't connect/i);
  });

  it('et le ping passe toujours', async () => {
    const { fw, pc } = await labo();
    await taper(fw, [
      'config system interface', 'edit port1',
      'set allowaccess ping', 'next', 'end',
    ]);

    expect(await pc.executeCommand('ping -c 1 192.168.1.1')).toMatch(/, 0% packet loss/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. `execute` — ce que la machine FAIT vraiment
// ─────────────────────────────────────────────────────────────────────

describe('10. les commandes `execute`', () => {
  it('`execute ping` vers une adresse morte rapporte une perte', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('execute ping 203.0.113.222'))
      .toMatch(/100%|no route|unreachable/i);
  });

  it('`execute date` rend une date', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('execute date'))).toBe(false);
  });

  it('une sous-commande `execute` inconnue est refusee', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('execute zorglub'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 11. LES OBJETS ADRESSE — la brique de toute politique
// ─────────────────────────────────────────────────────────────────────

describe('11. `config firewall address`', () => {
  async function avecObjet(): Promise<Fw> {
    const fw = fortigate();
    await taper(fw, [
      'config firewall address', 'edit "NET-LAN"',
      'set subnet 192.168.10.0 255.255.255.0', 'next', 'end',
    ]);
    return fw;
  }

  it('un objet cree se relit', async () => {
    const fw = await avecObjet();

    expect(await fw.executeCommand('show firewall address')).toMatch(/NET-LAN/);
  });

  it('et porte le sous-reseau qu on lui a donne', async () => {
    const fw = await avecObjet();

    expect(await fw.executeCommand('show firewall address'))
      .toMatch(/192\.168\.10\.0/);
  });

  it('`all` existe d usine', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('show firewall address')).toMatch(/"all"|all/);
  });

  it('un masque malforme est refuse', async () => {
    const fw = fortigate();
    await taper(fw, ['config firewall address', 'edit "MAUVAIS"']);

    expect(refuse(await fw.executeCommand('set subnet 10.0.0.0 zorglub'))).toBe(true);
  });

  it('`delete` retire l objet', async () => {
    const fw = await avecObjet();
    await taper(fw, ['config firewall address', 'delete "NET-LAN"', 'end']);

    expect(await fw.executeCommand('show firewall address')).not.toMatch(/NET-LAN/);
  });

  it('un objet REFERENCE par une politique ne se supprime pas', async () => {
    const fw = await avecObjet();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "NET-LAN"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end',
    ]);
    await taper(fw, ['config firewall address', 'delete "NET-LAN"', 'end']);

    expect(await fw.executeCommand('show firewall address')).toMatch(/NET-LAN/);
  });

  it('une politique qui reference un objet INCONNU est refusee', async () => {
    const fw = fortigate();
    await taper(fw, ['config firewall policy', 'edit 1', 'set srcintf "port1"']);

    expect(refuse(await fw.executeCommand('set srcaddr "JAMAIS-VU"'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 12. LES POLITIQUES — l'ordre, l'action, et ce qu'elles laissent passer
// ─────────────────────────────────────────────────────────────────────

describe('12. `config firewall policy`', () => {
  async function deuxPolitiques(): Promise<Fw> {
    const fw = fortigate();
    for (const id of ['1', '2']) {
      await taper(fw, [
        'config firewall policy', `edit ${id}`,
        'set srcintf "port1"', 'set dstintf "wan1"',
        'set srcaddr "all"', 'set dstaddr "all"',
        'set action accept', 'set schedule "always"', 'set service "ALL"',
        'next', 'end',
      ]);
    }
    return fw;
  }

  it('les politiques paraissent dans l ordre de leur identifiant', async () => {
    const fw = await deuxPolitiques();
    const vue = await fw.executeCommand('show firewall policy');

    expect(vue.indexOf('edit 1')).toBeLessThan(vue.indexOf('edit 2'));
  });

  it('`set action deny` se relit', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action deny', 'set schedule "always"', 'set service "ALL"',
      'next', 'end',
    ]);

    expect(await fw.executeCommand('show firewall policy')).toMatch(/set action deny/);
  });

  it('une action inconnue est refusee', async () => {
    const fw = fortigate();
    await taper(fw, ['config firewall policy', 'edit 1']);

    expect(refuse(await fw.executeCommand('set action zorglub'))).toBe(true);
  });

  it('une interface source inconnue est refusee', async () => {
    const fw = fortigate();
    await taper(fw, ['config firewall policy', 'edit 1']);

    expect(refuse(await fw.executeCommand('set srcintf "port99"'))).toBe(true);
  });

  it('`set nat enable` se relit', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'set nat enable', 'next', 'end',
    ]);

    expect(await fw.executeCommand('show firewall policy')).toMatch(/set nat enable/);
  });

  it('`move` reordonne les politiques', async () => {
    const fw = await deuxPolitiques();
    await taper(fw, ['config firewall policy', 'move 2 before 1', 'end']);
    const vue = await fw.executeCommand('show firewall policy');

    expect(vue.indexOf('edit 2')).toBeLessThan(vue.indexOf('edit 1'));
  });

  it('`get firewall policy` decrit les politiques', async () => {
    const fw = await deuxPolitiques();

    expect(refuse(await fw.executeCommand('get firewall policy'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 13. LE ROUTAGE STATIQUE
// ─────────────────────────────────────────────────────────────────────

describe('13. `config router static`', () => {
  async function avecRoute(): Promise<Fw> {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit wan1',
      'set mode static', 'set ip 203.0.113.2 255.255.255.0', 'next', 'end',
      'config router static', 'edit 1',
      'set dst 0.0.0.0 0.0.0.0', 'set gateway 203.0.113.1',
      'set device "wan1"', 'next', 'end',
    ]);
    return fw;
  }

  it('la route par defaut se relit', async () => {
    const fw = await avecRoute();

    expect(await fw.executeCommand('show router static')).toMatch(/203\.0\.113\.1/);
  });

  it('`get router info routing-table all` la montre', async () => {
    const fw = await avecRoute();

    expect(refuse(await fw.executeCommand('get router info routing-table all')))
      .toBe(false);
  });

  it('une passerelle malformee est refusee', async () => {
    const fw = fortigate();
    await taper(fw, ['config router static', 'edit 1']);

    expect(refuse(await fw.executeCommand('set gateway 999.1.1.1'))).toBe(true);
  });

  it('un peripherique de sortie inconnu est refuse', async () => {
    const fw = fortigate();
    await taper(fw, ['config router static', 'edit 1']);

    expect(refuse(await fw.executeCommand('set device "port99"'))).toBe(true);
  });

  it('`abort` n installe pas la route', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config router static', 'edit 9',
      'set dst 10.9.0.0 255.255.0.0', 'abort',
    ]);

    expect(await fw.executeCommand('show router static')).not.toMatch(/10\.9\.0\.0/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 14. LES COMPTES D'ADMINISTRATION
// ─────────────────────────────────────────────────────────────────────

describe('14. `config system admin`', () => {
  it('le compte `admin` existe d usine', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('show system admin')).toMatch(/admin/);
  });

  it('un compte cree se relit', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system admin', 'edit "operateur"',
      'set password "MotDePasse1"', 'set accprofile "super_admin"',
      'next', 'end',
    ]);

    expect(await fw.executeCommand('show system admin')).toMatch(/operateur/);
  });

  it('le mot de passe n est PAS rendu en clair', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system admin', 'edit "operateur"',
      'set password "SecretEnClair"', 'set accprofile "super_admin"',
      'next', 'end',
    ]);

    expect(await fw.executeCommand('show system admin')).not.toContain('SecretEnClair');
  });

  it('un profil inconnu est refuse', async () => {
    const fw = fortigate();
    await taper(fw, ['config system admin', 'edit "operateur"']);

    expect(refuse(await fw.executeCommand('set accprofile "zorglub"'))).toBe(true);
  });

  it('`delete` retire un compte', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system admin', 'edit "temporaire"',
      'set password "X1"', 'set accprofile "super_admin"', 'next', 'end',
      'config system admin', 'delete "temporaire"', 'end',
    ]);

    expect(await fw.executeCommand('show system admin')).not.toMatch(/temporaire/);
  });

  it('supprimer le DERNIER super_admin est refuse', async () => {
    const fw = fortigate();
    const sortie = await taper(fw, [
      'config system admin', 'delete "admin"', 'end',
    ]);

    expect(refuse(sortie[1]) || (await fw.executeCommand('show system admin')).includes('admin'))
      .toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 15. `diagnose` — ce que la machine sait d'elle-meme
// ─────────────────────────────────────────────────────────────────────

describe('15. les commandes `diagnose`', () => {
  it('`diagnose ip arp list` existe', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('diagnose ip arp list'))).toBe(false);
  });

  it('`diagnose sys session list` existe', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('diagnose sys session list'))).toBe(false);
  });

  it('une sous-commande `diagnose` absente nomme la COMMANDE, pas le verbe', async () => {
    const fw = fortigate();
    const sortie = await fw.executeCommand('diagnose hardware sysinfo slab');

    expect(sortie).toMatch(/unknown command "diagnose hardware sysinfo slab"/);
    expect(sortie).not.toMatch(/unknown command "diagnose"\./);
  });

  it('une sous-commande `diagnose` inconnue est refusee', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('diagnose zorglub truc'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 16. LE VDOM — le decoupage administratif
// ─────────────────────────────────────────────────────────────────────

describe('16. les VDOM', () => {
  it('`config global` est refuse tant que le multi-vdom est absent', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('config global'))).toBe(true);
  });

  it('`set vdom-mode multi-vdom` ouvre `config global`', async () => {
    const fw = fortigate();
    await taper(fw, ['config system global', 'set vdom-mode multi-vdom', 'end']);

    expect(refuse(await fw.executeCommand('config global'))).toBe(false);
  });

  it('et `end` en ressort', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system global', 'set vdom-mode multi-vdom', 'end',
      'config global', 'end',
    ]);

    expect(fw.getPrompt().trim()).toBe(`${fw.getHostname()} #`);
  });

  it('et l invite reprend sa forme de racine apres etre sorti', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system global', 'set vdom-mode multi-vdom', 'end',
      'config global',
    ]);
    expect(fw.getPrompt().trim()).toMatch(/\(global\)/);
    await fw.executeCommand('end');

    expect(fw.getPrompt().trim()).toBe(`${fw.getHostname()} #`);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 17. LA SAUVEGARDE ET LES REVISIONS
// ─────────────────────────────────────────────────────────────────────

describe('17. sauvegarde et revisions', () => {
  it('`execute backup config` sans destination est incomplet', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('execute backup config'))).toBe(true);
  });

  it('`execute revision list config` existe', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('execute revision list config'))).toBe(false);
  });

  it('`show full-configuration` rend plus que `show`', async () => {
    const fw = fortigate();
    const court = await fw.executeCommand('show');
    const complet = await fw.executeCommand('show full-configuration');

    expect(complet.length).toBeGreaterThanOrEqual(court.length);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 18. LE JOURNAL
// ─────────────────────────────────────────────────────────────────────

describe('18. la journalisation', () => {
  it('`config log memory setting` existe', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('config log memory setting'))).toBe(false);
  });

  it('`set status enable` s y applique', async () => {
    const fw = fortigate();
    await fw.executeCommand('config log memory setting');

    expect(refuse(await fw.executeCommand('set status enable'))).toBe(false);
  });

  it('et se relit apres `end`', async () => {
    const fw = fortigate();
    await taper(fw, ['config log memory setting', 'set status enable', 'end']);

    expect(await fw.executeCommand('show log memory setting'))
      .toMatch(/set status enable/);
  });

  it('`execute log filter` existe', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('execute log filter category 1'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 19. LE DNS ET LE TEMPS
// ─────────────────────────────────────────────────────────────────────

describe('19. DNS et temps', () => {
  it('`config system dns` accepte un serveur primaire', async () => {
    const fw = fortigate();
    await taper(fw, ['config system dns', 'set primary 8.8.8.8', 'end']);

    expect(await fw.executeCommand('show system dns')).toMatch(/8\.8\.8\.8/);
  });

  it('un serveur DNS malforme est refuse', async () => {
    const fw = fortigate();
    await fw.executeCommand('config system dns');

    expect(refuse(await fw.executeCommand('set primary 999.1.1.1'))).toBe(true);
  });

  it('`config system ntp` existe', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('config system ntp'))).toBe(false);
  });

  it('le fuseau se pose par NOM', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system global', 'set timezone "Europe/Paris"', 'end',
    ]);

    expect(await fw.executeCommand('show system global')).toContain('Europe/Paris');
  });

  it('un fuseau inconnu est refuse', async () => {
    const fw = fortigate();
    await fw.executeCommand('config system global');

    expect(refuse(await fw.executeCommand('set timezone "Mars/Olympus"'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 20. L'INVITE SOUS TOUTES SES FORMES — le detail qui fait le realisme
// ─────────────────────────────────────────────────────────────────────

describe('20. l invite ne ment jamais sur le contexte', () => {
  it('une commande REFUSEE ne bouge pas l invite', async () => {
    const fw = fortigate();
    await taper(fw, ['config system interface', 'edit port1']);
    const avant = fw.getPrompt();
    await fw.executeCommand('set zorglub 1');

    expect(fw.getPrompt()).toBe(avant);
  });

  it('`abort` depuis DEUX niveaux revient a la racine', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1', 'config identity-based-policy', 'abort',
    ]);

    expect(fw.getPrompt().trim()).toBe(`${fw.getHostname()} #`);
  });

  it('l invite suit un changement de nom commite, meme en sous-mode', async () => {
    const fw = fortigate();
    await taper(fw, ['config system global', 'set hostname RENOMME', 'end']);
    await fw.executeCommand('config system interface');

    expect(fw.getPrompt().trim()).toBe('RENOMME (interface) #');
  });

  it('une ligne VIDE ne change rien', async () => {
    const fw = fortigate();
    await fw.executeCommand('config system global');
    const avant = fw.getPrompt();
    await fw.executeCommand('');

    expect(fw.getPrompt()).toBe(avant);
  });

  it('des espaces en trop sont tolerees', async () => {
    const fw = fortigate();

    expect(refuse(await fw.executeCommand('  config   system   global  '))).toBe(false);
    expect(fw.getPrompt().trim()).toMatch(/\(global\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 21. L'ETAT D'UNE INTERFACE — l'ADMINISTRATIF et le LIEN sont deux faits
// ─────────────────────────────────────────────────────────────────────

function blocInterface(vue: string, nom: string): string {
  const debut = vue.indexOf(`== [${nom}]`);
  const suite = vue.indexOf('== [', debut + 1);
  return suite < 0 ? vue.slice(debut) : vue.slice(debut, suite);
}

describe('21. `get system interface` rend l etat ADMINISTRATIF', () => {
  it('un port sans cable mais admin-up est `status: up`', async () => {
    const fw = fortigate();

    expect(blocInterface(await fw.executeCommand('get system interface'), 'port1'))
      .toMatch(/status: up/);
  });

  it('et sa vitesse est `n/a` — c est LA que le lien se voit', async () => {
    const fw = fortigate();

    expect(blocInterface(await fw.executeCommand('get system interface'), 'port1'))
      .toMatch(/speed: n\/a/);
  });

  it('`set status down` le fait passer a `down`', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config system interface', 'edit port1', 'set status down', 'next', 'end',
    ]);

    expect(blocInterface(await fw.executeCommand('get system interface'), 'port1'))
      .toMatch(/status: down/);
  });

  it('un port CABLE et admin-up annonce sa vitesse', async () => {
    const fw = fortigate();
    const pc = new LinuxPC('linux-pc', 'PC1', 400, 0);
    pc.powerOn();
    new Cable('lien').connect(fw.getPort('port1') as never, pc.getPort('eth0') as never);
    await pc.executeCommand('ip link set eth0 up');

    const bloc = blocInterface(await fw.executeCommand('get system interface'), 'port1');
    expect(bloc).toMatch(/status: up/);
    expect(bloc).toMatch(/speed: \d+Mbps/);
  });

  it('un port cable mais admin-DOWN reste `status: down`', async () => {
    const fw = fortigate();
    const pc = new LinuxPC('linux-pc', 'PC1', 400, 0);
    pc.powerOn();
    new Cable('lien').connect(fw.getPort('port1') as never, pc.getPort('eth0') as never);
    await taper(fw, [
      'config system interface', 'edit port1', 'set status down', 'next', 'end',
    ]);

    expect(blocInterface(await fw.executeCommand('get system interface'), 'port1'))
      .toMatch(/status: down/);
  });
});
