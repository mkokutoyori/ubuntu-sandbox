/*
 * What the recording of hostname 3.23 (hostname-oracle.test.ts) could not reach, read from hostname.c (Debian 3.23+nmu2ubuntu2) and checked on the machine:
 * - the interface side of -I and -A for IPv6 (the recording kernel has no IPv6 stack, so no address could be put on an interface there): getifaddrs is walked, an entry with no address, a loopback, an
 *   interface that is not UP, a family other than IPv4 and IPv6, an IPv6 link-local (fe80::/10) and a link-local multicast (ff02::) are skipped, every other address is printed followed by a space (-I) or,
 *   for -A, its reverse name when it has one (the others are skipped without a word), and the line ends with a newline even when it is empty; the kernel lists the IPv4 addresses of all the interfaces
 *   before their IPv6 addresses (rtnetlink dumps one family after the other);
 * - the NIS domain name lives in the kernel next to the host name: /proc/sys/kernel/domainname shows what domainname sets, writing it sets what domainname shows, a name longer than 64 bytes is refused;
 * - /etc/host.conf ships with the machine (base-files of Ubuntu 24.04: `order hosts,bind`, `multi on`), because the merge of /etc/hosts lines that -a performs is its `multi on`;
 * - glibc 2.39 computes no common prefix between two IPv4 destinations when it does not know the prefix length of the source (measured with the real hostname -i: with a default route every
 *   destination is usable, 10.5.5.1 shares /24 with the source 10.5.5.9 and 203.0.113.1 shares nothing, and the order of /etc/hosts is kept in both directions).
 * Measured before the change (git stash push -- src/network src/powershell; the new modules are untracked and stay in place, so the pure-function cases of the first group still load): 5 of the 13 cases
 * fall - the IPv6 listing, the kernel domain name, /etc/host.conf, the five program names and the IPv4 prefix. The host name coherence and the root refusal pass either way (non-regression), as do the pure-function
 * cases, which only exercise the new module. The WITNESSES pass either way: one proves the fake host prints a plain IPv4 address, the other that the lab puts the address on eth0.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters, MACAddress, IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { runHostname, type HostnameHost, type InterfaceAddress } from '@/network/devices/linux/hostname/HostnameTool';
import { GLIBC_POLICY, orderDestinations } from '@/network/layers/internet/DestinationSelection';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function fakeHost(addresses: readonly InterfaceAddress[], reverse: Readonly<Record<string, string>> = {}): HostnameHost {
  return {
    hostname: () => 'box.example',
    setHostname: () => 'ok',
    domainName: () => '(none)',
    setDomainName: () => 'ok',
    readFile: () => ({ error: 'No such file or directory' }),
    addressInfo: async () => ({ canonicalName: 'box.example', addresses: [] }),
    hostByName: async () => ({ name: 'box.example', aliases: [] }),
    interfaceAddresses: () => addresses,
    nameOfAddress: async (address) => reverse[address] ?? null,
  };
}

const entry = (address: string, options: Partial<InterfaceAddress> = {}): InterfaceAddress =>
  ({ address, family: address.includes(':') ? 10 : 2, loopback: false, up: true, ...options });

const run = async (args: string[], host: HostnameHost): Promise<string> => (await runHostname('hostname', args, host)).stdout;

describe('hostname: the interface walk of hostname.c', () => {
  it('WITNESS: a plain IPv4 address is printed followed by a space', async () => {
    expect(await run(['-I'], fakeHost([entry('10.1.1.5')]))).toBe('10.1.1.5 \n');
  });

  it('-I skips loopback, down interfaces, IPv6 link-local and link-local multicast, and keeps global IPv6', async () => {
    const host = fakeHost([
      entry('127.0.0.1', { loopback: true }), entry('10.1.1.5'), entry('10.2.2.2', { up: false }),
      entry('fe80::1'), entry('febf::1'), entry('ff02::1'), entry('ff05::1'), entry('2001:db8::5'), entry('fd00::7'),
    ]);
    expect(await run(['-I'], host)).toBe('10.1.1.5 ff05::1 2001:db8::5 fd00::7 \n');
  });

  it('-I with no address prints an empty line', async () => {
    expect(await run(['-I'], fakeHost([]))).toBe('\n');
    expect(await run(['-I'], fakeHost([entry('127.0.0.1', { loopback: true })]))).toBe('\n');
  });

  it('-A prints the reverse name of each address and skips the addresses without one', async () => {
    const host = fakeHost([entry('10.1.1.5'), entry('10.1.1.6'), entry('2001:db8::5')], { '10.1.1.5': 'a.example', '2001:db8::5': 'six.example' });
    expect(await run(['-A'], host)).toBe('a.example six.example \n');
    expect(await run(['-A'], fakeHost([entry('10.1.1.6')]))).toBe('\n');
  });

  it('keeps the order the host lists the addresses in', async () => {
    const host = fakeHost([entry('10.9.9.9'), entry('10.1.1.5'), entry('2001:db8::5'), entry('10.0.0.1')]);
    expect(await run(['-I'], host)).toBe('10.9.9.9 10.1.1.5 2001:db8::5 10.0.0.1 \n');
  });
});

describe('hostname: the machine', () => {
  async function pc(): Promise<LinuxPC> {
    const machine = new LinuxPC('H', 0, 0);
    await machine.executeCommand('ip addr add 10.1.1.5/24 dev eth0');
    await machine.executeCommand('ip link set eth0 up');
    return machine;
  }
  const asRoot = (machine: LinuxPC, command: string): Promise<string> =>
    (machine as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } })
      .executor.runAsUser('root', () => machine.executeCommand(command));

  it('WITNESS: the lab gives eth0 its IPv4 address', async () => {
    expect(await asRoot(await pc(), 'ip -4 addr show dev eth0')).toContain('10.1.1.5/24');
  });

  it('-I lists the IPv4 addresses before the IPv6 ones and leaves the link-local address out', async () => {
    const machine = await pc();
    await asRoot(machine, 'ip -6 addr add 2001:db8::5/64 dev eth0');
    await asRoot(machine, 'ip addr add 10.1.2.5/24 dev eth1');
    await asRoot(machine, 'ip link set eth1 up');
    const shown = await asRoot(machine, 'hostname -I');
    expect(shown).toBe('10.1.1.5 10.1.2.5 2001:db8::5 ');
    expect(await asRoot(machine, 'ip -6 addr show dev eth0')).toContain('fe80::');
  });

  it('the NIS domain name is the kernel one: /proc, sysctl and domainname agree', async () => {
    const machine = await pc();
    expect(await asRoot(machine, 'cat /proc/sys/kernel/domainname')).toBe('(none)');
    await asRoot(machine, 'domainname nis.example');
    expect(await asRoot(machine, 'cat /proc/sys/kernel/domainname')).toBe('nis.example');
    expect(await asRoot(machine, 'sysctl -n kernel.domainname')).toBe('nis.example');
    await asRoot(machine, 'echo other.example > /proc/sys/kernel/domainname');
    expect(await asRoot(machine, 'domainname')).toBe('other.example');
    expect(await asRoot(machine, 'hostname -y')).toBe('other.example');
  });

  it('the host name set by hostname is the one /proc/sys/kernel/hostname and uname -n show', async () => {
    const machine = await pc();
    await asRoot(machine, 'hostname renamed.example');
    expect(await asRoot(machine, 'cat /proc/sys/kernel/hostname')).toBe('renamed.example');
    expect(await asRoot(machine, 'uname -n')).toBe('renamed.example');
  });

  it('a user other than root is refused, and sudo makes it root', async () => {
    const machine = await pc();
    expect(await machine.executeCommand('hostname other')).toBe('hostname: you must be root to change the host name\n');
    expect(await machine.executeCommand('sudo hostname other')).toBe('');
    expect(await machine.executeCommand('hostname')).toBe('other');
  });

  it('ships /etc/host.conf with multi on, as base-files does', async () => {
    const machine = await pc();
    expect(await machine.executeCommand('cat /etc/host.conf')).toBe(
      '# The "order" line is only used by old versions of the C library.\norder hosts,bind\nmulti on',
    );
  });

  it('answers to its five names', async () => {
    const machine = await pc();
    for (const name of ['hostname', 'domainname', 'dnsdomainname', 'ypdomainname', 'nisdomainname']) {
      expect(await machine.executeCommand(`${name} -V`)).toBe('hostname 3.23');
    }
  });
});

describe('getaddrinfo ordering of IPv4 destinations under glibc', () => {
  it('keeps the order of the file when the source carries no prefix length', () => {
    const port = { sourceFor: () => ({ address: new IPAddress('10.5.5.9') }) };
    const destinations = ['203.0.113.1', '10.5.5.1', '198.51.100.7', '10.5.5.200'].map((text) => new IPAddress(text));
    const ordered = orderDestinations(destinations, (address) => address, port, GLIBC_POLICY).map((address) => address.toString());
    expect(ordered).toEqual(['203.0.113.1', '10.5.5.1', '198.51.100.7', '10.5.5.200']);
  });
});
