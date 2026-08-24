import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(commutateur = false): Cli {
  const device = (commutateur
    ? new CiscoSwitch('switch-cisco', `S${serial++}`)
    : new CiscoRouter(`R${serial++}`, 0, 0)) as unknown as Cli;
  device.powerOn();
  return device;
}

async function dans(entree: readonly string[], commutateur = false): Promise<Cli> {
  const device = nu(commutateur);
  for (const c of ['enable', 'configure terminal', ...entree]) {
    await device.executeCommand(c);
  }
  return device;
}

function trie(device: Cli, champ: string): CommandTrie {
  return (device as unknown as { shell: Record<string, unknown> }).shell[champ] as CommandTrie;
}

const APPLET = ['event manager applet TEST'];
const EXPORTEUR = ['flow exporter EXP'];
const ENREGISTREMENT = ['flow record REC'];
const MONITEUR = ['flow monitor MON'];
const ARCHIVE = ['archive'];
const ARCHIVE_LOG = ['archive', 'log config'];

describe('les six arbres EEM / NetFlow / archive sont VIDES', () => {
  it.each([
    'configAppletTrie', 'configFlowExporterTrie', 'configFlowRecordTrie',
    'configFlowMonitorTrie', 'configArchiveTrie', 'configArchiveLogTrie',
  ])('%s ne porte plus aucun chemin sur le routeur', (champ) => {
    expect(trie(nu(), champ).enumerateExecutablePaths()).toEqual([]);
  });

  it.each(['configArchiveTrie', 'configArchiveLogTrie'])(
    '%s ne porte plus aucun chemin sur le commutateur non plus', (champ) => {
      expect(trie(nu(true), champ).enumerateExecutablePaths()).toEqual([]);
    });
});

const REGLAGES: ReadonlyArray<readonly [readonly string[], string]> = [
  [APPLET, 'description un essai'],
  [APPLET, 'event syslog pattern "%LINK"'],
  [APPLET, 'event timer watchdog time 60'],
  [APPLET, 'event timer cron cron-entry "0 2 * * *"'],
  [APPLET, 'event none'],
  [APPLET, 'event cli pattern "reload"'],
  [APPLET, 'event snmp oid 1.3.6.1 get-type exact entry-val 5'],
  [APPLET, 'action 1.0 syslog msg "coucou"'],
  [APPLET, 'action 1.0 syslog priority warnings msg "attention"'],
  [APPLET, 'action 1.0 cli command "show clock"'],
  [APPLET, 'action 2.0 wait 5'],
  [APPLET, 'notify syslog contenttype xml'],
  [EXPORTEUR, 'destination 10.0.0.9'],
  [EXPORTEUR, 'source GigabitEthernet0/0'],
  [EXPORTEUR, 'transport udp 2055'],
  [EXPORTEUR, 'export-protocol netflow-v9'],
  [EXPORTEUR, 'template data timeout 60'],
  [ENREGISTREMENT, 'match ipv4 source address'],
  [ENREGISTREMENT, 'collect counter bytes'],
  [MONITEUR, 'record REC'],
  [MONITEUR, 'exporter EXP'],
  [MONITEUR, 'cache timeout active 60'],
  [MONITEUR, 'cache timeout inactive 15'],
  [MONITEUR, 'cache entries 4096'],
  [ARCHIVE, 'path flash:cfg'],
  [ARCHIVE, 'time-period 1440'],
  [ARCHIVE, 'maximum 5'],
  [ARCHIVE, 'write-memory'],
  [ARCHIVE, 'no write-memory'],
  [ARCHIVE_LOG, 'logging size 100'],
  [ARCHIVE_LOG, 'logging enable'],
  [ARCHIVE_LOG, 'logging disable'],
  [ARCHIVE_LOG, 'hidekeys'],
  [ARCHIVE_LOG, 'no hidekeys'],
  [ARCHIVE_LOG, 'notify syslog contenttype xml'],
];

describe('chaque reglage reste accepte apres la migration', () => {
  it.each(REGLAGES)('%s › `%s`', async (entree, commande) => {
    expect(await (await dans(entree)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('l\'archive du commutateur est la MEME que celle du routeur', () => {
  it.each([
    'path flash:cfg', 'time-period 1440', 'maximum 5', 'write-memory',
  ])('`%s` est accepte sur le commutateur', async (commande) => {
    expect(await (await dans(ARCHIVE, true)).executeCommand(commande))
      .not.toContain('Invalid input');
  });

  it('les deux plateformes decrivent `maximum` avec les memes mots', async () => {
    const routeur = (await dans(ARCHIVE)).cliHelp('maximum ');
    const commutateur = (await dans(ARCHIVE, true)).cliHelp('maximum ');
    expect(routeur).toContain('<1-14>');
    expect(commutateur).toBe(routeur);
  });
});

describe('l\'applet et l\'archive atteignent leur moteur', () => {
  it('l\'applet garde sa description et son action', async () => {
    const device = await dans(APPLET);
    await device.executeCommand('description un essai');
    await device.executeCommand('action 1.0 syslog msg "coucou"');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show event manager policy registered');
    expect(vue).toContain('TEST');
  });

  it('le chemin d\'archive ressort dans la configuration', async () => {
    const device = await dans(ARCHIVE);
    await device.executeCommand('path flash:cfg');
    await device.executeCommand('maximum 5');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show running-config');
    expect(vue).toContain('path flash:cfg');
    expect(vue).toContain('maximum 5');
  });
});

describe('`?` nomme la place au lieu d\'un mot muet', () => {
  const ATTENDU: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [APPLET, 'description ', 'LINE'],
    [APPLET, 'action ', 'Label that orders the actions'],
    [APPLET, 'event syslog ', 'Regular expression the message must match'],
    [EXPORTEUR, 'destination ', 'A.B.C.D'],
    [EXPORTEUR, 'source ', 'IFACE'],
    [EXPORTEUR, 'transport udp ', '<1-65535>'],
    [EXPORTEUR, 'export-protocol ', 'IPFIX (RFC 7011)'],
    [ENREGISTREMENT, 'match ', 'Key field that identifies a flow'],
    [ENREGISTREMENT, 'collect ', 'Non-key field the record gathers'],
    [MONITEUR, 'record ', 'Name of the flow record'],
    [MONITEUR, 'cache entries ', '<16-1000000>'],
    [ARCHIVE, 'time-period ', '<1-525600>'],
    [ARCHIVE, 'maximum ', '<1-14>'],
    [ARCHIVE_LOG, 'logging size ', '<1-1000>'],
    [ARCHIVE_LOG, 'notify syslog contenttype ', 'XML notification'],
  ];

  it.each(ATTENDU)('%s › `%s?` annonce %s', async (entree, saisie, attendu) => {
    expect((await dans(entree)).cliHelp(saisie)).toContain(attendu);
  });

  it('un protocole d\'export inconnu est refuse au caret', async () => {
    expect(await (await dans(EXPORTEUR)).executeCommand('export-protocol sflow'))
      .toContain('Invalid input detected');
  });

  it('un nombre de revisions hors bornes est refuse au caret', async () => {
    expect(await (await dans(ARCHIVE)).executeCommand('maximum 99'))
      .toContain('Invalid input detected');
  });
});

describe('un noeud intermediaire porte son propre nom', () => {
  const LIBELLES: ReadonlyArray<readonly [readonly string[], string]> = [
    [APPLET, 'Event that triggers the applet'],
    [APPLET, 'Notification sent when the applet runs'],
    [EXPORTEUR, 'Transport the exporter uses'],
    [MONITEUR, 'Flow cache parameters'],
    [ARCHIVE, 'Configuration change logging'],
    [ARCHIVE_LOG, 'Archive log parameters'],
  ];

  it.each(LIBELLES)('%s › `?` ecrit « %s »', async (entree, attendu) => {
    expect((await dans(entree)).cliHelp('')).toContain(attendu);
  });

  it('`event ?` ne propose plus un mot-cle d\'un rang plus bas', async () => {
    const aide = (await dans(APPLET)).cliHelp('event timer ');
    expect(aide).toContain('watchdog');
    expect(aide).not.toContain('cron-entry');
  });

  it('`match` garde son nom de crypto-map la ou il en a un', async () => {
    expect((await dans(['crypto map CM 10 ipsec-isakmp'])).cliHelp(''))
      .toContain('Match values');
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`time-p` se complete dans l\'archive', async () => {
    expect((await dans(ARCHIVE)).cliTabCandidates('time-p'))
      .toEqual(['time-period']);
  });

  it('`cache timeout act` garde ses mots', async () => {
    expect((await dans(MONITEUR)).cliTabCandidates('cache timeout act'))
      .toEqual(['cache timeout active']);
  });
});
