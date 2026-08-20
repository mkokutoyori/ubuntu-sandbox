/**
 * `logging` — ce qui est refusé, ce que l'aide descend, ce que les vues
 * disent (docs/PRD-Logging-Cisco.md).
 *
 * Ce qui rendait la famille entière décorative tenait en une ligne : la
 * commande était un unique nœud glouton dont le `switch` avait un
 * `default` muet. Rien n'était refusé, et l'aide n'avait rien à
 * descendre. Les deux moitiés se mesurent ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { LoggingConfig } from '@/network/devices/inspection/config/LoggingConfig';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function configured(lignes: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const l of lignes) await r.executeCommand(l);
  await r.executeCommand('end');
  return r;
}

describe('une commande logging qui ne veut rien dire est refusée', () => {
  const REFUSES = [
    'logging',
    'logging nimportequoi',
    'logging console zzz',
    'logging console 9',
    'logging console -1',
    'logging monitor 8',
    'logging trap 99',
    'logging facility nawak',
    'logging host 999.1.1.1',
    'logging host',
    'logging buffered 10',
    'logging buffered 4095',
    'logging buffered 99999999999',
    'logging history 12',
    'logging history size 0',
    'logging history size 501',
    'logging exception 100',
    'logging rate-limit 0',
    'logging rate-limit 10 except zzz',
    'logging origin-id nawak',
    'logging source-interface',
  ];

  it.each(REFUSES)('%s', async (cmd) => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand(cmd)).toMatch(/Invalid input|Incomplete command/);
  });

  it('un abrégé non ambigu vaut le mot entier, comme partout dans IOS', async () => {
    for (const [tape, attendu] of [
      ['logging console warn', 'Console logging: level warnings'],
      ['logging buffered 8192 debug', 'Buffer logging:  level debugging'],
      ['logging trap notif', 'Trap logging: level notifications'],
      ['logging monitor crit', 'Monitor logging: level critical'],
    ]) {
      const r = await configured([tape]);
      expect(await r.executeCommand('show logging'), tape).toContain(attendu);
    }
  });

  it('un abrégé AMBIGU reste refusé — `e` désigne deux sévérités', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('logging console e')).toMatch(/Invalid input/);
  });

  it('une facilité s\'abrège aussi, et l\'exact l\'emporte sur le plus long', async () => {
    const r = await configured(['logging facility auth']);
    expect(await r.executeCommand('show logging')).toContain('Facility: auth');
    const p = await configured(['logging facility authp']);
    expect(await p.executeCommand('show logging')).toContain('Facility: authpriv');
  });

  it('une valeur refusée ne modifie rien — l\'ancienne reste en place', async () => {
    const r = await configured(['logging console warnings']);
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging console 9');
    await r.executeCommand('end');
    expect(await r.executeCommand('show logging')).toMatch(/Console logging: level warnings/);
  });

  it('les familles qu\'IOS connaît et que cette plateforme n\'a pas restent refusées', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    // ESM demande un moteur de filtrage TCL, CNS un agent CNS, et
    // `policy-firewall` un pare-feu par zones : aucune de ces briques
    // n'existe ici, et aucune ne peut être simulée à moitié.
    for (const c of ['logging esm config', 'logging filter flash:/f.tcl',
      'logging cns-events warnings', 'logging policy-firewall rate-limit 10']) {
      expect(await r.executeCommand(c), c).toMatch(/Invalid input/);
    }
  });
});

describe('ce que l\'aide descend', () => {
  async function aide(r: CiscoRouter, q: string): Promise<string> {
    return r.executeCommand(q);
  }

  it('`logging console ?` rend les sévérités, pas la liste du dessus', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const out = await aide(r, 'logging console ?');
    for (const s of ['emergencies', 'alerts', 'critical', 'errors',
      'warnings', 'notifications', 'informational', 'debugging']) {
      expect(out, s).toContain(s);
    }
    expect(out).toContain('<0-7>');
    // Le défaut d'avant : après avoir choisi `console`, l'aide proposait
    // de rechoisir `console`.
    expect(out).not.toContain('Set console logging parameters');
  });

  it('chaque sévérité porte son numéro, ce qui dispense de retenir la table', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const out = await aide(r, 'logging trap ?');
    expect(out).toMatch(/emergencies\s+System is unusable \(severity=0\)/);
    expect(out).toMatch(/warnings\s+Warning conditions \(severity=4\)/);
    expect(out).toMatch(/debugging\s+Debugging messages \(severity=7\)/);
  });

  it('`logging ?` propose bien plus que six mots-clés, tous décrits', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const out = await aide(r, 'logging ?');
    for (const k of ['buffered', 'console', 'count', 'exception', 'facility',
      'history', 'host', 'monitor', 'on', 'origin-id', 'rate-limit',
      'source-interface', 'trap']) {
      expect(out, k).toContain(k);
    }
    for (const l of out.split('\n').filter(l => l.trim())) {
      expect(l.trim().split(/\s{2,}/).length, l).toBeGreaterThan(1);
    }
  });

  it('`logging buffered ?` propose une TAILLE et un NIVEAU, puisque les deux sont admis', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const out = await aide(r, 'logging buffered ?');
    expect(out).toContain('<4096-2147483647>');
    expect(out).toContain('<0-7>');
  });

  it('la complétion par tabulation marche sur les sous-commandes', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('logging buf?')).toContain('buffered');
    expect(await r.executeCommand('logging so?')).toContain('source-interface');
  });

  it('`service ?` connaît sequence-numbers, qui n\'y figurait pas', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('service ?')).toContain('sequence-numbers');
  });

  it('`show logging ?` connaît sa table d\'historique', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show logging ?')).toContain('history');
  });
});

describe('logging buffered résout son argument par sa VALEUR', () => {
  it('6 est une sévérité, pas un tampon de six octets', async () => {
    const r = await configured(['logging buffered 6']);
    const out = await r.executeCommand('show logging');
    expect(out).toMatch(/Buffer logging: {2}level informational/);
    expect(out).not.toContain('Log Buffer (6 bytes)');
    expect(out).toContain('Log Buffer (4096 bytes):');
  });

  it('8192 est une taille', async () => {
    const r = await configured(['logging buffered 8192']);
    expect(await r.executeCommand('show logging')).toContain('Log Buffer (8192 bytes):');
  });

  it('les deux ensemble, dans les deux ordres', async () => {
    for (const ligne of ['logging buffered 8192 warnings', 'logging buffered warnings 8192']) {
      const r = await configured([ligne]);
      const out = await r.executeCommand('show logging');
      expect(out, ligne).toMatch(/Buffer logging: {2}level warnings/);
      expect(out, ligne).toContain('Log Buffer (8192 bytes):');
    }
  });

  it('un nombre entre 8 et 4095 n\'est ni l\'un ni l\'autre', async () => {
    const l = new LoggingConfig();
    expect(l.applyLogging(['buffered', '2000'], false)).not.toBeNull();
  });
});

describe('service sequence-numbers numérote pour de vrai', () => {
  it('les lignes portent un numéro à six chiffres et show logging le dit', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('service sequence-numbers');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    const out = await r.executeCommand('show logging');
    expect(out).toContain('Sequence numbers: enabled');
    expect(out).toMatch(/^\d{6}: .*%LINK-5-CHANGED/m);
  });

  it('sans la commande, aucune ligne ne porte de numéro', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    const out = await r.executeCommand('show logging');
    expect(out).toContain('Sequence numbers: disabled');
    expect(out).not.toMatch(/^\d{6}: /m);
  });

  it('le compteur ne repart pas à zéro sur un clear logging', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('service sequence-numbers');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
    await r.executeCommand('clear logging');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    const numeros = (await r.executeCommand('show logging'))
      .split('\n').filter(l => /^\d{6}: /.test(l)).map(l => Number(l.slice(0, 6)));
    expect(numeros.length).toBeGreaterThan(0);
    expect(Math.min(...numeros)).toBeGreaterThan(1);
  });

  it('la commande figure dans la running-config, une seule fois', async () => {
    const r = await configured(['service sequence-numbers']);
    const lignes = (await r.executeCommand('show running-config'))
      .split('\n').filter(l => l.trim() === 'service sequence-numbers');
    expect(lignes).toHaveLength(1);
  });
});

describe('show logging au format d\'IOS 15', () => {
  it('chaque destination porte son compteur de messages', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    const out = await r.executeCommand('show logging');
    const buffer = out.split('\n').find(l => l.includes('Buffer logging:'))!;
    const compte = Number(buffer.match(/(\d+) messages logged/)![1]);
    expect(compte).toBeGreaterThan(0);
  });

  it('les champs que ce simulateur ne modélise pas sont rendus à leur valeur constante', async () => {
    const r = await configured([]);
    const out = await r.executeCommand('show logging');
    expect(out).toContain('xml disabled, filtering disabled');
    expect(out).toContain('Persistent logging: disabled');
    expect(out).toContain('Exception Logging: size (4096 bytes)');
  });

  it('le détail par hôte porte le transport et le port', async () => {
    const r = await configured(['logging host 10.0.0.1 transport tcp port 1470']);
    const out = await r.executeCommand('show logging');
    expect(out).toContain('Logging to 10.0.0.1  (tcp port 1470, audit disabled,');
  });

  it('un hôte sans précision reste en udp/514', async () => {
    const r = await configured(['logging host 10.0.0.2']);
    expect(await r.executeCommand('show logging')).toContain('(udp port 514,');
  });
});

describe('show logging history est sa propre table', () => {
  it('elle ne rend pas show logging', async () => {
    const r = await configured([]);
    const hist = await r.executeCommand('show logging history');
    expect(hist).toContain('Syslog History Table:');
    expect(hist).not.toContain('Console logging:');
    expect(hist).not.toContain('Log Buffer');
  });

  it('elle annonce sa taille et son niveau, et les deux se règlent', async () => {
    const r = await configured(['logging history errors', 'logging history size 20']);
    const hist = await r.executeCommand('show logging history');
    expect(hist).toContain('Syslog History Table:20 maximum table entries,');
    expect(hist).toContain('saving level errors or higher');
  });

  it('le singulier de la taille par défaut est celui d\'IOS', async () => {
    const r = await configured([]);
    expect(await r.executeCommand('show logging history'))
      .toContain('Syslog History Table:1 maximum table entry,');
  });

  it('un message sous le niveau est compté ignoré, pas gardé', () => {
    const l = new LoggingConfig();
    l.applyLogging(['history', 'errors'], false);
    l.append('informational', 'sys', 'trop bas', true, 'CONFIG_I');
    expect(l.renderHistory()).toMatch(/1 messages ignored/);
    expect(l.renderHistory()).not.toContain('trop bas');
  });

  it('un message au niveau y entre', () => {
    const l = new LoggingConfig();
    l.applyLogging(['history', 'errors'], false);
    l.append('errors', 'link', 'lien perdu', true, 'UPDOWN');
    expect(l.renderHistory()).toContain('LINK-3-UPDOWN');
    expect(l.renderHistory()).toContain('lien perdu');
  });
});

describe('la running-config reproduit ce qui a été tapé', () => {
  it('le transport et le port de l\'hôte survivent', async () => {
    const r = await configured(['logging host 10.0.0.1 transport tcp port 1470']);
    expect(await r.executeCommand('show running-config'))
      .toContain('logging host 10.0.0.1 transport tcp port 1470');
  });

  it('la portée et l\'exception du rate-limit survivent', async () => {
    const r = await configured(['logging rate-limit all 10 except errors']);
    expect(await r.executeCommand('show running-config'))
      .toContain('logging rate-limit all 10 except errors');
  });

  it('origin-id, count, exception et history survivent', async () => {
    const r = await configured([
      'logging origin-id string SITE-A', 'logging count',
      'logging exception 8192', 'logging history notifications',
      'logging history size 20',
    ]);
    const rc = await r.executeCommand('show running-config');
    for (const l of ['logging origin-id string SITE-A', 'logging count',
      'logging exception 8192', 'logging history notifications',
      'logging history size 20']) {
      expect(rc, l).toContain(l);
    }
  });

  it('la forme héritée `logging <ip>` est normalisée en `logging host`, comme IOS le fait', async () => {
    const r = await configured(['logging 10.0.0.9']);
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('logging host 10.0.0.9');
    expect(rc).not.toMatch(/^logging 10\.0\.0\.9$/m);
  });

  it('ce qui vaut le défaut n\'est pas rendu', async () => {
    const r = await configured(['logging trap informational', 'logging facility local7']);
    const rc = await r.executeCommand('show running-config');
    expect(rc).not.toContain('logging trap informational');
    expect(rc).not.toContain('logging facility local7');
  });
});

describe('le limiteur borne ce qu\'IOS borne', () => {
  it('sans mot-clé, seule la console est bornée — le tampon garde tout', () => {
    const l = new LoggingConfig();
    const console: string[] = [];
    l.subscribeConsole(c => console.push(c));
    l.applyLogging(['buffered'], false);
    l.applyLogging(['rate-limit', '3'], false);
    for (let i = 0; i < 20; i++) l.append('warnings', 'sys', `rafale ${i}`, true, 'CONFIG_I');
    expect(console.filter(c => c.includes('rafale')).length).toBe(3);
    expect(l.render().split('\n').filter(c => c.includes('rafale')).length).toBe(20);
  });

  it('`all` borne aussi le tampon, ce qui n\'est pas la même décision', () => {
    const l = new LoggingConfig();
    l.applyLogging(['buffered'], false);
    l.applyLogging(['rate-limit', 'all', '3'], false);
    for (let i = 0; i < 20; i++) l.append('warnings', 'sys', `rafale ${i}`, true, 'CONFIG_I');
    expect(l.render().split('\n').filter(c => c.includes('rafale')).length).toBe(3);
  });

  it('`except` exempte la sévérité nommée et au-dessus', () => {
    const l = new LoggingConfig();
    const console: string[] = [];
    l.subscribeConsole(c => console.push(c));
    l.applyLogging(['rate-limit', '1', 'except', 'errors'], false);
    for (let i = 0; i < 10; i++) l.append('critical', 'sys', `grave ${i}`, true, 'CONFIG_I');
    expect(console.filter(c => c.includes('grave')).length).toBe(10);
  });
});

describe('un discriminateur filtre pour de vrai', () => {
  async function avecFiltre(clause: string, cible: string): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand(`logging discriminator MD1 ${clause}`);
    await r.executeCommand(`logging ${cible} discriminator MD1`);
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
    return r;
  }

  function tampon(sortie: string): string[] {
    const i = sortie.indexOf('Log Buffer (');
    return i === -1 ? [] : sortie.slice(i).split('\n').filter(l => l.includes('%'));
  }

  it('`mnemonics drops` retire les lignes qui portent ce mnémonique', async () => {
    const r = await avecFiltre('mnemonics drops UPDOWN', 'buffered');
    const lignes = tampon(await r.executeCommand('show logging'));
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.filter(l => l.includes('UPDOWN'))).toHaveLength(0);
    expect(lignes.filter(l => l.includes('CHANGED')).length).toBeGreaterThan(0);
  });

  it('`mnemonics includes` ne garde que celles-là', async () => {
    const r = await avecFiltre('mnemonics includes UPDOWN', 'buffered');
    const lignes = tampon(await r.executeCommand('show logging'));
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.filter(l => l.includes('CHANGED'))).toHaveLength(0);
  });

  it('`severity includes` borne par niveau', () => {
    const l = new LoggingConfig();
    l.applyLogging(['buffered'], false);
    l.applyLogging(['discriminator', 'MD1', 'severity', 'includes', '0-3'], false);
    l.applyLogging(['buffered', 'discriminator', 'MD1'], false);
    l.append('errors', 'link', 'grave', true, 'UPDOWN');
    l.append('informational', 'sys', 'anodin', true, 'CONFIG_I');
    expect(l.render()).toContain('grave');
    expect(l.render()).not.toContain('anodin');
  });

  it('`msg-body drops` porte sur le TEXTE, espaces compris', () => {
    const l = new LoggingConfig();
    l.applyLogging(['buffered'], false);
    l.applyLogging(['discriminator', 'MD1', 'msg-body', 'drops', 'changed', 'state'], false);
    l.applyLogging(['buffered', 'discriminator', 'MD1'], false);
    l.append('errors', 'link', 'Interface Gi0/0, changed state to up', true, 'UPDOWN');
    l.append('errors', 'link', 'Cable disconnected from Gi0/0', true, 'UPDOWN');
    // Le motif figure aussi dans la section des discriminateurs de
    // `show logging` : c'est le TAMPON qu'on regarde, pas la vue entière.
    const rendu = l.render();
    const buffer = rendu.slice(rendu.indexOf('Log Buffer ('));
    expect(buffer).not.toContain('changed state');
    expect(buffer).toContain('Cable disconnected');
  });

  it('`facility drops` porte sur la facilité du message', () => {
    const l = new LoggingConfig();
    l.applyLogging(['buffered'], false);
    l.applyLogging(['discriminator', 'MD1', 'facility', 'drops', 'OSPF'], false);
    l.applyLogging(['buffered', 'discriminator', 'MD1'], false);
    l.append('notifications', 'ospf', 'adjacence', true, 'ADJCHG');
    l.append('notifications', 'bgp', 'voisin', true, 'ADJCHANGE');
    expect(l.render()).not.toContain('adjacence');
    expect(l.render()).toContain('voisin');
  });

  it('un filtre attaché est ACTIF, un filtre défini et attaché à rien est INACTIF', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging discriminator ACTIF mnemonics drops X');
    await r.executeCommand('logging discriminator ORPHELIN mnemonics drops Y');
    await r.executeCommand('logging console discriminator ACTIF');
    await r.executeCommand('end');
    const out = await r.executeCommand('show logging');
    expect(out).toContain('Active Message Discriminator:');
    expect(out).toContain('Inactive Message Discriminator:');
    expect(out.slice(out.indexOf('Active Message'), out.indexOf('Inactive Message')))
      .toContain('ACTIF');
    expect(out.slice(out.indexOf('Inactive Message'))).toContain('ORPHELIN');
  });

  it('attacher un filtre qui n\'existe pas est refusé', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('logging console discriminator ABSENT'))
      .toMatch(/Invalid input/);
  });

  it('un collecteur a son propre filtre, et ce qu\'il perd est compté', () => {
    const l = new LoggingConfig();
    l.applyLogging(['discriminator', 'MD1', 'mnemonics', 'drops', 'UPDOWN'], false);
    l.applyLogging(['host', '10.0.0.1', 'discriminator', 'MD1'], false);
    l.append('errors', 'link', 'a', true, 'UPDOWN');
    l.append('errors', 'link', 'b', true, 'CHANGED');
    expect(l.render()).toContain('1 message lines dropped-by-MD');
    expect(l.render()).toMatch(/1 message lines logged, 0 message lines rate-limited/);
  });

  it('les filtres survivent à la running-config, définis avant d\'être attachés', async () => {
    const r = await configured([
      'logging discriminator MD1 severity includes 0-4 msg-body drops OSPF',
      'logging console discriminator MD1',
    ]);
    const rc = (await r.executeCommand('show running-config')).split('\n');
    const iDef = rc.findIndex(l => l.startsWith('logging discriminator MD1'));
    const iAtt = rc.findIndex(l => l.includes('logging console discriminator MD1'));
    expect(iDef).toBeGreaterThanOrEqual(0);
    expect(iAtt).toBeGreaterThan(iDef);
    expect(rc[iDef]).toContain('severity includes 0,1,2,3,4');
    expect(rc[iDef]).toContain('msg-body drops OSPF');
  });
});

describe('logging persistent écrit vraiment sur le flash', () => {
  it('le fichier apparaît dans dir flash: et show logging persistent le relit', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging persistent url flash:/syslog size 32768 filesize 8192');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('dir flash:')).toMatch(/syslog_00001/);
    const journal = await r.executeCommand('show logging persistent');
    expect(journal).toContain('Persistent logging url: flash:/syslog');
    expect(journal).toContain('%LINK-5-CHANGED');
  });

  it('sans la commande, aucun fichier n\'est écrit', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('dir flash:')).not.toMatch(/syslog_/);
    expect(await r.executeCommand('show logging persistent'))
      .toBe('Persistent logging is disabled');
  });

  it('`clear logging persistent` efface les fichiers, pas le tampon', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging persistent url flash:/syslog size 32768 filesize 8192');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    await r.executeCommand('clear logging persistent');
    expect(await r.executeCommand('dir flash:')).not.toMatch(/syslog_/);
    expect(await r.executeCommand('show logging')).toMatch(/%LINK-5-CHANGED/);
  });

  it('un fichier plus grand que le journal entier est refusé', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('logging persistent size 4096 filesize 8192'))
      .toMatch(/Invalid input/);
  });

  it('show logging annonce l\'url et les deux tailles', async () => {
    const r = await configured(['logging persistent url flash:/j size 32768 filesize 8192']);
    expect(await r.executeCommand('show logging'))
      .toContain('Persistent logging: enabled, url flash:/j, size 32768, filesize 8192');
  });
});

describe('les autres commandes autrefois absentes', () => {
  const NOUVELLES: Array<[string, string]> = [
    ['logging snmp-trap warnings', 'logging snmp-trap warnings'],
    ['logging userinfo', 'logging userinfo'],
    ['logging server-arp', 'logging server-arp'],
    ['logging queue-limit trap 200', 'logging queue-limit trap 200'],
    ['logging queue-limit 100', 'logging queue-limit 100'],
    ['logging message-counter debug', 'logging message-counter debug'],
    ['logging delimiter tcp', 'logging delimiter tcp'],
    ['logging reload critical message-limit 10', 'logging reload critical message-limit 10'],
  ];

  it.each(NOUVELLES)('%s est acceptée et rendue telle quelle', async (cmd, attendu) => {
    const r = await configured([cmd]);
    expect(await r.executeCommand('show running-config')).toContain(attendu);
  });

  it('logging snmp-trap rend la ligne SNMP de la table d\'historique vraie', async () => {
    const sans = await configured([]);
    expect(await sans.executeCommand('show logging history'))
      .toContain('SNMP notifications not enabled');
    const avec = await configured(['logging snmp-trap warnings']);
    expect(await avec.executeCommand('show logging history'))
      .toContain('SNMP notifications enabled, severity warnings or higher');
  });

  it('logging userinfo journalise qui passe en mode privilégié', async () => {
    const r = await configured(['logging userinfo']);
    await r.executeCommand('disable');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show logging'))
      .toMatch(/%SYS-5-PRIV_AUTH_PASS: Privilege level set to 15 by unknown on console/);
  });

  it('sans logging userinfo, rien n\'est journalisé sur enable', async () => {
    const r = await configured([]);
    await r.executeCommand('disable');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show logging')).not.toContain('PRIV_AUTH_PASS');
  });

  async function cibleArp(serverArp: boolean): Promise<string[]> {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    new Cable('lan').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    // Ce qui se mesure est que la requête PART au moment où le
    // collecteur est configuré — pas qu'elle soit résolue : l'adresse
    // choisie ne répond pas, exprès.
    const cibles: string[] = [];
    const port = r.getPort('GigabitEthernet0/0')!;
    const vraiSend = port.sendFrame.bind(port);
    (port as unknown as { sendFrame: (f: unknown) => unknown }).sendFrame = (f: unknown) => {
      const trame = f as { payload?: { type?: string; operation?: string; targetIP?: { toString(): string } } };
      if (trame.payload?.type === 'arp' && trame.payload.operation === 'request') {
        cibles.push(String(trame.payload.targetIP));
      }
      return (vraiSend as (x: unknown) => unknown)(f);
    };
    if (serverArp) await r.executeCommand('logging server-arp');
    await r.executeCommand('logging host 10.0.0.50');
    // On reste en mode configuration : quitter produirait un
    // %SYS-5-CONFIG_I, que le chemin ordinaire relaierait vers le
    // collecteur — et cet ARP-là partirait dans les deux cas, ce qui ne
    // distinguerait plus rien.
    return cibles;
  }

  it('logging server-arp résout le collecteur dès sa configuration', async () => {
    expect(await cibleArp(true)).toContain('10.0.0.50');
  });

  it('sans le mot-clé, rien ne part tant qu\'aucun message n\'attend', async () => {
    expect(await cibleArp(false)).not.toContain('10.0.0.50');
  });

  it('les mots-clés inconnus de ces familles restent refusés', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (const c of ['logging delimiter udp', 'logging message-counter nawak',
      'logging snmp-trap 9', 'logging queue-limit 0']) {
      expect(await r.executeCommand(c), c).toMatch(/Invalid input/);
    }
  });

  it('toutes figurent dans l\'aide de premier niveau', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const out = await r.executeCommand('logging ?');
    for (const k of ['delimiter', 'discriminator', 'message-counter', 'persistent',
      'queue-limit', 'reload', 'server-arp', 'snmp-trap', 'userinfo']) {
      expect(out, k).toContain(k);
    }
  });
});

describe('le commutateur et le routeur répondent la même chose', () => {
  it('la même commande est refusée des deux côtés', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    const r = new CiscoRouter('R1');
    for (const d of [r, sw]) {
      await d.executeCommand('enable');
      await d.executeCommand('configure terminal');
      expect(await d.executeCommand('logging console 9'), d.id).toMatch(/Invalid input/);
      expect(await d.executeCommand('logging facility nawak'), d.id).toMatch(/Invalid input/);
    }
  });

  it('l\'aide du commutateur descend aussi', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const out = await sw.executeCommand('logging console ?');
    expect(out).toContain('notifications');
    expect(out).toContain('<0-7>');
  });

  it('le commutateur a lui aussi sa table d\'historique', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('show logging history'))
      .toContain('Syslog History Table:');
  });
});

describe('un redémarrage emporte le tampon, comme la mémoire vive', () => {
  async function labo(): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    return r;
  }

  const lignes = (s: string) => s.split('\n').filter(l => l.includes('%'));

  it('ce qui précédait le démarrage n\'est plus là', async () => {
    const r = await labo();
    expect(lignes(await r.executeCommand('show logging'))
      .some(l => l.includes('CHANGED'))).toBe(true);
    await r.executeCommand('reload');
    await r.executeCommand('enable');
    // Une machine ne peut pas se souvenir de ce qui a précédé sa mise
    // sous tension ; diagnostiquer sur cet historique-là est pire que de
    // n'en avoir aucun.
    expect(lignes(await r.executeCommand('show logging'))
      .some(l => l.includes('CHANGED'))).toBe(false);
  });

  it('la première ligne d\'une machine qui boote est %SYS-5-RESTART', async () => {
    const r = await labo();
    await r.executeCommand('reload');
    await r.executeCommand('enable');
    expect(lignes(await r.executeCommand('show logging'))[0])
      .toContain('%SYS-5-RESTART: System restarted --');
  });

  it('`logging reload <sévérité>` borne ce qui est journalisé pendant', async () => {
    const r = await labo();
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging reload critical');
    await r.executeCommand('end');
    await r.executeCommand('reload');
    await r.executeCommand('enable');
    const apres = lignes(await r.executeCommand('show logging'));
    // Les remontées d'interface sont en sévérité 3 et 5 : sous
    // `critical` (2), aucune ne passe la fenêtre du redémarrage.
    expect(apres.some(l => l.includes('LINEPROTO'))).toBe(false);
  });

  it('`message-limit` borne leur NOMBRE', async () => {
    const r = await labo();
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging reload debugging message-limit 1');
    await r.executeCommand('end');
    await r.executeCommand('reload');
    await r.executeCommand('enable');
    const apres = lignes(await r.executeCommand('show logging'));
    // Un seul message pendant la fenêtre, plus le %SYS-5-RESTART qui la
    // suit et n'en fait donc pas partie.
    expect(apres.length).toBeLessThanOrEqual(2);
  });

  it('sans la commande, le redémarrage journalise tout', async () => {
    const r = await labo();
    await r.executeCommand('reload');
    await r.executeCommand('enable');
    const apres = lignes(await r.executeCommand('show logging'));
    expect(apres.some(l => l.includes('LINEPROTO'))).toBe(true);
  });
});

describe('show logging count obéit aux deux commandes qui le règlent', () => {
  async function labo(config: string[]): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (const c of config) await r.executeCommand(c);
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    return r;
  }

  it('sans `logging count`, la table n\'est pas rendue', async () => {
    const r = await labo([]);
    expect(await r.executeCommand('show logging count')).toContain('not enabled');
  });

  it('avec `logging count`, elle compte les messages ordinaires', async () => {
    const r = await labo(['logging count']);
    const out = await r.executeCommand('show logging count');
    expect(out).toContain('Facility');
    expect(out).toContain('LINK');
  });

  it('les lignes de debug ne gonflent pas la table par défaut', async () => {
    const l = new LoggingConfig();
    l.applyLogging(['buffered'], false);
    l.applyLogging(['count'], false);
    l.append('debugging', 'ospf', 'bavardage', true, 'DEBUG');
    l.append('warnings', 'link', 'vrai', true, 'UPDOWN');
    expect(l.renderCount()).toContain('LINK');
    expect(l.renderCount()).not.toContain('OSPF');
  });

  it('`logging message-counter debug` les y fait entrer', () => {
    const l = new LoggingConfig();
    l.applyLogging(['buffered'], false);
    l.applyLogging(['count'], false);
    l.applyLogging(['message-counter', 'debug'], false);
    l.append('debugging', 'ospf', 'bavardage', true, 'DEBUG');
    expect(l.renderCount()).toContain('OSPF');
  });

  it('`no logging message-counter log` retire les messages ordinaires', () => {
    const l = new LoggingConfig();
    l.applyLogging(['buffered'], false);
    l.applyLogging(['count'], false);
    l.applyLogging(['message-counter', 'log'], true);
    l.append('warnings', 'link', 'vrai', true, 'UPDOWN');
    expect(l.renderCount()).not.toContain('LINK');
  });
});
