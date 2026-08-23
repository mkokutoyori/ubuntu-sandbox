import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VRP_MODES, VRP_PROMPTS, VRP_TOP_LEVEL, VRP_EXEC_LEVEL } from '@/cli/vendors/vrp/vrpModes';
import { VrpSocle } from '@/cli/vendors/vrp/vrpSocle';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function taper(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

describe('le socle VRP, comme objet', () => {
  it('les modes et les invites de VRP sont ceux de la machine a etats', () => {
    expect(VRP_TOP_LEVEL).toBe('user');
    expect(VRP_EXEC_LEVEL).toBe('system');
    expect(VRP_MODES.system.parent).toBe('user');
    expect(VRP_MODES.interface.parent).toBe('system');
    expect(VRP_PROMPTS.user).toBe('<{host}>');
  });

  it('une commande declaree s\'execute, dans son mode et pas ailleurs', () => {
    const socle = new VrpSocle(() => 'R1', {}, () => [{
      id: 'essai',
      path: ['essai', 'commande'],
      description: 'Un essai',
      modes: ['system'], minPrivilege: 1,
      run: () => 'fait',
    }]);
    expect(socle.run('essai commande', 'system')).toBe('fait');
    expect(socle.run('essai commande', 'user')).toBeNull();
    expect(socle.run('rien du tout', 'system')).toBeNull();
  });

  it('l\'abreviation est admise, l\'ambiguite est NOMMEE dans les mots de VRP', () => {
    const socle = new VrpSocle(() => 'R1', {}, () => [
      { id: 'a', path: ['display', 'version'], description: 'v', modes: ['user'], minPrivilege: 1, run: () => 'V' },
      { id: 'b', path: ['display', 'vlan'], description: 'l', modes: ['user'], minPrivilege: 1, run: () => 'L' },
    ]);
    expect(socle.run('display ver', 'user')).toBe('V');
    const ambigu = socle.diagnostic('display v', 'user');
    expect(ambigu).toContain('Ambiguous command');
    expect(ambigu).toContain("found at '^' position");
  });

  it('un argument mal type est REFUSE, dans les mots de VRP', () => {
    const socle = new VrpSocle(() => 'R1', {}, () => [{
      id: 'c',
      path: ['essai', { name: 'n', type: 'INT' as const, range: [1, 10] as const, description: 'Un nombre' }],
      description: 'Un essai',
      modes: ['system'], minPrivilege: 1,
      run: (_s, args) => `n=${args.n}`,
    }]);
    expect(socle.run('essai 5', 'system')).toBe('n=5');
    expect(socle.diagnostic('essai zzz', 'system')).toContain('Wrong parameter');
    expect(socle.diagnostic('essai 99', 'system')).toContain('Wrong parameter');
    expect(socle.diagnostic('zorglub', 'system')).toBe(null);
    expect(socle.diagnostic('essai', 'system')).toContain('Incomplete command');
  });

  it('l\'aide du socle rend ce qui vient APRES le curseur', () => {
    const socle = new VrpSocle(() => 'R1', {}, () => [
      { id: 'a', path: ['display', 'version'], description: 'Version', modes: ['user'], minPrivilege: 1, run: () => '' },
    ]);
    const aide = socle.suggestions('display ', 'user', 'QUESTION_MARK');
    expect(aide.map(l => l.keyword)).toContain('version');
    expect(aide.find(l => l.keyword === 'version')!.description).toBe('Version');
  });
});

describe('le shell VRP consulte le socle avant son trie', () => {
  it('la famille du client DHCP est declaree sur le SOCLE', async () => {
    const { vrpDhcpClientFamily } = await import('@/cli/vendors/vrp/vrpDhcpClientFamily');
    const ids = vrpDhcpClientFamily().map(s => s.id);
    expect(ids).toContain('vrp-ip-address-dhcp-alloc');
    expect(ids).toContain('vrp-display-dhcp-client');
  });

  it('`ip address dhcp-alloc` passe par le socle et obtient une adresse', async () => {
    const srv = new CiscoRouter('SRV', 0, 0);
    await taper(srv, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.30.1.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 10.30.1.1',
      'ip dhcp pool LAN', 'network 10.30.1.0 255.255.255.0', 'default-router 10.30.1.1',
      'exit', 'end',
    ]);
    const r = new HuaweiRouter('RH', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GE0/0/0')!);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0', 'undo shutdown', 'ip address dhcp-alloc']);
    expect(r.getPort('GE0/0/0')!.getIPAddress()?.toString().startsWith('10.30.1.')).toBe(true);
  });

  it('le socle rend les QUATRE messages de VRP, jamais ceux d\'IOS', async () => {
    const r = new HuaweiRouter('RH', 0, 0);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0']);
    const sortie = await r.executeCommand('ip address dhcp-alloc zzz');
    expect(sortie).toContain('Error:');
    expect(sortie).not.toContain('%');
  });

  it('l\'aide `?` voit ce que le socle declare', async () => {
    const r = new HuaweiRouter('RH', 0, 0);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0']);
    const aide = await r.executeCommand('ip address ?');
    expect(aide).toContain('dhcp-alloc');
  });

  it('la tabulation voit ce que le socle declare', async () => {
    const r = new HuaweiRouter('RH', 0, 0);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0']);
    expect(r.getCompletions('ip address dh')).toContain('ip address dhcp-alloc');
  });

  it('une commande du TRIE continue de repondre — le pont n\'ombre rien', async () => {
    const r = new HuaweiRouter('RH', 0, 0);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0']);
    expect(await r.executeCommand('ip address 10.0.0.1 255.255.255.0')).toBe('');
    expect(r.getPort('GE0/0/0')!.getIPAddress()?.toString()).toBe('10.0.0.1');
  });

  it('`undo` est la negation de VRP, et le socle la comprend', async () => {
    const r = new HuaweiRouter('RH', 0, 0);
    await taper(r, ['system-view', 'interface GigabitEthernet0/0/0', 'ip address dhcp-alloc']);
    expect(r.getPort('GE0/0/0')!.isDhcpClient()).toBe(true);
    expect(await r.executeCommand('undo ip address dhcp-alloc')).toBe('');
    expect(r.getPort('GE0/0/0')!.isDhcpClient()).toBe(false);
  });

  it('`display dhcp client` du socle decrit le bail', async () => {
    const srv = new CiscoRouter('SRV', 0, 0);
    await taper(srv, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.30.2.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 10.30.2.1',
      'ip dhcp pool LAN', 'network 10.30.2.0 255.255.255.0', 'default-router 10.30.2.1',
      'exit', 'end',
    ]);
    const r = new HuaweiRouter('RH', 0, 0);
    new Cable('a').connect(srv.getPort('GigabitEthernet0/0')!, r.getPort('GE0/0/0')!);
    await taper(r, [
      'system-view', 'interface GigabitEthernet0/0/0', 'undo shutdown',
      'ip address dhcp-alloc', 'return',
    ]);
    const vue = await r.executeCommand('display dhcp client');
    expect(vue).toContain('GigabitEthernet0/0/0');
    expect(vue).toMatch(/Bound/);
    expect(vue).toMatch(/10\.30\.2\./);
  });
});
