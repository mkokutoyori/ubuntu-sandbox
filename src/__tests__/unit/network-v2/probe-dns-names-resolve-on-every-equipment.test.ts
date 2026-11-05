/*
 * The Linux clients were unified on one resolver; this probe holds the other equipment of the DNS lab (Banque Horizon) to the same standard. Each case runs a
 * command that takes a host NAME on a machine whose only way to know web.banquehorizon.com is the DNS over the wire (DC1, then DNS-RES, then the root/TLD/NS1
 * chain), on a cold cache, and asserts that the command reaches 203.0.113.20; the same command on a name nobody knows must keep failing in the platform's words.
 *
 * What was wrong at the base commit: the Windows cmd 'telnet' used its argument as an IP address, the Windows 'ssh-keyscan' kept a private lookup of its own
 * (hosts file and topology names only), the Cisco switch 'ping' built an IPAddress from the typed word and threw on a name, the Huawei router 'ping', 'tracert',
 * 'telnet' and 'stelnet' refused or crashed on a name although 'dns resolve' and 'dns server' were configured (a criterion stored and never evaluated), and the
 * FortiGate 'execute ping|traceroute|telnet' asked its synchronous DNS client, which cannot wait for a recursive answer, so every name outside the server's own
 * zones failed. Now: Router and Switch expose resolveHostname (RouterDnsService, shared transport), the Huawei and Cisco switch shells resolve before they parse,
 * the FortiGate DNS client keeps in-flight queries and settles late replies into its cache, and the Windows paths call the machine's resolveHostname.
 *
 * Measured against the commit before (worktree): 11 of the 17 cases fall (Windows telnet and ssh-keyscan, the Cisco switch ping with a known and with an unknown name
 * because it threw, the four Huawei router commands, the three FortiGate commands). The 6 that pass either way: the three WITNESSES (Windows ping, Cisco router ping and
 * traceroute prove the lab is sound and that a configured resolver is honoured) and the three non-regressions on a name nobody knows (Windows telnet, Huawei ping, FortiGate ping).
 *
 * Second pass (the commit after): the Huawei switch had no 'dns resolve' / 'dns server' (refused) and its ping/tracert did not resolve; the Cisco router telnet read the
 * host table only and the Cisco switch telnet found no source address (SVIs ignored) nor a route (ip default-gateway stored, never evaluated by the SVI route
 * lookup). Measured against the commit before: 5 of the 7 added cases fall (Huawei switch ping, tracert and running-config readback, Cisco router and switch telnet);
 * the 2 that pass either way are the non-regressions on a name nobody knows (Huawei switch ping, Cisco router telnet).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useNetworkStore } from '@/store/networkStore';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildDnsAgenceBancaire } from '@/labs/dnsAgenceBancaire/build';

const KNOWN = 'web.banquehorizon.com';
const UNKNOWN = 'nobody.banquehorizon.com';

interface Shell { executeCommand(command: string): Promise<string> }

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
  useNetworkStore.getState().clearAll();
});

async function lab() {
  const built = await buildDnsAgenceBancaire();
  const find = (name: string) => [...useNetworkStore.getState().deviceInstances.values()].find((d) => d.getName() === name) as unknown as Shell;
  const switchAgency = find('SW-AGENCE');
  for (const command of ['enable', 'configure terminal', 'interface range FastEthernet0/7 - 9', 'switchport mode access', 'switchport access vlan 20', 'end']) {
    await switchAgency.executeCommand(command);
  }
  return { built, find, switchAgency };
}

async function script(device: Shell, commands: readonly string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

async function huaweiRouter() {
  const { built, switchAgency } = await lab();
  const router = built.bench.place('router-huawei', 'HW', 100, 100) as unknown as Shell;
  built.bench.connect(router as never, 'GE0/0/0', switchAgency as never, 'FastEthernet0/7');
  await script(router, ['system-view', 'interface GigabitEthernet0/0/0', 'ip address 10.20.20.77 255.255.255.0', 'quit',
    'ip route-static 0.0.0.0 0.0.0.0 10.20.20.1', 'dns resolve', 'dns server 10.20.20.10', 'return']);
  return router;
}

async function fortigate() {
  const { built, switchAgency } = await lab();
  const firewall = built.bench.place('firewall-fortinet', 'FG', 100, 200) as unknown as Shell;
  built.bench.connect(firewall as never, 'port1', switchAgency as never, 'FastEthernet0/8');
  await script(firewall, ['config system interface', 'edit port1', 'set ip 10.20.20.78 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config router static', 'edit 1', 'set gateway 10.20.20.1', 'set device port1', 'next', 'end',
    'config system dns', 'set primary 10.20.20.10', 'end']);
  return firewall;
}

describe('Windows', () => {
  it('WITNESS ping resolves through the machine resolver', async () => {
    const { find } = await lab();
    expect(await find('PC-GUICHET1').executeCommand(`ping -n 1 ${KNOWN}`)).toContain('203.0.113.20');
  });

  it('cmd telnet reaches the host named by the DNS', async () => {
    const { find } = await lab();
    const out = await find('PC-GUICHET1').executeCommand(`telnet ${KNOWN} 80`);
    expect(out).toContain('Welcome to Microsoft Telnet Client');
    expect(out).not.toContain('Connect failed');
  });

  it('cmd telnet still fails on a name nobody knows', async () => {
    const { find } = await lab();
    expect(await find('PC-GUICHET1').executeCommand(`telnet ${UNKNOWN} 80`)).not.toContain('Welcome to Microsoft Telnet Client');
  });

  it('ssh-keyscan resolves the name through the DNS', async () => {
    const { find } = await lab();
    expect(await find('PC-GUICHET1').executeCommand(`powershell -NoProfile -Command "ssh-keyscan ${KNOWN}"`)).toContain('SSH-2.0');
  });
});

describe('Cisco', () => {
  it('WITNESS router ping honours ip name-server', async () => {
    const { find } = await lab();
    const router = find('R-AGENCE');
    const out = await script(router, ['enable', 'configure terminal', 'ip domain-lookup', 'ip name-server 10.20.20.10', 'end', `ping ${KNOWN}`]);
    expect(out).toContain('203.0.113.20');
  });

  it('WITNESS router traceroute honours ip name-server', async () => {
    const { find } = await lab();
    const out = await script(find('R-AGENCE'), ['enable', 'configure terminal', 'ip name-server 10.20.20.10', 'end', `traceroute ${KNOWN}`]);
    expect(out).toContain('203.0.113.20');
  });

  it('switch ping resolves a name through ip name-server', async () => {
    const { switchAgency } = await lab();
    const out = await script(switchAgency, ['enable', 'configure terminal', 'interface vlan 20', 'ip address 10.20.20.90 255.255.255.0', 'no shutdown', 'exit',
      'ip name-server 10.20.20.10', 'end', `ping ${KNOWN}`]);
    expect(out).toContain('Sending 5, 100-byte ICMP Echos to 203.0.113.20');
  });

  it('switch ping still fails on a name nobody knows', async () => {
    const { switchAgency } = await lab();
    const out = await script(switchAgency, ['enable', 'configure terminal', 'interface vlan 20', 'ip address 10.20.20.90 255.255.255.0', 'no shutdown', 'exit',
      'ip name-server 10.20.20.10', 'end', `ping ${UNKNOWN}`]);
    expect(out).toContain('% Unrecognized host or address');
  });
});

describe('Huawei router', () => {
  it('ping resolves the name', async () => {
    expect(await (await huaweiRouter()).executeCommand(`ping ${KNOWN}`)).toContain('Reply from 203.0.113.20');
  });

  it('tracert resolves the name', async () => {
    expect(await (await huaweiRouter()).executeCommand(`tracert ${KNOWN}`)).toContain('203.0.113.20');
  });

  it('telnet resolves the name', async () => {
    expect(await (await huaweiRouter()).executeCommand(`telnet ${KNOWN} 80`)).toContain('Connected to');
  });

  it('stelnet resolves the name', async () => {
    expect(await (await huaweiRouter()).executeCommand(`stelnet ${KNOWN}`)).toContain('Permission denied');
  });

  it('ping still fails on a name nobody knows', async () => {
    expect(await (await huaweiRouter()).executeCommand(`ping ${UNKNOWN}`)).toContain('Unknown host');
  });
});

describe('FortiGate', () => {
  it('execute ping resolves the name', async () => {
    expect(await (await fortigate()).executeCommand(`execute ping ${KNOWN}`)).toContain('64 bytes from 203.0.113.20');
  });

  it('execute traceroute resolves the name', async () => {
    expect(await (await fortigate()).executeCommand(`execute traceroute ${KNOWN}`)).toContain('203.0.113.20');
  });

  it('execute telnet resolves the name', async () => {
    expect(await (await fortigate()).executeCommand(`execute telnet ${KNOWN} 80`)).toContain('Connected to 203.0.113.20');
  });

  it('execute ping still fails on a name nobody knows', async () => {
    expect(await (await fortigate()).executeCommand(`execute ping ${UNKNOWN}`)).toContain('cannot resolve');
  });
});

async function huaweiSwitch() {
  const { built, switchAgency } = await lab();
  for (const command of ['enable', 'configure terminal', 'interface FastEthernet0/10', 'switchport mode access', 'switchport access vlan 20', 'end']) {
    await switchAgency.executeCommand(command);
  }
  const device = built.bench.place('switch-huawei', 'HSW', 100, 400) as unknown as Shell;
  built.bench.connect(device as never, 'GigabitEthernet0/0/1', switchAgency as never, 'FastEthernet0/10');
  await script(device, ['system-view', 'vlan 20', 'quit', 'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 20', 'quit',
    'interface Vlanif20', 'ip address 10.20.20.91 255.255.255.0', 'quit', 'ip route-static 0.0.0.0 0.0.0.0 10.20.20.1', 'dns resolve', 'dns server 10.20.20.10']);
  return device;
}

async function ciscoSwitchWithResolver() {
  const { switchAgency } = await lab();
  await script(switchAgency, ['enable', 'configure terminal', 'interface vlan 20', 'ip address 10.20.20.90 255.255.255.0', 'no shutdown', 'exit',
    'ip default-gateway 10.20.20.1', 'ip name-server 10.20.20.10', 'end']);
  return switchAgency;
}

describe('second pass', () => {
  it('Huawei switch ping resolves the name', async () => {
    expect(await (await huaweiSwitch()).executeCommand(`ping ${KNOWN}`)).toContain('Reply from 203.0.113.20');
  });

  it('Huawei switch tracert resolves the name', async () => {
    expect(await (await huaweiSwitch()).executeCommand(`tracert ${KNOWN}`)).toContain('203.0.113.20');
  });

  it('Huawei switch shows its DNS configuration back', async () => {
    const out = await (await huaweiSwitch()).executeCommand('display current-configuration');
    expect(out).toContain('dns server 10.20.20.10');
    expect(out).toContain('dns resolve');
  });

  it('Huawei switch ping still fails on a name nobody knows', async () => {
    expect(await (await huaweiSwitch()).executeCommand(`ping ${UNKNOWN}`)).toContain('Unknown host');
  });

  it('Cisco router telnet resolves a name through ip name-server', async () => {
    const { find } = await lab();
    const out = await script(find('R-AGENCE'), ['enable', 'configure terminal', 'ip name-server 10.20.20.10', 'end', `telnet ${KNOWN} 80`]);
    expect(out).toContain('Open');
  });

  it('Cisco switch telnet resolves a name through ip name-server', async () => {
    expect(await (await ciscoSwitchWithResolver()).executeCommand(`telnet ${KNOWN} 80`)).toContain('Open');
  });

  it('Cisco router telnet still fails on a name nobody knows', async () => {
    const { find } = await lab();
    const out = await script(find('R-AGENCE'), ['enable', 'configure terminal', 'ip name-server 10.20.20.10', 'end', `telnet ${UNKNOWN} 80`]);
    expect(out).toContain('unable to find computer address');
  });
});
