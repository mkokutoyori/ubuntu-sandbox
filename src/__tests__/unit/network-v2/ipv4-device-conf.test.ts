import { describe, it, expect } from 'vitest';
import { ALL_SCOPE, DEFAULT_SCOPE, IPV4_DEVICE_CONF_KNOBS, Ipv4DeviceConf } from '@/network/devices/linux/Ipv4DeviceConf';

const KNOBS = ['accept_redirects', 'send_redirects', 'secure_redirects', 'shared_media'];

describe('the per-device IPv4 configuration is the ipv4_devconf of the kernel', () => {
  it('knows the four redirect knobs, each at 1, then the ARP knobs, each at 0', () => {
    expect(IPV4_DEVICE_CONF_KNOBS.map((knob) => [knob.name, knob.initial])).toEqual([
      ...KNOBS.map((name) => [name, 1]),
      ['arp_ignore', 0],
      ['arp_accept', 0],
      ['arp_notify', 0],
      ['rp_filter', 2],
    ]);
  });

  it('has the scopes all and default, then one per interface', () => {
    expect(new Ipv4DeviceConf(['eth0', 'eth1']).scopes()).toEqual([ALL_SCOPE, DEFAULT_SCOPE, 'eth0', 'eth1']);
  });

  it.each(['all', 'default', 'eth0'])('starts every knob of %s at 1', (scope) => {
    const conf = new Ipv4DeviceConf(['eth0']);
    expect(KNOBS.map((knob) => conf.get(scope, knob))).toEqual([1, 1, 1, 1]);
  });

  it('answers 0 for a knob it does not have and refuses to write it, and has none for a scope it does not know', () => {
    const conf = new Ipv4DeviceConf(['eth0']);
    expect(conf.has('eth0', 'proxy_arp')).toBe(false);
    expect(conf.has('eth9', 'send_redirects')).toBe(false);
    expect(conf.has('eth0', 'send_redirects')).toBe(true);
    expect(conf.get('eth0', 'proxy_arp')).toBe(0);
    expect(conf.set('eth0', 'proxy_arp', 1)).toBe(false);
    expect(conf.set('eth9', 'send_redirects', 0)).toBe(false);
  });

  it.each([['0', 0], ['1', 1], ['  0\n', 0], ['-1', -1], ['42', 42]])('writes %j as %d', (text, value) => {
    const conf = new Ipv4DeviceConf(['eth0']);
    expect(conf.write('eth0', 'send_redirects', text)).toBe(true);
    expect(conf.get('eth0', 'send_redirects')).toBe(value);
  });

  it.each(['', 'yes', '1.5', '0x1', '1 2', '+1'])('refuses %j and keeps the value', (text) => {
    const conf = new Ipv4DeviceConf(['eth0']);
    expect(conf.write('eth0', 'send_redirects', text)).toBe(false);
    expect(conf.get('eth0', 'send_redirects')).toBe(1);
  });

  it('copies default to an interface when the interface appears', () => {
    const conf = new Ipv4DeviceConf([]);
    conf.set(DEFAULT_SCOPE, 'send_redirects', 0);
    conf.addInterface('eth0');
    expect(conf.get('eth0', 'send_redirects')).toBe(0);
  });

  it('says whether the interface was new', () => {
    const conf = new Ipv4DeviceConf(['eth0']);
    expect(conf.addInterface('eth1')).toBe(true);
    expect(conf.addInterface('eth1')).toBe(false);
    expect(conf.addInterface('eth0')).toBe(false);
  });

  it('forgets an interface that goes away, and starts a new one of the same name from default', () => {
    const conf = new Ipv4DeviceConf(['eth0']);
    conf.set('eth0', 'send_redirects', 0);
    expect(conf.removeInterface('eth0')).toBe(true);
    expect(conf.scopes()).toEqual([ALL_SCOPE, DEFAULT_SCOPE]);
    expect(conf.has('eth0', 'send_redirects')).toBe(false);
    expect(conf.addInterface('eth0')).toBe(true);
    expect(conf.get('eth0', 'send_redirects')).toBe(1);
  });

  it('has nothing to forget for an interface it never had', () => {
    expect(new Ipv4DeviceConf(['eth0']).removeInterface('eth9')).toBe(false);
  });

  it.each([ALL_SCOPE, DEFAULT_SCOPE])('never forgets %s', (scope) => {
    const conf = new Ipv4DeviceConf([]);
    conf.set(scope, 'send_redirects', 0);
    expect(conf.removeInterface(scope)).toBe(false);
    expect(conf.scopes()).toContain(scope);
    expect(conf.get(scope, 'send_redirects')).toBe(0);
  });

  it('stops carrying default to an interface that went away', () => {
    const conf = new Ipv4DeviceConf(['eth0']);
    conf.removeInterface('eth0');
    conf.set(DEFAULT_SCOPE, 'send_redirects', 0);
    expect(conf.has('eth0', 'send_redirects')).toBe(false);
    expect(conf.scopes()).toEqual([ALL_SCOPE, DEFAULT_SCOPE]);
  });

  it('does not reset an interface that already exists', () => {
    const conf = new Ipv4DeviceConf(['eth0']);
    conf.set('eth0', 'send_redirects', 0);
    conf.addInterface('eth0');
    expect(conf.get('eth0', 'send_redirects')).toBe(0);
  });

  it('carries a write to default to the interfaces nobody wrote to, knob by knob', () => {
    const conf = new Ipv4DeviceConf(['eth0', 'eth1']);
    conf.set('eth1', 'send_redirects', 1);
    conf.set(DEFAULT_SCOPE, 'send_redirects', 0);
    conf.set(DEFAULT_SCOPE, 'shared_media', 0);
    expect(conf.get('eth0', 'send_redirects')).toBe(0);
    expect(conf.get('eth1', 'send_redirects')).toBe(1);
    expect(conf.get('eth1', 'shared_media')).toBe(0);
    expect(conf.get(ALL_SCOPE, 'send_redirects')).toBe(1);
  });

  it('does not carry a write to all anywhere', () => {
    const conf = new Ipv4DeviceConf(['eth0']);
    conf.set(ALL_SCOPE, 'send_redirects', 0);
    expect(conf.get('eth0', 'send_redirects')).toBe(1);
    expect(conf.get(DEFAULT_SCOPE, 'send_redirects')).toBe(1);
  });

  it.each([
    ['sends', 'send_redirects'],
    ['sharesMedia', 'shared_media'],
    ['trustsOnlyListedGateways', 'secure_redirects'],
  ] as const)('%s is the OR of all and the interface on %s', (method, knob) => {
    const conf = new Ipv4DeviceConf(['eth0']);
    const states = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([all, iface]) => {
      conf.set(ALL_SCOPE, knob, all);
      conf.set('eth0', knob, iface);
      return conf[method]('eth0');
    });
    expect(states).toEqual([false, true, true, true]);
  });

  it('judges an interface it has never heard of by default', () => {
    const conf = new Ipv4DeviceConf([]);
    conf.set(ALL_SCOPE, 'send_redirects', 0);
    expect(conf.sends('eth7')).toBe(true);
    conf.set(DEFAULT_SCOPE, 'send_redirects', 0);
    expect(conf.sends('eth7')).toBe(false);
  });

  it('accepts redirects as the OR of all and the interface on a host, and the AND on a router', () => {
    const conf = new Ipv4DeviceConf(['eth0']);
    const accepts = (forwarding: boolean): boolean[] => [[0, 0], [0, 1], [1, 0], [1, 1]].map(([all, iface]) => {
      conf.set(ALL_SCOPE, 'accept_redirects', all);
      conf.set('eth0', 'accept_redirects', iface);
      return conf.accepts('eth0', forwarding);
    });
    expect(accepts(false)).toEqual([false, true, true, true]);
    expect(accepts(true)).toEqual([false, false, false, true]);
  });

  it('turns accept_redirects of all off when forwarding is enabled and on when it is disabled', () => {
    const conf = new Ipv4DeviceConf(['eth0']);
    conf.forwardingChanged(true);
    expect(conf.get(ALL_SCOPE, 'accept_redirects')).toBe(0);
    expect(conf.get(DEFAULT_SCOPE, 'accept_redirects')).toBe(1);
    expect(conf.get('eth0', 'accept_redirects')).toBe(1);
    conf.forwardingChanged(false);
    expect(conf.get(ALL_SCOPE, 'accept_redirects')).toBe(1);
  });
});
