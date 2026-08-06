/**
 * PRD-Routage-Fidelite.md §3 / §6.2 — un noeud sans effet observable
 * n'existe pas.
 *
 * Deux formulations, aucune n'enumere de commande pour elle-meme :
 *   - un mode de configuration existe ou n'existe pas ; une commande qui
 *     pretend entrer dans un sous-mode DOIT changer le prompt ;
 *   - un identifiant est valide ou refuse, avec le message d'IOS.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function config(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

function prompt(r: CiscoRouter): string {
  return (r as unknown as { getPrompt(): string }).getPrompt();
}

describe('a configuration mode exists, or the command that enters it is refused', () => {
  it('address-family under BGP enters a real sub-mode and exit-address-family leaves it', async () => {
    const r = await config();
    await r.executeCommand('router bgp 65000');
    const inRouter = prompt(r);
    expect(await r.executeCommand('address-family ipv4 unicast')).toBe('');
    expect(prompt(r)).not.toBe(inRouter);
    expect(prompt(r)).toContain('config-router-af');
    expect(await r.executeCommand('exit-address-family')).toBe('');
    expect(prompt(r)).toBe(inRouter);
  });

  it("EIGRP's named mode is refused rather than accepted with no sub-mode", async () => {
    const r = await config();
    await r.executeCommand('router eigrp 100');
    const before = prompt(r);
    for (const c of ['address-family ipv4 unicast autonomous-system 200',
      'af-interface GigabitEthernet0/1', 'topology base',
      'exit-af-interface', 'exit-af-topology']) {
      expect(await r.executeCommand(c), c).toMatch(/Invalid input/);
      expect(prompt(r), c).toBe(before);
    }
  });

  it("a real RIP knob is kept as itself, not poured into the redistribute list", async () => {
    const r = await config();
    await r.executeCommand('router rip');
    for (const c of ['offset-list 1 in 5 GigabitEthernet0/1', 'output-delay 50',
      'flash-update-threshold 10', 'validate-update-source']) {
      expect(await r.executeCommand(c), c).toBe('');
    }
    await r.executeCommand('end');
    const rendered = await r.executeCommand('show running-config');
    expect(rendered).not.toMatch(/redistribute (offset-list|output-delay|metric|flash-update)/);
    expect(rendered).toContain(' offset-list 1 in 5 GigabitEthernet0/1');
    expect(rendered).toContain(' output-delay 50');
  });

  it('the same knob is refused by a protocol that does not have it', async () => {
    const r = await config();
    await r.executeCommand('router bgp 65000');
    for (const c of ['offset-list 1 in 5 GigabitEthernet0/1', 'output-delay 50',
      'flash-update-threshold 10']) {
      expect(await r.executeCommand(c), c).toMatch(/Invalid input/);
    }
  });

  it('no shutdown does not exist in global configuration', async () => {
    const r = await config();
    expect(await r.executeCommand('no shutdown')).toMatch(/Invalid input/);
    expect(await r.executeCommand('shutdown')).toMatch(/Invalid input/);
  });

  it('no neighbor really removes the neighbor', async () => {
    const r = await config();
    for (const c of ['router bgp 65000', 'neighbor 10.0.0.2 remote-as 65001',
      'neighbor 10.0.0.3 remote-as 65002']) {
      await r.executeCommand(c);
    }
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).toContain('neighbor 10.0.0.2 remote-as 65001');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router bgp 65000');
    expect(await r.executeCommand('no neighbor 10.0.0.2')).toBe('');
    await r.executeCommand('end');
    const after = await r.executeCommand('show running-config');
    expect(after).not.toContain('neighbor 10.0.0.2');
    expect(after).toContain('neighbor 10.0.0.3 remote-as 65002');
  });
});

describe('an identifier is valid, or refused with IOS\'s own message', () => {
  it('area 0 cannot be a stub or an NSSA', async () => {
    const r = await config();
    await r.executeCommand('router ospf 1');
    expect(await r.executeCommand('area 0 stub'))
      .toBe('% OSPF: Area 0 is the backbone area and cannot be a stub area');
    expect(await r.executeCommand('area 0.0.0.0 nssa'))
      .toBe('% OSPF: Area 0 is the backbone area and cannot be a NSSA area');
    expect(await r.executeCommand('area 1 stub')).toBe('');
    expect(await r.executeCommand('area 2 nssa')).toBe('');
  });

  it('a refused area type leaves the area alone', async () => {
    const r = await config();
    await r.executeCommand('router ospf 1');
    await r.executeCommand('network 10.0.0.0 0.0.0.255 area 0');
    await r.executeCommand('area 0 stub');
    await r.executeCommand('end');
    expect(await r.executeCommand('show ip ospf')).not.toMatch(/area 0.*stub/i);
  });
});

describe('what the operator typed reaches the configuration', () => {
  it('a track-conditioned static route keeps its track', async () => {
    const r = await config();
    await r.executeCommand('track 1 ip sla 1 reachability');
    await r.executeCommand('exit');
    await r.executeCommand('ip route 10.9.9.0 255.255.255.0 10.0.12.2 track 1');
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config'))
      .toContain('ip route 10.9.9.0 255.255.255.0 10.0.12.2 track 1');
  });
});
