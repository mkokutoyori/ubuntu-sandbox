/**
 * Le NIC teaming Windows (LBFO), mesure contre la documentation NetLbfo
 * de Microsoft pour les cmdlets et leurs valeurs, et contre la classe
 * MSFT_NetImPlatAdapter pour l'enumeration de FailureReason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  TEAMING_MODES, LB_ALGORITHMS, LACP_TIMERS, ADMIN_MODES,
  defaultTeam, teamStatus, memberStatus, memberFailureReason,
  lbAlgorithmToLoadBalance, normaliseTeamingMode,
} from '@/network/devices/windows/WindowsNicTeam';

interface Cmd { executeCommand(cmd: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

const SW_PORTS = ['FastEthernet0/1', 'FastEthernet0/2'];
const LACP_PERIODIC_MS = 35_000;
const LACP_LONG_TIMEOUT_MS = 100_000;

function shellOf(pc: WindowsPC): { execute(c: string): string } {
  return (pc as unknown as { getPowerShellInterpreter(): { execute(c: string): string } })
    .getPowerShellInterpreter();
}

async function labo(mode = 'LACP', nbNics = 2) {
  const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
  pc.powerOn(); sw.powerOn();
  const nics = pc.getPorts().slice(0, nbNics).map((p) => p.getName());
  const cables = nics.map((n, i) => {
    const c = new Cable(`c${i}`);
    c.connect(pc.getPort(n)!, sw.getPort(SW_PORTS[i])!);
    return c;
  });
  await taper(sw, ['enable', 'configure terminal']);
  for (const n of SW_PORTS.slice(0, nbNics)) {
    await taper(sw, [`interface ${n}`, 'channel-group 1 mode active', 'exit']);
  }
  await sw.executeCommand('end');
  const ps = shellOf(pc);
  const membres = nics.map((_, i) => `"Ethernet ${i}"`).join(',');
  ps.execute(`New-NetLbfoTeam -Name Team1 -TeamMembers @(${membres})`
    + ` -TeamingMode ${mode} -Confirm:$false`);
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { pc, sw, ps, nics, cables };
}

describe('le vocabulaire LBFO est celui de la documentation', () => {
  it('les trois modes de teaming', () => {
    expect([...TEAMING_MODES]).toEqual(['Static', 'SwitchIndependent', 'LACP']);
  });

  it('les cinq algorithmes de repartition', () => {
    expect([...LB_ALGORITHMS]).toEqual([
      'TransportPorts', 'IPAddresses', 'MacAddresses', 'HyperVPort', 'Dynamic',
    ]);
  });

  it('les deux minuteurs LACP et les deux modes administratifs', () => {
    expect([...LACP_TIMERS]).toEqual(['Slow', 'Fast']);
    expect([...ADMIN_MODES]).toEqual(['Active', 'Standby']);
  });

  it('`Lacp` est accepte dans l\'orthographe du parametre', () => {
    expect(normaliseTeamingMode('Lacp')).toBe('LACP');
    expect(normaliseTeamingMode('switchindependent')).toBe('SwitchIndependent');
    expect(normaliseTeamingMode('zorglub')).toBeNull();
  });

  it('un nouveau team prend les defauts documentes', () => {
    const t = defaultTeam('Team1', ['eth0']);
    expect(t.teamingMode).toBe('SwitchIndependent');
    expect(t.loadBalancingAlgorithm).toBe('Dynamic');
    expect(t.lacpTimer).toBe('Slow');
    expect(t.members[0].adminMode).toBe('Active');
  });

  it('l\'algorithme choisit sur quoi porte le hachage', () => {
    expect(lbAlgorithmToLoadBalance('TransportPorts')).toBe('src-dst-port');
    expect(lbAlgorithmToLoadBalance('IPAddresses')).toBe('src-dst-ip');
    expect(lbAlgorithmToLoadBalance('Dynamic')).toBe('src-dst-ip');
    expect(lbAlgorithmToLoadBalance('MacAddresses')).toBe('src-dst-mac');
    expect(lbAlgorithmToLoadBalance('HyperVPort')).toBe('src-dst-mac');
  });

  it('l\'etat du team suit celui de ses membres actifs', () => {
    const membres = [
      { name: 'eth0', adminMode: 'Active' as const },
      { name: 'eth1', adminMode: 'Active' as const },
    ];
    expect(teamStatus(membres, () => true)).toBe('Up');
    expect(teamStatus(membres, (n) => n === 'eth0')).toBe('Degraded');
    expect(teamStatus(membres, () => false)).toBe('Down');
  });

  it('un membre en attente n\'est pas une panne, il est Standby', () => {
    const veille = { name: 'eth1', adminMode: 'Standby' as const };
    expect(memberStatus(veille, true, false, 'LACP')).toBe('Standby');
    expect(memberFailureReason(veille, true, false, 'LACP')).toBe('AdministrativeDecision');
  });

  it('les raisons de panne sont celles de MSFT_NetImPlatAdapter', () => {
    const actif = { name: 'eth0', adminMode: 'Active' as const };
    expect(memberFailureReason(actif, true, true, 'LACP')).toBe('NoFailure');
    expect(memberFailureReason(actif, false, false, 'LACP')).toBe('PhysicalMediaDisconnected');
    expect(memberFailureReason(actif, true, false, 'LACP')).toBe('LacpNegotiationIssue');
    expect(memberFailureReason(actif, true, false, 'SwitchIndependent')).toBe('NoFailure');
  });
});

describe('New-NetLbfoTeam cree un vrai agregat', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('la cmdlet rend le team qu\'elle vient de creer', async () => {
    const { ps } = await labo();
    const out = ps.execute('Get-NetLbfoTeam');
    expect(out).toContain('Name                   : Team1');
    expect(out).toContain('TeamingMode            : LACP');
    expect(out).toContain('LoadBalancingAlgorithm : Dynamic');
    expect(out).toContain('LacpTimer              : Slow');
    expect(out).toContain('Status                 : Up');
    expect(out).toMatch(/Members\s+: \{Ethernet 0, Ethernet 1\}/);
  }, 30_000);

  it('le team NIC est une carte que `Get-NetAdapter` voit, montee', async () => {
    const { ps } = await labo();
    const out = ps.execute('Get-NetAdapter');
    const ligne = out.split('\n').find((l) => l.startsWith('Team1'));
    expect(ligne).toBeDefined();
    expect(ligne).toContain('Up');
  }, 30_000);

  it('la vitesse du team NIC est la SOMME de ses membres actifs', async () => {
    const { ps } = await labo();
    const ligne = ps.execute('Get-NetAdapter').split('\n').find((l) => l.startsWith('Team1'))!;
    expect(ligne).toContain('200 Mbps');
  }, 30_000);

  it('le commutateur voit les deux ports groupes', async () => {
    const { sw } = await labo();
    expect(await sw.executeCommand('show etherchannel summary'))
      .toMatch(/Fa0\/1\(P\) Fa0\/2\(P\)/);
  }, 30_000);

  it('`Get-NetLbfoTeamMember` rend les colonnes de la classe CIM', async () => {
    const { ps } = await labo();
    const out = ps.execute('Get-NetLbfoTeamMember');
    for (const champ of ['Name', 'InterfaceDescription', 'Team', 'AdministrativeMode',
      'OperationalStatus', 'TransmitLinkSpeed', 'ReceiveLinkSpeed', 'FailureReason']) {
      expect(out, champ).toContain(champ);
    }
    expect(out).toContain('OperationalStatus    : Active');
    expect(out).toContain('FailureReason        : NoFailure');
    expect(out).toContain('TransmitLinkSpeed    : 100 Mbps');
  }, 30_000);

  it('`Get-NetLbfoTeamNic` enumere la colonne TeamNics', async () => {
    const { ps } = await labo();
    const out = ps.execute('Get-NetLbfoTeamNic');
    expect(out).toContain('Name    : Team1');
    expect(out).toContain('Team    : Team1');
    expect(out).toContain('Primary : True');
    expect(out).toContain('Default : True');
  }, 30_000);

  it('un membre porte l\'adresse du team NIC, comme le fait LBFO', async () => {
    const { pc, nics } = await labo();
    const equipe = pc.getPort('Team1')!.getMAC().toString();
    for (const n of nics) expect(pc.getPort(n)!.getMAC().toString()).toBe(equipe);
  }, 30_000);

  it('un mode inconnu est refuse, et rien n\'est cree', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0); pc.powerOn();
    const ps = shellOf(pc);
    const out = ps.execute('New-NetLbfoTeam -Name T -TeamMembers @("Ethernet 0") -TeamingMode Zorglub -Confirm:$false');
    expect(out).toContain('not a valid teaming mode');
    expect(pc.getNicTeams().size).toBe(0);
  });

  it('une carte absente est refusee, et rien n\'est cree', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0); pc.powerOn();
    const ps = shellOf(pc);
    const out = ps.execute('New-NetLbfoTeam -Name T -TeamMembers @("Ethernet 99") -Confirm:$false');
    expect(out).toContain('was not found');
    expect(pc.getNicTeams().size).toBe(0);
  });

  it('une carte deja engagee ne rejoint pas un second team', async () => {
    const { ps } = await labo();
    const out = ps.execute('New-NetLbfoTeam -Name Team2 -TeamMembers @("Ethernet 0") -Confirm:$false');
    expect(out).toContain('already a member of team');
  }, 30_000);
});

describe('un team LBFO PORTE le trafic', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function laboAvecPair(mode = 'LACP') {
    const { pc, sw, ps, nics, cables } = await labo(mode);
    const pair = new LinuxPC('linux-pc', 'pair', 0, 0);
    pair.powerOn();
    new Cable('cpair').connect(pair.getPorts()[0], sw.getPort('FastEthernet0/5')!);
    await pc.executeCommand('netsh interface ip set address name="Team1" static 10.9.0.1 255.255.255.0');
    await pair.executeCommand('ip addr add 10.9.0.2/24 dev eth0');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    return { pc, sw, ps, pair, nics, cables };
  }

  it('un ping traverse le team', async () => {
    const { pc } = await laboAvecPair();
    vi.useRealTimers();
    expect(await pc.executeCommand('ping 10.9.0.2')).toContain('(0% loss)');
  }, 30_000);

  it('la trame sort par un MEMBRE, jamais par le team NIC', async () => {
    const { pc, nics } = await laboAvecPair();
    const vus: string[] = [];
    pc.attachCapture((t) => { if (t.direction === 'out') vus.push(t.iface); });
    vi.useRealTimers();
    await pc.executeCommand('ping 10.9.0.2');
    expect(vus.length).toBeGreaterThan(0);
    expect(vus).not.toContain('Team1');
    expect(vus.every((n) => nics.includes(n))).toBe(true);
  }, 30_000);

  it('la reponse arrivee sur un membre est LIVREE au team NIC', async () => {
    const { pc, pair } = await laboAvecPair();
    vi.useRealTimers();
    expect(await pair.executeCommand('ping -c 2 10.9.0.1')).toMatch(/, 0% packet loss/);
  }, 30_000);

  it('un seul lien survivant porte encore le trafic', async () => {
    const { pc, cables } = await laboAvecPair();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    vi.useRealTimers();
    expect(await pc.executeCommand('ping 10.9.0.2')).toContain('(0% loss)');
  }, 30_000);
});

describe('l\'exploitation d\'un team', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un lien coupe passe le team en Degraded et le membre en Failed', async () => {
    const { ps, cables } = await labo();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(ps.execute('Get-NetLbfoTeam')).toContain('Status                 : Degraded');
    const membres = ps.execute('Get-NetLbfoTeamMember');
    expect(membres).toContain('OperationalStatus    : Failed');
    expect(membres).toContain('FailureReason        : PhysicalMediaDisconnected');
  }, 30_000);

  it('un lien coupe ecrit l\'evenement 16949 dans le journal Systeme', async () => {
    const { pc, cables } = await labo();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await pc.executeCommand('powershell Get-EventLog -LogName System');
    expect(out).toContain('16949');
  }, 30_000);

  it('`Set-NetLbfoTeamMember -AdministrativeMode Standby` retire le membre du faisceau', async () => {
    const { ps, sw } = await labo();
    expect(ps.execute('Set-NetLbfoTeamMember -Name "Ethernet 1" -AdministrativeMode Standby'))
      .toBe('');
    await vi.advanceTimersByTimeAsync(LACP_LONG_TIMEOUT_MS);
    expect(ps.execute('Get-NetLbfoTeamMember')).toContain('AdministrativeMode   : Standby');
    expect(await sw.executeCommand('show etherchannel summary')).toContain('Fa0/2(I)');
  }, 30_000);

  it('`Remove-NetLbfoTeamMember` rend la carte a elle-meme', async () => {
    const { pc, ps } = await labo();
    expect(ps.execute('Remove-NetLbfoTeamMember -Name "Ethernet 1"')).toBe('');
    expect(pc.teamOwning('eth1')).toBeNull();
    expect(pc.getPort('eth1')!.getMAC().toString())
      .not.toBe(pc.getPort('Team1')!.getMAC().toString());
  }, 30_000);

  it('`Add-NetLbfoTeamMember` fait rejoindre une carte au faisceau', async () => {
    const { pc, ps, sw } = await labo('LACP', 1);
    const c = new Cable('c2');
    c.connect(pc.getPort('eth1')!, sw.getPort('FastEthernet0/2')!);
    await taper(sw, ['enable', 'configure terminal', 'interface FastEthernet0/2',
      'channel-group 1 mode active', 'end']);
    expect(ps.execute('Add-NetLbfoTeamMember -Name "Ethernet 1" -Team Team1')).toBe('');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(await sw.executeCommand('show etherchannel summary'))
      .toMatch(/Fa0\/1\(P\) Fa0\/2\(P\)/);
  }, 30_000);

  it('`Set-NetLbfoTeam -LacpTimer Fast` change la cadence des LACPDU', async () => {
    const { pc, ps } = await labo();
    expect(ps.execute('Set-NetLbfoTeam -Name Team1 -LacpTimer Fast')).toBe('');
    expect(ps.execute('Get-NetLbfoTeam')).toContain('LacpTimer              : Fast');
    expect(pc.getLacpAgent().getConfig().fastRate).toBe(true);
  }, 30_000);

  it('`Remove-NetLbfoTeam` retire le team NIC et libere les cartes', async () => {
    const { pc, ps } = await labo();
    expect(ps.execute('Remove-NetLbfoTeam -Name Team1')).toBe('');
    expect(pc.getNicTeams().size).toBe(0);
    expect(pc.getPort('Team1')).toBeFalsy();
    expect(ps.execute('Get-NetAdapter')).not.toContain('Team1');
  }, 30_000);

  it('retirer un team qui n\'existe pas est refuse', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0); pc.powerOn();
    expect(shellOf(pc).execute('Remove-NetLbfoTeam -Name Absent'))
      .toContain('was not found');
  });

  it('un team en SwitchIndependent n\'emet AUCUNE LACPDU', async () => {
    const { pc, sw } = await labo('SwitchIndependent');
    expect(pc.getLacpAgent().getPortInfo('eth0')).toBeUndefined();
    expect(await sw.executeCommand('show etherchannel summary')).toContain('Fa0/1(I)');
  }, 30_000);
});
