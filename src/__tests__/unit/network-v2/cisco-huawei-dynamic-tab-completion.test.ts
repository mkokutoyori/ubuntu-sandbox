import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoTerminalSession, HuaweiTerminalSession } from '@/terminal/sessions';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';
import { EquipmentParamResolver, type CompletableDevice } from '@/network/devices/shells/EquipmentParamResolver';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

type CliSessionHandle = {
  input: string;
  onTab(reverse?: boolean): void;
};

describe('Dynamic Tab candidates — Cisco (PRD item 2)', () => {
  /**
   * Un mot-clé et une valeur ne se disputent pas la même place.
   *
   * Ce cas attendait `interface Fa` → les huit ports. Un vrai Catalyst
   * complète le TYPE à cet endroit (`interface FastEthernet`) et ne
   * propose les ports qu'une fois le type écrit : le type et son numéro
   * sont deux jetons pour l'analyseur, même collés. Mélanger les deux
   * rendait huit candidats, donc Tab ne faisait RIEN là où la machine
   * réelle écrit le type d'un coup — la complétion était perdue, pas
   * gagnée. Les ports restent atteignables, et le deuxième `expect` le
   * vérifie plutôt que de le supposer.
   */
  it('cliTabCandidates complète le type, puis les ports réels', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    expect(sw.cliTabCandidates('interface Fa')).toEqual(['interface FastEthernet']);
    const ports = sw.cliTabCandidates('interface FastEthernet0/');
    expect(ports).toContain('interface FastEthernet0/1');
    expect(ports).toContain('interface FastEthernet0/8');
  });

  it('a unique real interface completes via Tab at the session level', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const candidates = sw.cliTabCandidates('interface FastEthernet0/3');
    expect(candidates).toEqual(['interface FastEthernet0/3']);
    const s = new CiscoTerminalSession('t1', sw) as unknown as CliSessionHandle & {
      vty: { state: { mode: string } } | null;
    };
    if (s.vty) s.vty.state.mode = 'config';
    s.input = 'interface FastEthernet0/3';
    s.onTab();
    expect(s.input).toBe('interface FastEthernet0/3 ');
  });

  it('cliTabCandidates lists only VLANs that really exist after "vlan"', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('exit');
    const candidates = sw.cliTabCandidates('vlan 1');
    expect(candidates).toContain('vlan 1');
    expect(candidates).toContain('vlan 10');
    expect(candidates).not.toContain('vlan 20');
    expect(candidates.some(c => c === 'vlan 15')).toBe(false);
  });

  it('the ? help after "interface " lists interface TYPES, not the ports', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const help = sw.cliHelp('interface ');
    expect(help).toContain('FastEthernet');
    expect(help).toContain('Vlan');
    expect(help).not.toContain('FastEthernet0/1');
    expect(help).not.toContain('FastEthernet0/8');
    expect(sw.cliTabCandidates('interface FastEthernet0/')).toContain('interface FastEthernet0/1');
  });

  it('works for routers too (real router port names)', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const names = r.getPorts().map(p => p.getName());
    expect(names.length).toBeGreaterThan(0);
    const candidates = r.cliTabCandidates(`interface ${names[0]}`);
    expect(candidates).toContain(`interface ${names[0]}`);
  });

  it('static keyword completion is untouched (regression control)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    expect(sw.cliTabComplete('sh')).toBe('show ');
    expect(sw.cliTabComplete('s')).toBeNull();
  });

  it('Cisco session: ambiguous Tab stays a silent no-op', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 's';
    s.onTab();
    expect(s.input).toBe('s');
  });

  it('Cisco session: unique prefix still completes through the vty path', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const s = new CiscoTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 'sh';
    s.onTab();
    expect(s.input).toBe('show ');
  });
});

describe('Dynamic Tab candidates — Huawei (PRD items 2 et 3)', () => {
  /**
   * Ce cas NE suit PAS son jumeau Cisco, et c'est délibéré.
   *
   * Côté IOS, replier les ports sur le type fait gagner une frappe,
   * parce qu'une ambiguïté y rend Tab muet. Sur VRP la tabulation est
   * CYCLIQUE : proposer les huit ports les rend tous atteignables l'un
   * après l'autre, et les replier sur le type en supprimerait sept.
   * `huaweiInterfaceHelp.ts` marque donc ses types `helpOnly` — ils
   * nomment la position dans `?` sans concourir avec les valeurs. La
   * règle « un mot-clé d'abord » est la même des deux côtés ; c'est la
   * politique de tabulation de la plateforme qui décide du résultat.
   */
  it('cliTabCandidates lists the real ports after "interface"', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.executeCommand('system-view');
    const realPorts = sw.getPorts().map(p => p.getName()).filter(n => n.startsWith('Gig'));
    expect(realPorts.length).toBeGreaterThan(0);
    const candidates = sw.cliTabCandidates('interface Gig');
    for (const name of realPorts) {
      expect(candidates).toContain(`interface ${name}`);
    }
  });

  it('cliTabCandidates lists only existing VLANs after "vlan"', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.executeCommand('system-view');
    sw.executeCommand('vlan batch 10 30');
    const candidates = sw.cliTabCandidates('vlan 3');
    expect(candidates).toContain('vlan 30');
    expect(candidates).not.toContain('vlan 20');
  });

  it('Huawei session: repeated Tab CYCLES ambiguous candidates (real VRP behavior)', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    expect(sw.cliTabCandidates('s').length).toBeGreaterThan(1);
    const s = new HuaweiTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 's';
    s.onTab();
    const first = s.input;
    expect(first).not.toBe('s');
    s.onTab();
    const second = s.input;
    expect(second).not.toBe(first);
    expect(second.toLowerCase().startsWith('s')).toBe(true);
  });

  it('Huawei session: Shift+Tab cycles backward', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    const s = new HuaweiTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 's';
    s.onTab();
    const first = s.input;
    s.onTab();
    s.onTab(true);
    expect(s.input).toBe(first);
  });

  it('Huawei session: unique candidate still completes with a trailing space', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    const s = new HuaweiTerminalSession('t1', sw) as unknown as CliSessionHandle;
    s.input = 'sys';
    s.onTab();
    expect(s.input).toBe('system-view ');
  });

  it('shell-level tabComplete contract is unchanged: ambiguous → null (trie level)', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    expect(sw.cliTabComplete('s')).toBeNull();
  });
});

describe('Dynamic Tab candidates — IP/hostname/ACL positions (PRD item 7)', () => {
  it('ping completes hostnames from the real ip host table', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip host server1 10.0.0.5');
    await r.executeCommand('end');
    const candidates = r.cliTabCandidates('ping ser');
    expect(candidates).toContain('ping server1');
  });

  it('ping completes IPs really configured on the device interfaces', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const port = r.getPorts()[0].getName();
    await r.executeCommand(`interface ${port}`);
    await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r.executeCommand('end');
    const candidates = r.cliTabCandidates('ping 192.168.');
    expect(candidates).toContain('ping 192.168.1.1');
  });

  it('ip access-group completes with the ACL numbers that really exist', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('access-list 101 permit ip any any');
    await r.executeCommand('access-list 102 deny ip any any');
    const port = r.getPorts()[0].getName();
    await r.executeCommand(`interface ${port}`);
    const candidates = r.cliTabCandidates('ip access-group 10');
    expect(candidates).toContain('ip access-group 101');
    expect(candidates).toContain('ip access-group 102');
    expect(candidates).not.toContain('ip access-group 103');
  });

  it('an unconfigured device offers no dynamic host/ACL candidates', () => {
    const r = new CiscoRouter('R1', 0, 0);
    expect(r.getAclIdentifiers()).toEqual([]);
    expect(r.getKnownHostnames()).toEqual([]);
  });
});

describe('Dynamic Tab candidates — MAC_ADDR and SUBNET_MASK ParamTypes (PRD item 7)', () => {
  it('Cisco router: a static ARP entry surfaces its real MAC via getKnownMacAddresses', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    expect(r.getKnownMacAddresses()).toEqual([]);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    const port = r.getPorts()[0].getName();
    await r.executeCommand(`interface ${port}`);
    await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
    await r.executeCommand('exit');
    await r.executeCommand('arp 10.0.0.42 00aa.00bb.00cc arpa');
    await r.executeCommand('end');
    const macs = r.getKnownMacAddresses();
    expect(macs).toContain('00:aa:00:bb:00:cc');
  });

  it('the resolver serves real MACs for a MAC_ADDR position and standard masks for SUBNET_MASK', () => {
    const device: CompletableDevice = {
      getKnownMacAddresses: () => ['00:aa:bb:cc:dd:ee', '00:11:22:33:44:55'],
    };
    const resolver = new EquipmentParamResolver(device);
    expect(resolver.candidatesFor({ path: [], paramType: 'MAC_ADDR', partial: '00' }))
      .toEqual(['00:aa:bb:cc:dd:ee', '00:11:22:33:44:55']);
    const masks = resolver.candidatesFor({ path: [], paramType: 'SUBNET_MASK', partial: '255.255.255.' });
    expect(masks).toContain('255.255.255.0');
    expect(masks).toContain('255.255.255.252');
    expect(masks).not.toContain('255.255.255.7');
  });

  it('a command declaring a SUBNET_MASK / MAC_ADDR param completes real values end-to-end', () => {
    const device: CompletableDevice = {
      getKnownMacAddresses: () => ['00:aa:bb:cc:dd:ee'],
    };
    const trie = new CommandTrie();
    trie.register('ip route', 'Static route', () => '', [
      { name: 'prefix', type: 'IP_ADDR', description: 'Destination prefix' },
      { name: 'mask', type: 'SUBNET_MASK', description: 'Prefix mask' },
    ]);
    trie.register('test-mac', 'MAC probe', () => '', [
      { name: 'mac', type: 'MAC_ADDR', description: 'A MAC address' },
    ]);
    trie.setDynamicResolver(new EquipmentParamResolver(device));
    expect(trie.tabCandidates('ip route 10.0.0.0 255.255.255.')).toContain('ip route 10.0.0.0 255.255.255.0');
    expect(trie.tabCandidates('test-mac 00')).toEqual(['test-mac 00:aa:bb:cc:dd:ee']);
  });
});
