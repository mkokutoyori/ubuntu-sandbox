/**
 * Un service de Windows que le vrai tient sur les deux familles d'adresses l'est ici : `sshd` (22), le mappeur de points
 * de terminaison RPC (135), le serveur SMB (445) et WinRM (5985) ouvrent une ecoute `0.0.0.0` ET une ecoute `[::]`, au
 * meme PID, et les ferment ensemble ; les deux repondeurs de noms de lien (mDNS 5353, LLMNR 5355) tiennent une socket UDP
 * par famille, sur Windows comme sur Linux. `netstat`, `Get-NetTCPConnection` et `Get-NetUDPEndpoint` lisent ces lignes.
 * La session NetBIOS (139) reste IPv4 : NetBIOS sur TCP/IP n'existe pas en IPv6.
 *
 * Mesure de depart (a7e9f551f, la sonde sur l'adressage IPv6 venant d'etre fermee) : un Linux relie a un Windows par
 * `fd00::/64` se connecte en IPv6 a 22, 135 et 445 -- par accident, car `findListener` replie une destination IPv6 sur
 * l'ecoute IPv4 -- alors que `netstat -an` ne montre aucune ligne `[::]` et que `netstat -an -p tcpv6` / `-p udpv6` sont
 * vides. Le tableau d'une machine qui accepte des connexions IPv6 sans en avoir l'ecoute se contredit.
 *
 * Autorites : transcript de `netstat -an` d'un Windows 10 (BleepingComputer, fil 712870) : `TCP 0.0.0.0:135` et
 * `TCP [::]:135`, `0.0.0.0:445` et `[::]:445`, `UDP 0.0.0.0:5353`, `[::]:5353`, `0.0.0.0:5355` et `[::]:5355`, les lignes
 * IPv4 d'abord ; Microsoft Q&A « WinRM Listener not bound to IPv4 » : `TCP 0.0.0.0:5985 ... LISTENING 4` et
 * `TCP [::]:5985 ... LISTENING 4` ; Microsoft Q&A « OpenSSH on Windows does not work » : `0.0.0.0:22` et `[::]:22` au
 * meme PID. Pour Linux, `systemd` v249 (`resolved-llmnr.c`, `resolved-mdns.c`) : une socket `AF_INET` et une socket
 * `AF_INET6` (`IPV6_V6ONLY`) liees au joker, port 5355 et 5353. NON sources, donc laissees comme elles sont : RDP (3389),
 * LDAP, Kerberos, NTP, DNS, DHCP (le vrai en tient sans doute aussi une ligne IPv6 ; aucun transcript atteint).
 *
 * Ce qui est construit : `WindowsListenerDeclaration.families`, `TcpStack.wildcardAddressOf` / `IPV4_ONLY` /
 * `DUAL_STACK`, `EndHost.udpBind({ families })` qui pose une ligne par famille et defait les lignes deja posees quand
 * l'une est prise, `EndHost.udpClose(port, famille?)` qui ne libere l'ecouteur que lorsque plus aucune ligne joker ne le
 * tient (le faucheur de processus ferme la ligne du mort, pas celle d'un autre), `bindMulticastDns` qui lie les deux
 * familles quand le protocole a un groupe IPv6.
 *
 * Discrimination (fichier copie sur a7e9f551f) : DIX-HUIT cas sur vingt-cinq tombent. Les sept autres passent des deux
 * cotes : les quatre temoins du banc (les ecoutes IPv4 sont la ; le voisin Linux atteint 22, 135 et 445 en IPv6 ; une
 * vraie session ssh arrive en IPv6 ; un port que personne ne sert est refuse), NetBIOS qui reste IPv4, le temoin d'un
 * `udpBind` sans familles, et le faucheur qui rend les lignes d'un processus mort (equivalent avant, la ligne n'etant
 * alors qu'IPv4 ; le mutant du faucheur qui laisse la ligne IPv6 a la fermeture par adresse le tue). Mutations, toutes
 * tuees (16) : ecoute ouverte en IPv4 seulement 11, fermee en IPv4 seulement 1, ensemble des ports ouverts qui ignore la
 * famille 11, ecoute IPv6 ouverte a l'adresse IPv4 24, `sshd` IPv4 seulement 5, SMB 5, WinRM 1, mappeur RPC 3, NetBIOS
 * en double pile 2 ; `udpBind` qui ignore les familles 6, sans defaire les lignes posees 1 ; `udpClose` qui ignore la
 * famille 1, qui lache toujours l'ecouteur 1 ; faucheur 1 ; mDNS et LLMNR en IPv4 seulement 4 ; le joker IPv6 qui vaut
 * le joker IPv4 24.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { DUAL_STACK } from '@/network/tcp/TcpStack';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

interface Lab {
  readonly linux: LinuxPC;
  readonly windows: WindowsPC;
  reach6(port: number): Promise<'open' | 'refused'>;
  powershell(line: string): Promise<string>;
}

async function lab(windows: WindowsPC = new WindowsServer('SRV', 100, 0)): Promise<Lab> {
  const linux = new LinuxPC('linux-pc', 'LIN', 0, 0);
  linux.powerOn();
  windows.powerOn();
  windows.setCurrentUser('Administrator');
  new Cable('c1').connect(linux.getPort('eth0')!, windows.getPort('eth0')!);
  await linux.executeCommand('ifconfig eth0 10.0.0.3');
  await linux.executeCommand('ip -6 addr add fd00::1/64 dev eth0');
  await windows.executeCommand('netsh interface ip set address "Ethernet0" static 10.0.0.7 255.255.255.0');
  await windows.executeCommand('netsh interface ipv6 add address "Ethernet0" fd00::7/64');
  const shell = PowerShellSubShell.create(windows).subShell;
  return {
    linux,
    windows,
    reach6: async (port) => {
      let opened = false;
      const socket = linux.getTcpStack().connect('fd00::7', port, { onOpen: () => { opened = true; } })!;
      await settle();
      if (opened) socket.close();
      return opened ? 'open' : 'refused';
    },
    powershell: async (line) => (await shell.processLine(line)).output.join('\n').trim(),
  };
}

interface Row { readonly proto: string; readonly local: string; readonly state: string; readonly pid: number | null }

const rowsOf = async (windows: WindowsPC, args: string): Promise<Row[]> =>
  (await windows.executeCommand(`netstat ${args}`)).split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cells) => (cells[0] === 'TCP' || cells[0] === 'UDP') && cells.length >= 3)
    .map((cells) => ({
      proto: cells[0],
      local: cells[1],
      state: cells[0] === 'TCP' ? cells[3] : '',
      pid: /^\d+$/.test(cells[cells.length - 1]) ? Number(cells[cells.length - 1]) : null,
    }));

const listening = (rows: readonly Row[], local: string): Row | undefined =>
  rows.find((row) => row.local === local && (row.proto === 'UDP' || row.state === 'LISTENING'));

describe('the bench is sound (witness)', () => {
  it('the IPv4 listeners are where they were, NetBIOS included', async () => {
    const { windows } = await lab();
    const rows = await rowsOf(windows, '-ano');
    for (const port of [22, 135, 139, 445]) expect(listening(rows, `0.0.0.0:${port}`)).toBeDefined();
  });

  it('the Linux neighbour reaches 22, 135 and 445 over IPv6', async () => {
    const { reach6 } = await lab();
    for (const port of [22, 135, 445]) expect(await reach6(port)).toBe('open');
  });

  it('a real ssh session reaches the Windows host over IPv6', async () => {
    const { linux } = await lab();
    expect(await linux.executeCommand('ssh Administrator@fd00::7 whoami', 'admin\n')).toContain('Administrator');
  });

  it('a port nobody serves is refused over IPv6', async () => {
    const { reach6 } = await lab();
    expect(await reach6(3389)).toBe('refused');
  });
});

describe('the services the real Windows holds on both families', () => {
  it.each([[22], [135], [445]])('port %i has an IPv6 listener beside the IPv4 one, at the same PID', async (port) => {
    const { windows } = await lab();
    const rows = await rowsOf(windows, '-ano');
    const v4 = listening(rows, `0.0.0.0:${port}`);
    const v6 = listening(rows, `[::]:${port}`);
    expect(v6).toBeDefined();
    expect(v6!.pid).toBe(v4!.pid);
    expect(v6!.pid).not.toBe(0);
  });

  it('NetBIOS (139) stays IPv4: the protocol has no IPv6', async () => {
    const { windows } = await lab();
    const rows = await rowsOf(windows, '-ano');
    expect(listening(rows, '[::]:139')).toBeUndefined();
  });

  it('lists the IPv4 rows before the IPv6 ones, as the real tool does', async () => {
    const { windows } = await lab();
    const tcp = (await rowsOf(windows, '-an')).filter((row) => row.proto === 'TCP').map((row) => row.local);
    const lastV4 = Math.max(...tcp.map((local, index) => (local.startsWith('[') ? -1 : index)));
    const firstV6 = tcp.findIndex((local) => local.startsWith('['));
    expect(firstV6).toBeGreaterThan(lastV4);
  });

  it('netstat -p tcpv6 lists exactly those rows', async () => {
    const { windows } = await lab();
    const rows = await rowsOf(windows, '-ano -p tcpv6');
    expect(rows.map((row) => row.local).sort()).toEqual(['[::]:135', '[::]:22', '[::]:445']);
  });

  it('Get-NetTCPConnection lists them too, with the owner of the IPv4 twin', async () => {
    const { powershell } = await lab();
    const table = await powershell('Get-NetTCPConnection -State Listen -LocalPort 445 | Format-Table LocalAddress,LocalPort,OwningProcess');
    const owners = table.split('\n').filter((line) => /\b445\b/.test(line)).map((line) => line.trim().split(/\s+/));
    expect(owners.map((cells) => cells[0]).sort()).toEqual(['0.0.0.0', '::']);
    expect(new Set(owners.map((cells) => cells[2])).size).toBe(1);
  });

  it('WinRM opens 5985 on both families at PID 4 once it is configured', async () => {
    const { windows, reach6 } = await lab();
    expect(listening(await rowsOf(windows, '-ano'), '[::]:5985')).toBeUndefined();
    await windows.executeCommand('winrm quickconfig');
    const rows = await rowsOf(windows, '-ano');
    expect(listening(rows, '0.0.0.0:5985')?.pid).toBe(4);
    expect(listening(rows, '[::]:5985')?.pid).toBe(4);
    expect(await reach6(5985)).toBe('open');
  });
});

describe('a service that stops closes both of its listeners and one that starts opens both', () => {
  it('sshd: Stop-Service takes 22 away from both families and Start-Service brings both back', async () => {
    const { windows, powershell, reach6 } = await lab();
    await powershell('Stop-Service sshd');
    let rows = await rowsOf(windows, '-ano');
    expect(listening(rows, '0.0.0.0:22')).toBeUndefined();
    expect(listening(rows, '[::]:22')).toBeUndefined();
    expect(await reach6(22)).toBe('refused');
    await powershell('Start-Service sshd');
    rows = await rowsOf(windows, '-ano');
    expect(listening(rows, '0.0.0.0:22')).toBeDefined();
    expect(listening(rows, '[::]:22')).toBeDefined();
    expect(await reach6(22)).toBe('open');
  });

  it('LanmanServer: its stop takes 445 away from both families and leaves no IPv6 row at 139', async () => {
    const { windows, powershell } = await lab();
    expect(listening(await rowsOf(windows, '-ano'), '[::]:445')).toBeDefined();
    await powershell('Stop-Service LanmanServer -Force');
    const rows = await rowsOf(windows, '-ano');
    for (const local of ['0.0.0.0:445', '[::]:445', '0.0.0.0:139', '[::]:139']) expect(listening(rows, local)).toBeUndefined();
  });
});

describe('the IPv6 connection meets the IPv6 listener', () => {
  it('the stack of the Windows host holds a :: listener for each dual-stack port', async () => {
    const { windows } = await lab();
    const held = windows.getTcpStack().listListeners().map((listener) => `${listener.localIp}:${listener.localPort}`);
    for (const port of [22, 135, 445]) {
      expect(held).toContain(`0.0.0.0:${port}`);
      expect(held).toContain(`::${port === 0 ? '' : ':'}${port}`);
    }
  });

  it('with only the IPv6 listener left, the IPv6 connection is still served', async () => {
    const { windows, reach6 } = await lab();
    windows.getTcpStack().closeListener(22);
    expect(await reach6(22)).toBe('open');
  });
});

describe('UDP: the name responders hold one socket per family', () => {
  it('Windows: 5353 and 5355 are bound on 0.0.0.0 and on [::], at the PID of the DNS client', async () => {
    const { windows } = await lab();
    const rows = await rowsOf(windows, '-ano');
    for (const port of [5353, 5355]) {
      const v4 = listening(rows, `0.0.0.0:${port}`);
      const v6 = listening(rows, `[::]:${port}`);
      expect(v6).toBeDefined();
      expect(v6!.pid).toBe(v4!.pid);
    }
  });

  it('netstat -p udpv6 lists those two rows and Get-NetUDPEndpoint the :: ones', async () => {
    const { windows, powershell } = await lab();
    expect((await rowsOf(windows, '-ano -p udpv6')).map((row) => row.local).sort()).toEqual(['[::]:5353', '[::]:5355']);
    const table = await powershell('Get-NetUDPEndpoint -LocalPort 5355 | Format-Table LocalAddress,LocalPort');
    expect(table.split('\n').filter((line) => /5355/.test(line)).map((line) => line.trim().split(/\s+/)[0]).sort())
      .toEqual(['0.0.0.0', '::']);
  });

  it('switching LLMNR off closes both of its sockets and only them', async () => {
    const { windows } = await lab();
    await windows.executeCommand('reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient" /v EnableMulticast /t REG_DWORD /d 0 /f');
    const locals = (await rowsOf(windows, '-an')).map((row) => row.local);
    expect(locals).not.toContain('0.0.0.0:5355');
    expect(locals).not.toContain('[::]:5355');
    expect(locals).toContain('0.0.0.0:5353');
    expect(locals).toContain('[::]:5353');
  });

  it('Linux: systemd-resolved holds 5355 on 0.0.0.0 and on [::] too', async () => {
    const { linux } = await lab();
    const table = await linux.executeCommand('ss -lun');
    expect(table).toMatch(/0\.0\.0\.0:5355\s/);
    expect(table).toMatch(/\[::\]:5355\s/);
  });
});

describe('EndHost.udpBind with several families', () => {
  const noop = () => undefined;

  it('binds one row per family and frees them together', async () => {
    const { windows } = await lab();
    expect(windows.udpBind(9000, noop, 'probe', { families: DUAL_STACK })).toBe(9000);
    const held = () => windows.getSocketTable().getAll().filter((entry) => entry.protocol === 'udp' && entry.localPort === 9000)
      .map((entry) => entry.localAddress).sort();
    expect(held()).toEqual(['0.0.0.0', '::']);
    windows.udpClose(9000);
    expect(held()).toEqual([]);
  });

  it('closing one family keeps the other row and the listener that serves it', async () => {
    const { linux, windows } = await lab();
    const served: number[] = [];
    windows.udpBind(9001, ({ udp }) => { served.push(udp.destinationPort); }, 'probe', { families: DUAL_STACK });
    windows.udpClose(9001, 'ipv6');
    const held = windows.getSocketTable().getAll().filter((entry) => entry.protocol === 'udp' && entry.localPort === 9001)
      .map((entry) => entry.localAddress);
    expect(held).toEqual(['0.0.0.0']);
    expect(windows.udpBind(9001, noop, 'probe')).toBe(false);
    linux.sendUdpDatagram(new IPAddress('10.0.0.7'), 9001, 40000, new Uint8Array([1]), 1);
    expect(served).toEqual([9001]);
  });

  it('a process that exits gives back both of its rows and its listener', async () => {
    const { linux, windows } = await lab();
    const served: number[] = [];
    windows.udpBind(9004, ({ udp }) => { served.push(udp.destinationPort); }, 'probe', { pid: 4242, families: DUAL_STACK });
    windows.reapProcessSockets(4242, 'probe', 'graceful');
    const held = windows.getSocketTable().getAll().filter((entry) => entry.protocol === 'udp' && entry.localPort === 9004);
    expect(held).toEqual([]);
    linux.sendUdpDatagram(new IPAddress('10.0.0.7'), 9004, 40000, new Uint8Array([1]), 1);
    expect(served).toEqual([]);
  });

  it('leaves no half-bound port when one family is taken', async () => {
    const { windows } = await lab();
    windows.udpBind(9002, noop, 'first', { families: ['ipv6'] });
    expect(windows.udpBind(9002, noop, 'second', { families: DUAL_STACK })).toBe(false);
    const held = windows.getSocketTable().getAll().filter((entry) => entry.protocol === 'udp' && entry.localPort === 9002)
      .map((entry) => entry.localAddress);
    expect(held).toEqual(['::']);
  });

  it('a bind without families is the IPv4 row it always was (witness)', async () => {
    const { windows } = await lab();
    windows.udpBind(9003, noop, 'probe');
    const held = windows.getSocketTable().getAll().filter((entry) => entry.protocol === 'udp' && entry.localPort === 9003)
      .map((entry) => entry.localAddress);
    expect(held).toEqual(['0.0.0.0']);
  });
});
