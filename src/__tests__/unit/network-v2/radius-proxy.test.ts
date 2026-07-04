import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/**
 * RFC 2607 — RADIUS proxy/roaming: NAS → Proxy (realm-aware) → Home server,
 * across two routed hops so the proxy's own egress resolution is exercised
 * (not just same-device dispatch).
 */
function setupProxyLab(bus: EventBus) {
  const nas = new CiscoRouter('NAS');
  const proxy = new CiscoRouter('PROXY');
  const home = new CiscoRouter('HOME');
  const sw1 = new CiscoSwitch('sw1', 'SW1', 4);
  const sw2 = new CiscoSwitch('sw2', 'SW2', 4);
  nas.setEventBus(bus); proxy.setEventBus(bus); home.setEventBus(bus);
  sw1.setEventBus(bus); sw2.setEventBus(bus);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw1.getPort('FastEthernet0/1')!);
  new Cable('b').connect(proxy.getPort('GigabitEthernet0/0')!, sw1.getPort('FastEthernet0/2')!);
  new Cable('c').connect(proxy.getPort('GigabitEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
  new Cable('d').connect(home.getPort('GigabitEthernet0/0')!, sw2.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  proxy.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  proxy.getPort('GigabitEthernet0/1')!.configureIP(new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.0'));
  home.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));

  proxy.getRadiusServer().setSharedSecret('nas-proxy-secret');
  nas.getRadiusClient().addServer('10.0.1.2', 'nas-proxy-secret', { timeoutMs: 300, retransmit: 0 });
  home.getRadiusServer().setSharedSecret('proxy-home-secret');

  return { nas, proxy, home };
}

describe('RADIUS proxy/roaming (RFC 2607)', () => {
  it('forwards a realm-matched user to the home server and accepts on a correct password', async () => {
    const bus = new EventBus();
    const { nas, proxy, home } = setupProxyLab(bus);
    proxy.getRadiusServer().addRealm('example.com', '10.0.2.2', 'proxy-home-secret', { timeoutMs: 300 });
    home.getRadiusServer().addUser('alice@example.com', 'wonderland');

    const accepted = await nas.getRadiusClient().authenticate('alice@example.com', 'wonderland');
    expect(accepted).toBe(true);
  });

  it('forwards a realm-matched user and rejects on a wrong password', async () => {
    const bus = new EventBus();
    const { nas, proxy, home } = setupProxyLab(bus);
    proxy.getRadiusServer().addRealm('example.com', '10.0.2.2', 'proxy-home-secret', { timeoutMs: 300 });
    home.getRadiusServer().addUser('alice@example.com', 'wonderland');

    const accepted = await nas.getRadiusClient().authenticate('alice@example.com', 'wrong-password');
    expect(accepted).toBe(false);
  });

  it('forwards CHAP requests verbatim (no shared-secret dependency across the hop)', async () => {
    const bus = new EventBus();
    const { nas, proxy, home } = setupProxyLab(bus);
    proxy.getRadiusServer().addRealm('example.com', '10.0.2.2', 'proxy-home-secret', { timeoutMs: 300 });
    home.getRadiusServer().addUser('alice@example.com', 'wonderland');

    const accepted = await nas.getRadiusClient().authenticateChap('alice@example.com', 'wonderland');
    expect(accepted).toBe(true);
  });

  it('still authenticates non-realm usernames locally on the proxy itself', async () => {
    const bus = new EventBus();
    const { nas, proxy } = setupProxyLab(bus);
    proxy.getRadiusServer().addRealm('example.com', '10.0.2.2', 'proxy-home-secret', { timeoutMs: 300 });
    proxy.getRadiusServer().addUser('bob', 'local-pw');

    const accepted = await nas.getRadiusClient().authenticate('bob', 'local-pw');
    expect(accepted).toBe(true);
  });

  it('rejects a realm with no configured route as an ordinary unknown user', async () => {
    const bus = new EventBus();
    const { nas } = setupProxyLab(bus);
    // No addRealm() call for "unknown-realm.com" — falls through to local auth, no such user.

    const accepted = await nas.getRadiusClient().authenticate('carol@unknown-realm.com', 'whatever');
    expect(accepted).toBe(false);
  });

  it('publishes radius.proxy.forwarded when a realm-matched request is relayed', async () => {
    const bus = new EventBus();
    const { nas, proxy, home } = setupProxyLab(bus);
    proxy.getRadiusServer().addRealm('example.com', '10.0.2.2', 'proxy-home-secret', { timeoutMs: 300 });
    home.getRadiusServer().addUser('alice@example.com', 'wonderland');

    const events: Array<{ username: string; realm: string; homeServerIp: string }> = [];
    bus.subscribe('radius.proxy.forwarded', (e) => events.push(e.payload));
    await nas.getRadiusClient().authenticate('alice@example.com', 'wonderland');
    expect(events).toEqual([
      expect.objectContaining({ username: 'alice@example.com', realm: 'example.com', homeServerIp: '10.0.2.2' }),
    ]);
  });

  it('times out (no answer to the NAS) when the home server never responds', async () => {
    const bus = new EventBus();
    const { nas, proxy } = setupProxyLab(bus);
    // Home server is up but has no user for this realm and, more importantly,
    // we point the realm at an IP nothing answers on — the proxy's own
    // forwarding attempt just never gets a reply, exactly like a real
    // unreachable home server.
    proxy.getRadiusServer().addRealm('dead.example', '10.0.2.99', 'proxy-home-secret', { timeoutMs: 100 });
    nas.getRadiusClient().addServer('10.0.1.2', 'nas-proxy-secret', { timeoutMs: 250, retransmit: 0 });

    const accepted = await nas.getRadiusClient().authenticate('carol@dead.example', 'whatever');
    expect(accepted).toBe(false);
  });

  it('listRealms() reports configured realm routes', () => {
    const bus = new EventBus();
    const { proxy } = setupProxyLab(bus);
    proxy.getRadiusServer().addRealm('example.com', '10.0.2.2', 'proxy-home-secret', { timeoutMs: 300 });
    const realms = proxy.getRadiusServer().listRealms();
    expect(realms).toEqual([
      { realm: 'example.com', homeServerIp: '10.0.2.2', homePort: 1812, homeSecret: 'proxy-home-secret', timeoutMs: 300 },
    ]);
  });
});
