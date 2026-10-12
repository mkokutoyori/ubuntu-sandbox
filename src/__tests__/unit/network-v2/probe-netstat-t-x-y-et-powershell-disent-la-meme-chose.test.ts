/**
 * `netstat -t`, `-x` et `-y` disent ce que disent les vrais, et PowerShell dit la meme chose : `Get-NetTCPConnection` et
 * `netstat` lisent un seul modele de ligne TCP pour l'etat de delestage (`InHost`, la simulation n'ayant aucun moteur de
 * delestage), le gabarit (`Internet` pour une connexion, rien pour une ecoute) et le proprietaire.
 *
 * Mesure de depart (fa7d49a31) : `netstat -t`, `-x` et `-y` imprimaient le meme tableau que `netstat` ;
 * `Get-NetTCPConnection` donnait `AppliedSetting : Internet` a une ecoute, un `OwningProcess` vide a une connexion en
 * TIME_WAIT que `netstat -o` disait au PID 0, et `RemoteAddress : 0.0.0.0` a une ecoute IPv6, dont l'adresse generique
 * est `::`.
 *
 * Autorites : le texte de `netstat /?` capture sur Windows 10 22H2 (pen2.com) pour `-t` (etat de delestage de la
 * connexion), `-x` (connexions, ecoutes et points d'extremite partages NetworkDirect) et `-y` (gabarit de connexion TCP,
 * sans combinaison avec les autres options) ; l'article de la base de connaissances Microsoft sur `netstat -t` pour la
 * colonne `Offload State` et la valeur `InHost` ; Microsoft Learn (`Get-NetTCPConnection`) pour `AppliedSetting` et
 * `OffloadState`. Non confirme depuis cet environnement : la ligne vide sous l'entete de `-t` et de `-y`, la disposition
 * des colonnes de `-y`, l'espacement de l'entete de `-x` et `AppliedSetting` d'une connexion en TIME_WAIT (la simulation
 * dit `Internet`, comme pour toute connexion).
 *
 * Ce qui est construit : `HOST_OFFLOAD_STATE` et `appliedSettingOf` dans `netTcpConnection.ts`, lus par `WinNetstat.ts`
 * et par `Get-NetTCPConnection` ; `-x` rend l'entete du rapport et aucune ligne, la machine n'ayant aucun fournisseur
 * NetworkDirect ; le modele de ligne de PowerShell donne le PID 0 a une prise sans proprietaire et l'adresse generique
 * de sa famille a une ecoute.
 *
 * Discrimination (fichier copie sur fa7d49a31) : HUIT cas sur douze tombent. Les quatre autres passent des deux cotes :
 * le temoin et trois non-regressions (une extremite UDP n'a pas d'etat de delestage ; PowerShell disait deja `InHost`
 * pour le meme nombre de connexions ; sans `-a`, `-y` ne liste pas les ecoutes). Mutations, toutes tuees (11) : colonne
 * de delestage perdue 1, extremite UDP avec un etat de delestage 1, colonne de gabarit perdue 2, `-y` qui liste l'UDP 1,
 * sans ligne vide sous l'entete 2, `-x` ignore 1, ecoute avec un gabarit 2, PID vide pour une prise sans proprietaire 1,
 * ecoute IPv6 avec l'adresse generique IPv4 1, gabarit constant 1, etat de delestage autre que celui de `netstat` 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

interface Bench {
  readonly linux: LinuxPC;
  readonly win: WindowsPC;
}

async function bench(): Promise<Bench> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const win = new WindowsPC('windows-pc', 'WIN', 100, 0);
  linux.powerOn();
  win.powerOn();
  win.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, win.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await win.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  return { linux, win };
}

async function withConnections(lab: Bench): Promise<() => void> {
  const established = lab.linux.getTcpStack().connect('10.0.0.7', 445, {})!;
  const closing = lab.win.getTcpStack().connect('10.0.0.3', 22, {})!;
  await settle();
  closing.close();
  await settle();
  return () => established.close();
}

const dataRows = (output: string) => output.split('\n').filter((line) => /^\s*(TCP|UDP)\s/.test(line));

const cellsOf = (row: string) => row.trim().split(/\s+/);

const powershell = async (win: WindowsPC, line: string) => (await PowerShellSubShell.create(win).subShell.processLine(line)).output.join('\n');

describe('the bench is sound (witness)', () => {
  it('-ano lists the established connection, the closed one and the listeners', async () => {
    const lab = await bench();
    const release = await withConnections(lab);
    const states = dataRows(await lab.win.executeCommand('netstat -ano')).map((row) => cellsOf(row)[3]);
    expect(states).toEqual(expect.arrayContaining(['LISTENING', 'ESTABLISHED', 'TIME_WAIT']));
    release();
  });
});

describe('netstat -t adds the offload state of each connection', () => {
  it('has an Offload State column, a blank line under the header, and InHost on every TCP row', async () => {
    const lab = await bench();
    const release = await withConnections(lab);
    const lines = (await lab.win.executeCommand('netstat -ta')).split('\n');
    expect(lines.slice(0, 5)).toEqual([
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           Offload State',
      '',
    ]);
    const tcp = dataRows(lines.join('\n')).filter((row) => /^\s*TCP/.test(row));
    expect(tcp.length).toBeGreaterThan(3);
    expect(tcp.every((row) => cellsOf(row).at(-1) === 'InHost')).toBe(true);
    release();
  });

  it('a UDP endpoint has no offload state', async () => {
    const { win } = await bench();
    const udp = dataRows(await win.executeCommand('netstat -ta')).filter((row) => /^\s*UDP/.test(row));
    expect(udp.length).toBeGreaterThan(0);
    expect(udp.every((row) => cellsOf(row).at(-1) === '*:*')).toBe(true);
  });

  it('Get-NetTCPConnection says InHost for the same connections', async () => {
    const lab = await bench();
    const release = await withConnections(lab);
    const tcpRows = dataRows(await lab.win.executeCommand('netstat -ta')).filter((row) => /^\s*TCP/.test(row)).length;
    expect(Number((await powershell(lab.win, '(Get-NetTCPConnection -OffloadState InHost).Count')).trim())).toBe(tcpRows);
    release();
  });
});

describe('netstat -y adds the template of each TCP connection', () => {
  it('has a Template column, a blank line under the header, and no UDP row even with -a', async () => {
    const lab = await bench();
    const release = await withConnections(lab);
    const output = await lab.win.executeCommand('netstat -ay');
    expect(output.split('\n').slice(0, 5)).toEqual([
      '',
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           Template',
      '',
    ]);
    expect(dataRows(output).every((row) => /^\s*TCP/.test(row))).toBe(true);
    release();
  });

  it('a connection has the Internet template and a listener has none', async () => {
    const lab = await bench();
    const release = await withConnections(lab);
    const rows = dataRows(await lab.win.executeCommand('netstat -ay'));
    const byState = (state: string) => rows.filter((row) => cellsOf(row).includes(state));
    expect(byState('ESTABLISHED').map((row) => cellsOf(row).at(-1))).toEqual(['Internet']);
    expect(byState('TIME_WAIT').map((row) => cellsOf(row).at(-1))).toEqual(['Internet']);
    expect(byState('LISTENING').length).toBeGreaterThan(0);
    expect(byState('LISTENING').every((row) => cellsOf(row).at(-1) === 'LISTENING')).toBe(true);
    release();
  });

  it('without -a the listeners are not listed', async () => {
    const lab = await bench();
    const release = await withConnections(lab);
    expect(dataRows(await lab.win.executeCommand('netstat -y')).some((row) => /LISTENING/.test(row))).toBe(false);
    release();
  });

  it('-y cannot be combined with -t', async () => {
    const { win } = await bench();
    expect(await win.executeCommand('netstat -y -t')).toContain('NETSTAT [-a]');
  });
});

describe('PowerShell and netstat give the same template and the same owner', () => {
  it('Get-NetTCPConnection shows the Internet template for the connection and none for the listener', async () => {
    const lab = await bench();
    const release = await withConnections(lab);
    expect(await powershell(lab.win, 'Get-NetTCPConnection -State Established | Format-List AppliedSetting')).toMatch(/AppliedSetting\s*:\s*Internet/);
    const listener = await powershell(lab.win, 'Get-NetTCPConnection -LocalPort 22 -State Listen | Format-List AppliedSetting');
    expect(listener).toMatch(/AppliedSetting\s*:\s*$/m);
    expect(listener).not.toContain('Internet');
    release();
  });

  it('a connection in TIME_WAIT belongs to process 0 for both', async () => {
    const lab = await bench();
    const release = await withConnections(lab);
    expect(cellsOf(dataRows(await lab.win.executeCommand('netstat -ano')).find((row) => /TIME_WAIT/.test(row))!).at(-1)).toBe('0');
    expect(await powershell(lab.win, 'Get-NetTCPConnection -State TimeWait | Format-List OwningProcess')).toMatch(/OwningProcess\s*:\s*0\s*$/m);
    release();
  });

  it('the remote address of an IPv6 listener is the IPv6 wildcard', async () => {
    const { win } = await bench();
    win.getTcpStack().listen(7200, { onAccept: () => undefined }, '::');
    expect(await powershell(win, 'Get-NetTCPConnection -LocalPort 7200 | Format-List RemoteAddress')).toMatch(/RemoteAddress\s*:\s*::\s*$/m);
  });
});

describe('netstat -x lists the NetworkDirect endpoints', () => {
  it('a machine without a NetworkDirect provider has none, and says so with the header of the real report', async () => {
    const { win } = await bench();
    const lines = (await win.executeCommand('netstat -x')).split('\n');
    expect(lines.slice(0, 3)).toEqual(['', 'Active NetworkDirect Connections, Listeners, SharedEndpoints', '']);
    expect(lines[3]).toMatch(/^ {2}Mode\s+IfIndex\s+Type\s+Local Address\s+Foreign Address\s+PID$/);
    expect(dataRows(lines.join('\n'))).toEqual([]);
  });
});
