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

const CMAP = ['class-map CM'];
const PMAP = ['policy-map PM'];
const PMAP_C = ['policy-map PM', 'class C1'];
const CP = ['control-plane'];
const ZONE = ['zone security Z1'];
const ZONE_PAIR = [
  'zone security Z1', 'exit', 'zone security Z2', 'exit',
  'zone-pair security ZP source Z1 destination Z2',
];
const TIME_RANGE = ['time-range TR'];
const RADIUS = ['radius server RS'];
const TACACS = ['tacacs server TS'];
const AAA_GROUP = ['aaa new-model', 'aaa group server tacacs+ G1'];
const TRUSTPOINT = ['crypto pki trustpoint TP'];

describe('les onze arbres de sous-mode de securite sont VIDES', () => {
  it.each([
    'configCmapTrie', 'configPmapTrie', 'configPmapClassTrie', 'configCpTrie',
    'configZoneTrie', 'configZonePairTrie', 'configTimeRangeTrie',
    'configRadiusServerTrie', 'configTacacsServerTrie', 'configAaaGroupTrie',
    'configCaTrustpointTrie',
  ])('%s ne porte plus aucun chemin sur le routeur', (champ) => {
    expect(trie(nu(), champ).enumerateExecutablePaths()).toEqual([]);
  });

  it.each(['configRadiusServerTrie', 'configTacacsServerTrie', 'configAaaGroupTrie'])(
    '%s ne porte plus aucun chemin sur le commutateur non plus', (champ) => {
      expect(trie(nu(true), champ).enumerateExecutablePaths()).toEqual([]);
    });
});

const REGLAGES: ReadonlyArray<readonly [readonly string[], string]> = [
  [CMAP, 'match any'],
  [CMAP, 'match access-group 101'],
  [CMAP, 'match access-group name BLOQUE'],
  [CMAP, 'match protocol http'],
  [PMAP, 'class C1'],
  [PMAP, 'class class-default'],
  [PMAP, 'class type inspect C2'],
  [PMAP_C, 'police 8000'],
  [PMAP_C, 'inspect'],
  [PMAP_C, 'drop'],
  [PMAP_C, 'pass'],
  [PMAP_C, 'set dscp ef'],
  [PMAP_C, 'set dscp 46'],
  [PMAP_C, 'set precedence 5'],
  [PMAP_C, 'set precedence critical'],
  [PMAP_C, 'priority 1000'],
  [PMAP_C, 'bandwidth 2000'],
  [PMAP_C, 'fair-queue'],
  [PMAP_C, 'random-detect dscp-based'],
  [PMAP_C, 'shape average 100000'],
  [PMAP_C, 'service-policy ENFANT'],
  [PMAP_C, 'queue-limit 64'],
  [PMAP_C, 'compression header ip'],
  [CP, 'service-policy input PM'],
  [CP, 'service-policy output PM'],
  [ZONE, 'description la zone interne'],
  [ZONE_PAIR, 'service-policy type inspect PM'],
  [TIME_RANGE, 'periodic weekdays 08:00 to 18:00'],
  [TIME_RANGE, 'absolute start 08:00 1 January 2026 end 18:00 31 January 2026'],
  [RADIUS, 'address ipv4 10.0.0.9 auth-port 1812 acct-port 1813'],
  [RADIUS, 'key SecretRadius'],
  [TACACS, 'address ipv4 10.0.0.8'],
  [TACACS, 'key SecretTacacs'],
  [TACACS, 'port 49'],
  [TACACS, 'timeout 10'],
  [AAA_GROUP, 'server name TS'],
  [AAA_GROUP, 'server 10.0.0.8'],
  [TRUSTPOINT, 'enrollment terminal'],
  [TRUSTPOINT, 'enrollment url http://ca.example.com'],
  [TRUSTPOINT, 'enrollment selfsigned'],
  [TRUSTPOINT, 'subject-name CN=r1.example.com'],
  [TRUSTPOINT, 'revocation-check none'],
  [TRUSTPOINT, 'rsakeypair MACLE'],
  [TRUSTPOINT, 'fqdn r1.example.com'],
  [TRUSTPOINT, 'ip-address 10.0.0.1'],
  [TRUSTPOINT, 'serial-number none'],
  [TRUSTPOINT, 'auto-enroll 70'],
  [TRUSTPOINT, 'auto-enroll 70 regenerate'],
  [TRUSTPOINT, 'fingerprint ABCD1234'],
];

describe('chaque reglage reste accepte apres la migration', () => {
  it.each(REGLAGES)('%s › `%s`', async (entree, commande) => {
    expect(await (await dans(entree)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('les sous-modes d\'identite sont les MEMES sur les deux plateformes', () => {
  it.each([
    [RADIUS, 'address ipv4 10.0.0.9'],
    [TACACS, 'key SecretTacacs'],
    [AAA_GROUP, 'server name TS'],
  ] as ReadonlyArray<readonly [readonly string[], string]>)(
    '%s › `%s` est accepte sur le commutateur', async (entree, commande) => {
      expect(await (await dans(entree, true)).executeCommand(commande))
        .not.toContain('Invalid input');
    });

  it('les deux plateformes decrivent `timeout` avec les memes mots', async () => {
    const routeur = (await dans(TACACS)).cliHelp('timeout ');
    const commutateur = (await dans(TACACS, true)).cliHelp('timeout ');
    expect(routeur).toContain('<1-1000>');
    expect(commutateur).toBe(routeur);
  });
});

describe('le reglage atteint son moteur', () => {
  it('la classe garde ses criteres', async () => {
    const device = await dans(CMAP);
    await device.executeCommand('match protocol http');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config')).toContain('match protocol http');
  });

  it('le serveur TACACS+ garde son adresse et sa cle', async () => {
    const device = await dans(TACACS);
    await device.executeCommand('address ipv4 10.0.0.8');
    await device.executeCommand('key SecretTacacs');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show running-config');
    expect(vue).toContain('10.0.0.8');
    expect(vue).toContain('SecretTacacs');
  });

  it('le groupe AAA garde son membre declare a l\'ancienne', async () => {
    const device = await dans(AAA_GROUP);
    await device.executeCommand('server 10.0.0.8');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config')).toContain('10.0.0.8');
  });

  it('`no server` retire le membre qu\'il nomme', async () => {
    const device = await dans(AAA_GROUP);
    await device.executeCommand('server name TS');
    await device.executeCommand('no server name TS');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config')).not.toContain('server name TS');
  });

  it('le point de confiance garde sa methode de revocation', async () => {
    const device = await dans(TRUSTPOINT);
    await device.executeCommand('enrollment terminal');
    await device.executeCommand('revocation-check none');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show running-config');
    expect(vue).toContain('enrollment terminal');
    expect(vue).toContain('revocation-check none');
  });
});

describe('`?` nomme la place au lieu d\'un mot muet', () => {
  const ATTENDU: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [CMAP, 'match ', 'Access group'],
    [CMAP, 'match access-group ', '<1-2799>'],
    [CMAP, 'match protocol ', 'Protocol name'],
    [PMAP, 'class ', 'System default class matching otherwise unclassified packets'],
    [PMAP_C, 'set dscp ', 'Match packets with EF dscp (101110)'],
    [PMAP_C, 'set precedence ', 'Match packets with critical precedence (5)'],
    [PMAP_C, 'service-policy ', 'Name of the nested policy map'],
    [CP, 'service-policy ', 'Assign a policy map to the input of the control plane'],
    [ZONE, 'description ', 'LINE'],
    [ZONE_PAIR, 'service-policy ', 'Type of the service policy'],
    [TIME_RANGE, 'periodic ', 'Monday through Friday'],
    [TIME_RANGE, 'absolute ', 'Time the range starts'],
    [RADIUS, 'address ', 'IPv4 address of the RADIUS server'],
    [RADIUS, 'address ipv4 ', 'A.B.C.D'],
    [RADIUS, 'key ', 'The shared key itself'],
    [TACACS, 'port ', '<1-65535>'],
    [TACACS, 'timeout ', 'Wait time in seconds'],
    [AAA_GROUP, 'server ', 'Name of a server declared by `tacacs server`'],
    [TRUSTPOINT, 'enrollment ', 'Enrollment URL of the certification authority'],
    [TRUSTPOINT, 'revocation-check ', 'Online Certificate Status Protocol'],
    [TRUSTPOINT, 'rsakeypair ', 'Name of the RSA key pair to bind'],
    [TRUSTPOINT, 'serial-number ', 'Do not include a serial number'],
  ];

  it.each(ATTENDU)('%s › `%s?` annonce %s', async (entree, saisie, attendu) => {
    expect((await dans(entree)).cliHelp(saisie)).toContain(attendu);
  });

  it('une methode de revocation inconnue est refusee au caret', async () => {
    expect(await (await dans(TRUSTPOINT)).executeCommand('revocation-check kerberos'))
      .toContain('Invalid input detected');
  });

  it('un port TACACS+ hors bornes est refuse au caret', async () => {
    expect(await (await dans(TACACS)).executeCommand('port 70000'))
      .toContain('Invalid input detected');
  });

  it('un point de code DSCP hors bornes est refuse au caret', async () => {
    expect(await (await dans(PMAP_C)).executeCommand('set dscp 64'))
      .toContain('Invalid input detected');
  });
});

describe('une legende suit le MODE, elle ne le traverse pas', () => {
  it('`match` se decrit autrement sous une classe et sous une crypto-map', async () => {
    expect((await dans(CMAP)).cliHelp('')).toContain('Match criteria');
    expect((await dans(['crypto map CM 10 ipsec-isakmp'])).cliHelp(''))
      .toContain('Match values');
  });

  it('`service-policy` se decrit dans les trois modes qui le portent', async () => {
    for (const entree of [CP, ZONE_PAIR, PMAP_C]) {
      expect((await dans(entree)).cliHelp('')).toContain('service-policy');
    }
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`revoc` se complete dans le point de confiance', async () => {
    expect((await dans(TRUSTPOINT)).cliTabCandidates('revoc'))
      .toEqual(['revocation-check']);
  });

  it('`address ip` garde son mot dans le serveur RADIUS', async () => {
    expect((await dans(RADIUS)).cliTabCandidates('address ip'))
      .toEqual(['address ipv4']);
  });
});
