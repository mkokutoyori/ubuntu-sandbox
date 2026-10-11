/**
 * Les ports d'un service Windows sont de vraies ecoutes de la pile : elles s'ouvrent quand le service demarre, au PID
 * du processus qui l'heberge, et se ferment quand il s'arrete ou plante, sans qu'une ligne de table dise autre chose
 * que ce que le reseau repond.
 *
 * Mesure de depart (15f994d0d), un LinuxPC et un WindowsPC cables, session Administrator. `sc stop sshd` retirait la
 * ligne `0.0.0.0:22` de `netstat -ano` et laissait l'ecoute de la pile : `nc -zv 10.0.0.7 22` reussissait, `ssh
 * User@10.0.0.7` obtenait « Permission denied (publickey,password) » d'un serveur arrete. Meme defaut pour
 * `sc stop LanmanServer` : plus de 445 ni de 139 dans `netstat`, une poignee de main TCP qui aboutit puis une
 * fermeture. Apres un `taskkill /F /PID 1088` avec un `sc failure sshd ... restart/1000`, la reprise relancait
 * `sshd.exe` sous le PID 5136 mais `netstat` affichait `LISTENING 1088`, le PID de la table `WINDOWS_SERVICE_LISTENERS`,
 * alors que la pile n'ecoutait plus (`nc` : Connection refused) : un port affiche et injoignable. `Set-Service sshd
 * -StartupType Manual` puis un redemarrage laissait `sc query sshd` a STOPPED, le processus `sshd.exe` dans `tasklist`,
 * l'ecoute dans la pile et la ligne 22 dans `netstat` (le demarrage de la machine ecrivait l'etat des services sans
 * evenement et sans toucher aux processus). Un service heberge par un svchost (`sc stop Themes` puis `sc start Themes`)
 * sortait de `tasklist /svc` et `sc queryex` disait `PID : 0`, le gestionnaire de processus ne reprenant jamais le
 * service ; `LanmanServer.exe`, absent du demarrage suivant, ne revenait pas non plus. Chacun de ces gestes, `sc`, `net`
 * et `Stop-Service`, devait penser a appeler le gestionnaire de processus a la main, apres l'annonce : sept sites pour
 * une seule consequence.
 *
 * Autorites : Microsoft Learn, « Service Control Manager » et `ServiceMain` (le service ouvre ses points d'ecoute en
 * s'executant et les referme en s'arretant, aucun autre acteur ne les tient) ; `netstat -ano` (le PID est celui du
 * processus qui tient la prise) ; la documentation de `sc failure` (l'action `restart` relance le processus du
 * service). Les PID de la table sont ceux de la simulation : la regle est que `netstat`, `tasklist`, `sc queryex` et
 * `Get-NetTCPConnection` lisent la meme table de processus, et que 445 et 139 appartiennent au noyau (PID 4, `System`)
 * comme sur un Windows reel.
 *
 * Ce qui est construit : le gestionnaire de services porte lui-meme l'effet sur le processus (`ServiceProcessHost`,
 * avant l'annonce), par une seule fonction pour le demarrage, l'arret, la reprise apres incident et le demarrage de la
 * machine ; les sept appels manuels (sc, net start, les quatre du fournisseur PowerShell, le tour d'horloge) et les
 * deux rappels (`stopServiceCascade`, `advanceRecoveryTimers`) disparaissent ; `WindowsServicePortProjection` tient des
 * DECLARATIONS d'ecoute (ports, proprietaire, predicat d'activite) et ouvre ou ferme de vraies ecoutes sur `started`,
 * `stopped` et `crashed`, puis a la construction ; le proprietaire est lu dans la table des processus (hote d'un
 * service, ou image `System`) au moment de l'ouverture ; un service heberge par un svchost qui le perd est repris par
 * le svchost qu'il occupait s'il vit encore, par un svchost neuf sinon.
 *
 * Ce qui n'est PAS construit : un service qui n'a jamais eu de processus d'hebergement n'en recoit pas en demarrant
 * (aucun regroupement `svchost -k` n'existe pour dire dans lequel le mettre) ; l'ecoute du 22 suit le seul port 22 (le
 * `Port` de sshd_config de Windows n'est pas lu) ; une pause de LanmanServer garde l'ecoute et c'est la session SMB qui
 * est refusee.
 *
 * Discrimination (fichier copie sur 15f994d0d) : QUINZE cas sur dix-huit tombent. Les trois autres passent des deux
 * cotes : un TEMOIN (le banc : sshd ecoute au PID de `sshd.exe` et un client l'atteint), une NON-REGRESSION (arreter puis
 * demarrer un service qui ne declare aucune ecoute laisse les ecoutes telles quelles) et une NON-REGRESSION (l'aller et
 * retour de LanmanServer retrouve 445 et 139 au PID 4). Mutations, toutes tuees : pas d'abonnement a `crashed` 1 ; PID
 * constant 1088 6 ; fermeture sans effet 2 ; ouverture sans effet 8 ; LanmanServer au PID de son hote 1 ; pas de
 * reconciliation a la construction 3 ; `started` ignore 6 ; `stopped` ignore 1 ; pas d'effet processus au demarrage 8 et
 * a l'arret 6 ; demarrage de la machine sans transition 2 ; annonce avant l'effet processus 4 ; pas de reprise dans le
 * svchost memorise 1, pas de svchost neuf 2, pas de memoire 1, un incident qui oublie l'hebergement 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

interface Lab {
  readonly linux: LinuxPC;
  readonly windows: WindowsPC;
  reach(port: number): Promise<'open' | 'refused' | 'accepted-then-closed'>;
}

async function lab(): Promise<Lab> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  const windows = new WindowsPC('windows-pc', 'WIN', 100, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, windows.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  return {
    linux, windows,
    reach: async (port) => {
      let opened = false;
      const socket = linux.getTcpStack().connect('10.0.0.7', port, { onOpen: () => { opened = true; } })!;
      await settle();
      if (!opened) return 'refused';
      if (socket.state !== 'established') return 'accepted-then-closed';
      socket.close();
      return 'open';
    },
  };
}

async function listeningPid(windows: WindowsPC, port: number): Promise<number | null> {
  const row = (await windows.executeCommand('netstat -ano')).split('\n')
    .find((line) => new RegExp(`^\\s*TCP\\s+0\\.0\\.0\\.0:${port}\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+\\d+\\s*$`).test(line));
  return row ? Number(row.trim().split(/\s+/).pop()) : null;
}

async function imagePid(windows: WindowsPC, image: string): Promise<number | null> {
  const row = (await windows.executeCommand(`tasklist /FI "IMAGENAME eq ${image}"`)).split('\n')
    .find((line) => line.startsWith(image));
  return row ? Number(row.split(/\s+/)[1]) : null;
}

describe('the bench is sound (witness)', () => {
  it('sshd listens at the PID of sshd.exe and a client reaches it', async () => {
    const { windows, reach } = await lab();
    expect(await imagePid(windows, 'sshd.exe')).toBe(1088);
    expect(await listeningPid(windows, 22)).toBe(1088);
    expect(await reach(22)).toBe('open');
  });

  it('a service that declares no listener leaves the listeners alone', async () => {
    const { windows } = await lab();
    const before = windows.getTcpStack().listListeners().map((listener) => listener.localPort);
    await windows.executeCommand('sc stop Spooler');
    await windows.executeCommand('sc start Spooler');
    expect(windows.getTcpStack().listListeners().map((listener) => listener.localPort)).toEqual(before);
  });
});

describe('a stopped service refuses connections instead of answering', () => {
  it.each([
    ['sc stop sshd'],
    ['net stop sshd'],
    ['powershell -Command "Stop-Service sshd"'],
  ])('%s: port 22 is refused, absent from netstat and from the stack', async (command) => {
    const { windows, reach } = await lab();
    await windows.executeCommand(command);
    await settle();
    expect(await reach(22)).toBe('refused');
    expect(await listeningPid(windows, 22)).toBeNull();
    expect(windows.getTcpStack().listListeners().some((listener) => listener.localPort === 22)).toBe(false);
  });

  it('a real ssh client is told Connection refused by a stopped sshd', async () => {
    const { linux, windows } = await lab();
    await windows.executeCommand('sc stop sshd');
    const out = await linux.executeCommand('ssh -o StrictHostKeyChecking=no -o BatchMode=yes User@10.0.0.7 hostname');
    expect(out).toContain('Connection refused');
  });

  it('sc stop LanmanServer: 445 and 139 are refused and leave netstat', async () => {
    const { windows, reach } = await lab();
    expect(await reach(445)).toBe('open');
    await windows.executeCommand('sc stop LanmanServer');
    await settle();
    expect(await reach(445)).toBe('refused');
    expect(await reach(139)).toBe('refused');
    expect(await listeningPid(windows, 445)).toBeNull();
    expect(await listeningPid(windows, 139)).toBeNull();
  });
});

describe('a started service listens again at the PID of its process', () => {
  it.each([
    ['sc start sshd'],
    ['net start sshd'],
    ['powershell -Command "Start-Service sshd"'],
  ])('%s: netstat, tasklist and Get-NetTCPConnection agree on the new PID', async (command) => {
    const { windows, reach } = await lab();
    await windows.executeCommand('sc stop sshd');
    await windows.executeCommand(command);
    await settle();
    const pid = await imagePid(windows, 'sshd.exe');
    expect(pid).not.toBeNull();
    expect(pid).not.toBe(1088);
    expect(await listeningPid(windows, 22)).toBe(pid);
    const ps = await windows.executeCommand('powershell -Command "Get-NetTCPConnection -State Listen -LocalPort 22 | Format-List OwningProcess"');
    expect(ps).toMatch(new RegExp(`OwningProcess\\s*:\\s*${pid}\\b`));
    expect(await reach(22)).toBe('open');
  });

  it('sc start LanmanServer: 445 and 139 are back at PID 4 and reachable', async () => {
    const { windows, reach } = await lab();
    await windows.executeCommand('sc stop LanmanServer');
    await windows.executeCommand('sc start LanmanServer');
    await settle();
    expect(await listeningPid(windows, 445)).toBe(4);
    expect(await listeningPid(windows, 139)).toBe(4);
    expect(await reach(445)).toBe('open');
    expect(await reach(139)).toBe('open');
  });
});

describe('a service that crashes closes its port, the recovery action opens it at the new PID', () => {
  it('taskkill /F of sshd.exe with restart recovery: refused, then listening at the restarted PID', async () => {
    const { windows, reach } = await lab();
    await windows.executeCommand('sc failure sshd reset= 60 actions= restart/1000');
    await windows.executeCommand('taskkill /F /PID 1088');
    await settle();
    expect(await reach(22)).toBe('refused');
    expect(await listeningPid(windows, 22)).toBeNull();
    windows.advanceTime(5000);
    await settle();
    const pid = await imagePid(windows, 'sshd.exe');
    expect(pid).not.toBeNull();
    expect(pid).not.toBe(1088);
    expect(await listeningPid(windows, 22)).toBe(pid);
    expect(await reach(22)).toBe('open');
  });

  it('the death of the process hosting LanmanServer closes the kernel-owned 445 and 139', async () => {
    const { windows, reach } = await lab();
    const host = await imagePid(windows, 'LanmanServer.exe');
    expect(host).not.toBeNull();
    await windows.executeCommand(`taskkill /F /PID ${host}`);
    await settle();
    expect(await reach(445)).toBe('refused');
    expect(await reach(139)).toBe('refused');
    expect(await listeningPid(windows, 445)).toBeNull();
  });
});

describe('the machine starts its services the way their start type says', () => {
  it('Set-Service sshd -StartupType Manual then a reboot: no process, no listener, no netstat row', async () => {
    const { windows, reach } = await lab();
    await windows.executeCommand('powershell -Command "Set-Service sshd -StartupType Manual"');
    windows.powerOff();
    windows.powerOn();
    windows.setCurrentUser('Administrator');
    expect(await windows.executeCommand('sc query sshd')).toContain('STOPPED');
    expect(await imagePid(windows, 'sshd.exe')).toBeNull();
    expect(await listeningPid(windows, 22)).toBeNull();
    expect(await reach(22)).toBe('refused');
  });

  it('an Automatic service that was stopped by hand comes back at the reboot, listening', async () => {
    const { windows, reach } = await lab();
    await windows.executeCommand('sc stop sshd');
    windows.powerOff();
    windows.powerOn();
    windows.setCurrentUser('Administrator');
    const pid = await imagePid(windows, 'sshd.exe');
    expect(pid).not.toBeNull();
    expect(await listeningPid(windows, 22)).toBe(pid);
    expect(await reach(22)).toBe('open');
  });
});

describe('a service that had a host process is hosted again when it restarts', () => {
  it('sc stop Themes then sc start Themes: sc queryex and tasklist /svc name the same svchost', async () => {
    const { windows } = await lab();
    await windows.executeCommand('sc stop Themes');
    expect(await windows.executeCommand('tasklist /svc /FI "PID eq 964"')).not.toContain('Themes');
    await windows.executeCommand('sc start Themes');
    expect(await windows.executeCommand('sc queryex Themes')).toMatch(/PID\s*:\s*964\b/);
    expect(await windows.executeCommand('tasklist /svc /FI "PID eq 964"')).toContain('Themes');
  });

  it('the svchost that hosted Themes was killed: sc start Themes is hosted by a new svchost', async () => {
    const { windows } = await lab();
    await windows.executeCommand('taskkill /F /PID 964');
    expect(await windows.executeCommand('sc query Themes')).toContain('STOPPED');
    await windows.executeCommand('sc start Themes');
    const pid = /PID\s*:\s*(\d+)/.exec(await windows.executeCommand('sc queryex Themes'))![1];
    expect(Number(pid)).not.toBe(0);
    expect(Number(pid)).not.toBe(964);
    expect(await windows.executeCommand(`tasklist /svc /FI "PID eq ${pid}"`)).toMatch(/svchost\.exe\s+\d+\s+Themes/);
  });

  it('LanmanServer lost its host process with a stop: after the start an svchost hosts it', async () => {
    const { windows } = await lab();
    await windows.executeCommand('sc stop LanmanServer');
    expect(await imagePid(windows, 'LanmanServer.exe')).toBeNull();
    await windows.executeCommand('sc start LanmanServer');
    const pid = /PID\s*:\s*(\d+)/.exec(await windows.executeCommand('sc queryex LanmanServer'))![1];
    expect(Number(pid)).not.toBe(0);
    expect(await windows.executeCommand(`tasklist /svc /FI "PID eq ${pid}"`)).toMatch(/svchost\.exe\s+\d+\s+LanmanServer/);
  });
});
