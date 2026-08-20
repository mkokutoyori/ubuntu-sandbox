/**
 * Both RemoteAccessVpnClient (real split/full-tunnel routing against a real
 * host's routing table) and DdnsResolver (real TTL-caching hostname
 * resolution) already existed as fully-built, unit-tested classes — but
 * neither was reachable from any CLI. `crypto map ... set peer <hostname>`
 * only ever accepted literal IPs, so a router had no way to track a
 * DDNS-registered peer or recover when its address changed. On the Windows
 * side, `Add-VpnConnection` only ever wrote a cosmetic profile entry — there
 * was no `Connect-VpnConnection` to actually establish the tunnel, so
 * RemoteAccessVpnClient's real route-installation/DPD-failover logic could
 * only ever be exercised by hand-built test harnesses, never from the shell.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { IKE_SA, CryptoMap } from '@/network/ipsec/IPSecTypes';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function engineOf(router: CiscoRouter) {
  return (router as unknown as { _getIPSecEngineInternal(): {
    ikeSADB: Map<string, IKE_SA>;
    cryptoMaps: Map<string, CryptoMap>;
    recheckIKESALifetimes(): void;
    runDPDCheck(): string[];
  } })._getIPSecEngineInternal();
}

async function buildDdnsTunnel() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const wan = new Cable('wan');
  wan.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

  await run(r2, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
    'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256',
    'authentication pre-share', 'group 14', 'exit',
    'crypto isakmp key DdnsSecret1 address 10.0.12.1',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL', 'permit ip host 10.0.12.2 host 10.0.12.1', 'exit',
    'crypto map CMAP 10 ipsec-isakmp', 'set peer 10.0.12.1',
    'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
  ]);

  await run(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
    'ip host vpn-hq.example.com 10.0.12.2',
    'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256',
    'authentication pre-share', 'group 14', 'exit',
    'crypto isakmp key DdnsSecret1 address 10.0.12.2',
    'crypto isakmp keepalive 10 3 periodic',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN_ACL', 'permit ip host 10.0.12.1 host 10.0.12.2', 'exit',
    'crypto map CMAP 10 ipsec-isakmp', 'set peer vpn-hq.example.com dynamic',
    'set transform-set TSET', 'match address VPN_ACL', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
  ]);

  return { r1, r2, wan };
}

describe('DDNS-tracked crypto-map peer (real hosts-table resolution + DPD re-homing)', () => {
  it('"set peer <hostname> dynamic" resolves via the router hosts table and negotiates a real tunnel', async () => {
    const { r1 } = await buildDdnsTunnel();
    await r1.executeCommand('ping 10.0.12.2');
    const engine = engineOf(r1);
    expect(engine.ikeSADB.has('10.0.12.2')).toBe(true);
    const entry = engine.cryptoMaps.get('CMAP')!.staticEntries.get(10)!;
    expect(entry.peerHostname).toBe('vpn-hq.example.com');
    expect(entry.peers).toEqual(['10.0.12.2']);
  });

  it('an unresolvable hostname is rejected at configuration time', async () => {
    const r1 = new CiscoRouter('R1');
    await run(r1, ['enable', 'configure terminal', 'crypto map CMAP 10 ipsec-isakmp']);
    const out = await r1.executeCommand('set peer no-such-host.example.com dynamic');
    expect(out).toContain('%');
    expect(out).toMatch(/unable to resolve/i);
  });

  it('when DPD declares the resolved peer dead, the engine re-resolves and re-homes to the new address', async () => {
    const { r1 } = await buildDdnsTunnel();
    await r1.executeCommand('ping 10.0.12.2');
    const engine = engineOf(r1);
    const ikeSA = engine.ikeSADB.get('10.0.12.2')!;

    // Simulate DDNS re-registration: the hostname now points elsewhere.
    await run(r1, ['enable', 'configure terminal', 'no ip host vpn-hq.example.com', 'ip host vpn-hq.example.com 10.0.12.3', 'end']);

    // Simulate an unresponsive peer (no R-U-THERE-ACK) without tearing down
    // the physical link, which would clear the SA through a separate path.
    const spy = vi.spyOn(r1, '_sendIkeUdp').mockReturnValue(false);
    try {
      for (let i = 0; i < 3; i++) {
        ikeSA.lastDPDActivity = Date.now() - 60_000;
        engine.runDPDCheck();
      }
    } finally {
      spy.mockRestore();
    }

    expect(engine.ikeSADB.has('10.0.12.2')).toBe(false);
    const entry = engine.cryptoMaps.get('CMAP')!.staticEntries.get(10)!;
    expect(entry.peers).toEqual(['10.0.12.3']);
  });
});

describe('Connect-VpnConnection wires RemoteAccessVpnClient into a real Windows routing table', () => {
  function createShell() {
    const pc = new WindowsPC('windows-pc', 'WIN-VPN');
    pc.setCurrentUser('Administrator');
    return { pc, sh: PowerShellSubShell.create(pc).subShell };
  }
  async function ps(sh: PowerShellSubShell, line: string): Promise<string> {
    const r = await sh.processLine(line);
    return r.output.join('\n');
  }

  it('Connect-VpnConnection with split tunneling installs real per-subnet routes', async () => {
    const { pc, sh } = createShell();
    await ps(sh, 'Add-VpnConnection -Name CorpVpn -ServerAddress 198.51.100.10 -SplitTunneling');
    await ps(sh, 'Add-VpnConnectionRoute -ConnectionName CorpVpn -DestinationPrefix "10.10.0.0/16"');
    await ps(sh, 'Connect-VpnConnection -Name CorpVpn');

    const routes = pc.getRoutingTable();
    expect(routes.some(r => r.network.toString() === '10.10.0.0' && r.nextHop?.toString() === '198.51.100.10')).toBe(true);

    const status = await ps(sh, 'Get-VpnConnection -Name CorpVpn');
    expect(status).toContain('Connected');
  });

  it('Connect-VpnConnection without split tunneling replaces the default route (full tunnel)', async () => {
    const { pc, sh } = createShell();
    await ps(sh, 'Add-VpnConnection -Name FullVpn -ServerAddress 198.51.100.20');
    await ps(sh, 'Connect-VpnConnection -Name FullVpn');
    const routes = pc.getRoutingTable();
    expect(routes.some(r => r.type === 'default' && r.nextHop?.toString() === '198.51.100.20')).toBe(true);
  });

  it('Disconnect-VpnConnection removes the installed routes', async () => {
    const { pc, sh } = createShell();
    await ps(sh, 'Add-VpnConnection -Name CorpVpn -ServerAddress 198.51.100.10 -SplitTunneling');
    await ps(sh, 'Add-VpnConnectionRoute -ConnectionName CorpVpn -DestinationPrefix "10.10.0.0/16"');
    await ps(sh, 'Connect-VpnConnection -Name CorpVpn');
    await ps(sh, 'Disconnect-VpnConnection -Name CorpVpn');

    const routes = pc.getRoutingTable();
    expect(routes.some(r => r.nextHop?.toString() === '198.51.100.10')).toBe(false);
    const status = await ps(sh, 'Get-VpnConnection -Name CorpVpn');
    expect(status).toContain('Disconnected');
  });

  it('connecting an already-connected VPN reports an error instead of double-installing routes', async () => {
    const { sh } = createShell();
    await ps(sh, 'Add-VpnConnection -Name CorpVpn -ServerAddress 198.51.100.10 -SplitTunneling');
    await ps(sh, 'Add-VpnConnectionRoute -ConnectionName CorpVpn -DestinationPrefix "10.10.0.0/16"');
    await ps(sh, 'Connect-VpnConnection -Name CorpVpn');
    const out = await ps(sh, 'Connect-VpnConnection -Name CorpVpn');
    expect(out).toMatch(/already connected/i);
  });
});
