/**
 * PRD-NTP-Tutoriel.md §5 / lot N4 — les labs NTP Windows du tutoriel
 * (§6, W32Time), reproduits.
 *
 * `w32tm` etait un talon d'une seule branche : toute sous-commande
 * autre que `/query /status` renvoyait **la chaine litterale
 * `w32tm /query /status`**.
 *
 *     C:\> w32tm /query /peers
 *     w32tm /query /status
 *     C:\> w32tm /resync /force
 *     w32tm /query /status
 *
 * Et `/query /status` lui-meme etait un bloc fixe de quatre lignes :
 * `Stratum: 3` ecrit en dur sur une machine qui n'interrogeait personne,
 * et `Source` valant le PDC du domaine quoi qu'ait configure
 * l'operateur — donc `w32tm /config /manualpeerlist` n'avait aucun
 * effet observable. `Get-TimeZone`/`Set-TimeZone` n'existaient ni en
 * cmd ni en PowerShell.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/** Le serveur NTP du tutoriel, en 192.168.100.5. */
async function serveur() {
  const r = new CiscoRouter(`SRV${++serie}`);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.100.5 255.255.255.0', 'no shutdown', 'exit',
    'ntp master 2', 'end']) await r.executeCommand(c);
  return r;
}

/** Un poste Windows cable au serveur. */
async function poste(srv: CiscoRouter) {
  const pc = new WindowsPC(`W${++serie}`);
  new Cable(`n${serie}`).connect(srv.getPort('GigabitEthernet0/0')!, pc.getPorts()[0]);
  await pc.executeCommand(
    'netsh interface ip set address "Ethernet0" static 192.168.100.9 255.255.255.0');
  return pc;
}

const CONFIG = 'w32tm /config /manualpeerlist:"192.168.100.5,0x8" '
  + '/syncfromflags:manual /reliable:YES /update';

const ligne = (s: string, debut: string) =>
  s.split('\n').find((l) => l.trim().startsWith(debut))?.trim() ?? '';

describe('§6.2 — le PDC Emulator se configure, et ca se voit', () => {
  it('avant configuration, la machine ne pretend pas etre synchronisee', async () => {
    // `Stratum: 3` etait ecrit en dur sur une machine qui n'interrogeait
    // personne.
    const pc = new WindowsPC(`W${++serie}`);
    const st = await pc.executeCommand('w32tm /query /status');
    expect(ligne(st, 'Stratum')).toBe('Stratum: 0 (unspecified)');
    expect(ligne(st, 'Source')).toBe('Source: Local CMOS Clock');
  });

  it('`/config ... /update` fait vraiment interroger le serveur', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    expect(await pc.executeCommand(CONFIG)).toContain('The command completed successfully');
    const st = await pc.executeCommand('w32tm /query /status');
    expect(ligne(st, 'Stratum')).toContain('Stratum: 3');
    expect(ligne(st, 'Source')).toBe('Source: 192.168.100.5');
    expect(ligne(st, 'ReferenceId')).toContain('(source IP:  192.168.100.5)');
  });

  it('`/config` SANS `/update` enregistre sans appliquer', async () => {
    // C'est la raison d'etre du drapeau : l'ignorer ferait croire qu'un
    // `w32tm /config` sans `/update` a pris effet.
    const srv = await serveur();
    const pc = await poste(srv);
    await pc.executeCommand(
      'w32tm /config /manualpeerlist:"192.168.100.5,0x8" /syncfromflags:manual');
    expect(ligne(await pc.executeCommand('w32tm /query /status'), 'Stratum'))
      .toBe('Stratum: 0 (unspecified)');
    await pc.executeCommand('w32tm /config /update');
    expect(ligne(await pc.executeCommand('w32tm /query /status'), 'Stratum'))
      .toContain('Stratum: 3');
  });
});

describe('§6.3 — chaque `/query` est une vue distincte', () => {
  async function labo() {
    const srv = await serveur();
    const pc = await poste(srv);
    await pc.executeCommand(CONFIG);
    return pc;
  }

  it('les quatre formes ne se repetent pas', async () => {
    // Elles rendaient TOUTES la chaine `w32tm /query /status`.
    const pc = await labo();
    const vues = await Promise.all(['/status', '/peers', '/configuration', '/source']
      .map((q) => pc.executeCommand(`w32tm /query ${q}`)));
    expect(new Set(vues).size).toBe(4);
    for (const v of vues) expect(v).not.toBe('w32tm /query /status');
  });

  it('`/query /peers` decrit le pair configure', async () => {
    const pc = await labo();
    const p = await pc.executeCommand('w32tm /query /peers');
    expect(p).toContain('#Peers: 1');
    expect(ligne(p, 'Peer:')).toBe('Peer: 192.168.100.5,0x8');
    expect(ligne(p, 'State:')).toBe('State: Active');
    expect(ligne(p, 'Mode:')).toBe('Mode: 3 (Client)');
    expect(ligne(p, 'Stratum:')).toContain('Stratum: 2');
  });

  it('`/query /configuration` rend la liste et le type', async () => {
    const pc = await labo();
    const c = await pc.executeCommand('w32tm /query /configuration');
    expect(c).toContain('[TimeProviders]');
    expect(ligne(c, 'NtpServer:')).toBe('NtpServer: 192.168.100.5,0x8 (Local)');
    expect(ligne(c, 'Type:')).toBe('Type: NTP (Local)');
  });

  it('sans pair configure, `/peers` le dit', async () => {
    const pc = new WindowsPC(`W${++serie}`);
    expect(await pc.executeCommand('w32tm /query /peers')).toBe('#Peers: 0');
  });
});

describe('§6.3 — `/resync` et `/stripchart` mesurent', () => {
  it('`/resync` sans aucune source echoue en le disant', async () => {
    // Le vrai message, et il est utile : il dit que la machine n'a
    // aucune source, pas que le reseau a echoue.
    const pc = new WindowsPC(`W${++serie}`);
    const r = await pc.executeCommand('w32tm /resync /force');
    expect(r).toContain('no time data was available');
    expect(r).toContain('The command failed to complete successfully');
  });

  it('`/resync` avec une source aboutit', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    await pc.executeCommand(CONFIG);
    expect(await pc.executeCommand('w32tm /resync /force'))
      .toContain('The command completed successfully');
  });

  it('`/stripchart` rend autant d\'echantillons que demande', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    const out = await pc.executeCommand(
      'w32tm /stripchart /computer:192.168.100.5 /samples:3');
    expect(out).toContain('Tracking 192.168.100.5 [192.168.100.5:123].');
    expect(out).toContain('Collecting 3 samples.');
    // Chaque echantillon porte un ecart signe, comme le tutoriel le
    // montre — et c'est une VRAIE interrogation, pas une suite de
    // nombres plausibles.
    const mesures = out.split('\n').filter((l) => /^\d\d:\d\d:\d\d, [+-]/.test(l));
    expect(mesures).toHaveLength(3);
  });

  it('`/stripchart` vers une cible muette rend l\'erreur du vrai outil', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    const out = await pc.executeCommand(
      'w32tm /stripchart /computer:192.168.100.77 /samples:2');
    expect(out).toContain('error: 0x800705B4');
  });

  it('`/stripchart` ne laisse pas de pair derriere lui', async () => {
    // Il mesure, il ne configure pas : la cible ne doit pas apparaitre
    // dans `/query /peers` apres coup.
    const srv = await serveur();
    const pc = await poste(srv);
    await pc.executeCommand('w32tm /stripchart /computer:192.168.100.5 /samples:2');
    expect(await pc.executeCommand('w32tm /query /peers')).toBe('#Peers: 0');
  });
});

describe('§6.2 — les drapeaux choisissent vraiment le mode', () => {
  it('`0x1` cree un pair symetrique, `0x8` un client', async () => {
    const srv = await serveur();
    const pc = await poste(srv);
    await pc.executeCommand('w32tm /config /manualpeerlist:"192.168.100.5,0x1" '
      + '/syncfromflags:manual /update');
    expect(ligne(await pc.executeCommand('w32tm /query /peers'), 'Mode:'))
      .toBe('Mode: 1 (Symmetric Active)');
    await pc.executeCommand(CONFIG);
    expect(ligne(await pc.executeCommand('w32tm /query /peers'), 'Mode:'))
      .toBe('Mode: 3 (Client)');
  });

  it('un drapeau que ce simulateur ne sert pas est REFUSE', async () => {
    // `0x2` est le mode broadcast : ce simulateur n'en a pas, et
    // l'accepter ferait croire a une ecoute qui n'existe pas.
    const pc = new WindowsPC(`W${++serie}`);
    const out = await pc.executeCommand(
      'w32tm /config /manualpeerlist:"1.2.3.4,0x2" /update');
    expect(out).toContain('The following flag is not supported: 0x2');
    expect(out).toContain('The command failed to complete successfully');
  });

  it('`/syncfromflags:manual` est ce qui fait lire la liste manuelle', async () => {
    // C'est la regle du §6.1 : une machine en `domhier` suit la
    // hierarchie du domaine et IGNORE la liste manuelle.
    const srv = await serveur();
    const pc = await poste(srv);
    await pc.executeCommand(
      'w32tm /config /manualpeerlist:"192.168.100.5,0x8" /syncfromflags:domhier /update');
    expect(ligne(await pc.executeCommand('w32tm /query /status'), 'Stratum'))
      .toBe('Stratum: 0 (unspecified)');
    await pc.executeCommand(CONFIG);
    expect(ligne(await pc.executeCommand('w32tm /query /status'), 'Stratum'))
      .toContain('Stratum: 3');
  });

  it('un `syncfromflags` inconnu est refuse', async () => {
    const pc = new WindowsPC(`W${++serie}`);
    expect(await pc.executeCommand('w32tm /config /syncfromflags:zzz /update'))
      .toContain('The parameter is incorrect');
  });

  it('une sous-commande inconnue rend l\'aide, pas une autre commande', async () => {
    const pc = new WindowsPC(`W${++serie}`);
    const out = await pc.executeCommand('w32tm /zzz');
    expect(out).toContain('/stripchart /computer:<target>');
    expect(out).not.toBe('w32tm /query /status');
  });
});

describe('§6.3 — le fuseau horaire', () => {
  it('`Get-TimeZone` existe et decrit le fuseau courant', async () => {
    // L'applet n'existait ni en cmd ni en PowerShell.
    const pc = new WindowsPC(`W${++serie}`);
    const out = await pc.executeCommand('powershell -c "Get-TimeZone"');
    expect(out).not.toContain('not recognized');
    expect(out).toContain('Id                         : UTC');
  });

  it('`Set-TimeZone` change vraiment le fuseau', async () => {
    const pc = new WindowsPC(`W${++serie}`);
    await pc.executeCommand(
      'powershell -c "Set-TimeZone -Id \'W. Central Africa Standard Time\'"');
    const out = await pc.executeCommand('powershell -c "Get-TimeZone"');
    expect(out).toContain('W. Central Africa Standard Time');
    expect(out).toContain('(UTC+01:00) West Central Africa');
  });

  it('un identifiant inconnu est refuse', async () => {
    const pc = new WindowsPC(`W${++serie}`);
    const out = await pc.executeCommand('powershell -c "Set-TimeZone -Id \'Mars/Olympus\'"');
    expect(out).toContain('Cannot find the time zone');
    expect(await pc.executeCommand('powershell -c "Get-TimeZone"')).toContain(': UTC');
  });

  it('`-ListAvailable` rend la liste', async () => {
    const pc = new WindowsPC(`W${++serie}`);
    const out = await pc.executeCommand('powershell -c "Get-TimeZone -ListAvailable"');
    expect(out).toContain('W. Central Africa Standard Time');
    expect(out).toContain('Eastern Standard Time');
  });

  it('le decalage sort de la MEME table que celle de Linux', async () => {
    // Sans magasin partage, une machine Windows et une machine Linux du
    // meme laboratoire donneraient deux decalages pour `WAT`.
    const pc = new WindowsPC(`W${++serie}`);
    await pc.executeCommand(
      'powershell -c "Set-TimeZone -Id \'W. Central Africa Standard Time\'"');
    expect(pc.getTimezoneStore().timezone).toBe('Africa/Douala');
  });
});

describe('le moteur est le meme sur les trois plateformes', () => {
  it('un Windows et un Cisco branches au meme maitre atteignent la meme strate', async () => {
    const srv = await serveur();
    const win = await poste(srv);
    await win.executeCommand(CONFIG);
    const cisco = new CiscoRouter(`CX${++serie}`);
    new Cable(`x${serie}`).connect(
      srv.getPort('GigabitEthernet0/1')!, cisco.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/1',
      'ip address 192.168.101.5 255.255.255.0', 'no shutdown', 'end']) {
      await srv.executeCommand(c);
    }
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 192.168.101.9 255.255.255.0', 'no shutdown', 'exit',
      'ntp server 192.168.101.5', 'end']) await cisco.executeCommand(c);

    expect(ligne(await win.executeCommand('w32tm /query /status'), 'Stratum'))
      .toContain('Stratum: 3');
    expect(await cisco.executeCommand('show ntp status')).toContain('stratum 3');
  });
});
