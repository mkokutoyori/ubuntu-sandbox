/**
 * GDOI / GET-VPN (RFC 6407) group key management was fully built at the
 * engine level (createMulticastSA, addMulticastReceiver, real wire push via
 * _sendIkeUdp) but had ZERO CLI surface — no `crypto gdoi group` command
 * existed anywhere, so the subsystem was completely unreachable from a
 * router configuration. Separately, an inbound ESP/AH packet addressed to
 * a multicast group was routed through the UNICAST SPI table
 * (processInboundESP/AH), which can never contain a multicast SA (those
 * live in a separate (SPI, group) keyed table) — so even a correctly
 * pushed group SA could never actually decrypt real inbound multicast
 * traffic on a group member.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { MulticastIPSecSA } from '@/network/ipsec/IPSecTypes';

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
    getGdoiGroups(): Map<string, { name: string; groupAddress?: string; isKeyServer: boolean }>;
    getMulticastSAs(): Map<string, MulticastIPSecSA>;
  } })._getIPSecEngineInternal();
}

async function buildTopology() {
  const ks = new CiscoRouter('KS');
  const gm = new CiscoRouter('GM');
  const wan = new Cable('wan');
  wan.connect(ks.getPort('GigabitEthernet0/1')!, gm.getPort('GigabitEthernet0/1')!);

  await run(ks, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'end',
  ]);
  await run(gm, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
    'end',
  ]);
  await ks.executeCommand('ping 10.0.12.2');
  return { ks, gm, wan };
}

describe('GDOI/GET-VPN group key management is reachable from the CLI', () => {
  it('"server local" activates a real multicast Group SA for the group address', async () => {
    const { ks } = await buildTopology();
    await run(ks, [
      'enable', 'configure terminal',
      'crypto gdoi group G1',
      'identity number 100',
      'match address ipv4 239.1.1.1',
      'transform-set TSET',
      'server local',
      'exit', 'end',
    ]);

    const engine = engineOf(ks);
    const group = engine.getGdoiGroups().get('G1');
    expect(group?.isKeyServer).toBe(true);

    const msas = [...engine.getMulticastSAs().values()];
    expect(msas).toHaveLength(1);
    expect(msas[0].groupAddress).toBe('239.1.1.1');
    expect(msas[0].senderAddress).toBe('10.0.12.1');
    expect(msas[0].transforms).toEqual(['esp-aes 256', 'esp-sha256-hmac']);
  });

  it('a group member genuinely registers with the key server over the wire and receives the pushed SA', async () => {
    const { ks, gm } = await buildTopology();
    await run(ks, [
      'enable', 'configure terminal',
      'crypto gdoi group G1',
      'identity number 100',
      'match address ipv4 239.1.1.1',
      'transform-set TSET',
      'server local',
      'exit', 'end',
    ]);

    await run(gm, [
      'enable', 'configure terminal',
      'crypto gdoi group G1',
      'identity number 100',
      'server address ipv4 10.0.12.1',
      'exit', 'end',
    ]);

    const ksEngine = engineOf(ks);
    const ksMsa = [...ksEngine.getMulticastSAs().values()][0];
    expect(ksMsa.receivers).toContain('10.0.12.2');

    const gmEngine = engineOf(gm);
    const gmMsas = [...gmEngine.getMulticastSAs().values()];
    expect(gmMsas).toHaveLength(1);
    expect(gmMsas[0].groupAddress).toBe('239.1.1.1');
    expect(gmMsas[0].spi).toBe(ksMsa.spi);
    expect(gmMsas[0].cryptoKeys.espEncKey).toBe(ksMsa.cryptoKeys.espEncKey);
  });

  it('"show crypto gdoi" reflects key-server and group-member roles', async () => {
    const { ks, gm } = await buildTopology();
    await run(ks, [
      'enable', 'configure terminal',
      'crypto gdoi group G1', 'identity number 100',
      'match address ipv4 239.1.1.1', 'transform-set TSET', 'server local',
      'exit', 'end',
    ]);
    await run(gm, [
      'enable', 'configure terminal',
      'crypto gdoi group G1', 'identity number 100',
      'server address ipv4 10.0.12.1',
      'exit', 'end',
    ]);

    const ksShow = await ks.executeCommand('show crypto gdoi');
    expect(ksShow).toContain('Key Server');
    expect(ksShow).toContain('Registered Members: 1');

    const gmShow = await gm.executeCommand('show crypto gdoi');
    expect(gmShow).toContain('Group Member');
    expect(gmShow).toContain('Key Server: 10.0.12.1');
  });

  it('an inbound multicast ESP packet is decrypted via the multicast SA table, not the unicast one', async () => {
    const { ks, gm } = await buildTopology();
    await run(ks, [
      'enable', 'configure terminal',
      'crypto gdoi group G1', 'identity number 100',
      'match address ipv4 239.1.1.1', 'transform-set TSET', 'server local',
      'exit', 'end',
    ]);
    await run(gm, [
      'enable', 'configure terminal',
      'crypto gdoi group G1', 'identity number 100',
      'server address ipv4 10.0.12.1',
      'exit', 'end',
    ]);

    const ksEngine = engineOf(ks) as unknown as {
      getMulticastSAs(): Map<string, MulticastIPSecSA>;
      processMulticastOutbound(pkt: unknown, egressIface: string): unknown;
    };
    const gmEngine = engineOf(gm) as unknown as {
      processMulticastInboundESP(pkt: unknown): unknown;
      processInboundESP(pkt: unknown): unknown;
    };
    const msa = [...ksEngine.getMulticastSAs().values()][0];

    // Craft an inner packet from KS to the multicast group and encapsulate
    // it exactly as the real outbound path would.
    const { IPAddress, createIPv4Packet, IP_PROTO_ICMP } = await import('@/network/core/types');
    const inner = createIPv4Packet(
      new IPAddress('10.0.12.1'), new IPAddress('239.1.1.1'),
      IP_PROTO_ICMP, 64, { type: 'echo-request' }, 28,
    );
    const outer = ksEngine.processMulticastOutbound(inner, 'GigabitEthernet0/1');
    expect(outer).not.toBeNull();

    // The GM's UNICAST decap path must not find this SPI (proves the two
    // tables are genuinely distinct), while the multicast decap path must.
    expect(gmEngine.processInboundESP(outer)).toBeNull();
    const decapped = gmEngine.processMulticastInboundESP(outer) as { destinationIP: { toString(): string } } | null;
    expect(decapped).not.toBeNull();
    expect(decapped!.destinationIP.toString()).toBe('239.1.1.1');
    void msa;
  });
});
