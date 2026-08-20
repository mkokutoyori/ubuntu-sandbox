import { describe, it, expect, beforeEach } from 'vitest';
import { SocketTable } from '@/network/core/SocketTable';
import { cmdSs, cmdNetstat } from '@/network/devices/linux/LinuxNetCommands';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';

function fixture(): SocketTable {
  const t = new SocketTable();
  t.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
  t.bind('udp', '127.0.0.53', 53, 540, 'systemd-resolve');
  t.connect('tcp', '10.0.0.1', 54321, '10.0.0.2', 80, 1200, 'curl');
  t.bind('tcp', '::1', 631, 700, 'cupsd');
  return t;
}

const services: Record<string, string> = { '22/tcp': 'ssh', '53/udp': 'domain', '80/tcp': 'http' };
const resolveService = (port: number, proto: string): string | null =>
  services[`${port}/${proto}`] ?? null;

describe('ss — service names, states, filtering', () => {
  it('resolves the port to a service name without -n', () => {
    const out = cmdSs(['-tl'], false, fixture(), resolveService);
    expect(out).toMatch(/:ssh\b/);
    expect(out).not.toMatch(/:22\b/);
  });

  it('keeps numeric ports with -n', () => {
    const out = cmdSs(['-tln'], false, fixture(), resolveService);
    expect(out).toMatch(/:22\b/);
    expect(out).not.toMatch(/:ssh\b/);
  });

  it('abbreviates TCP states the ss way (ESTAB, not ESTABLISHED)', () => {
    const out = cmdSs(['-ta'], false, fixture(), resolveService);
    expect(out).toMatch(/\bESTAB\b/);
    expect(out).not.toMatch(/ESTABLISHED/);
    expect(out).toMatch(/\bLISTEN\b/);
  });

  it('shows UNCONN for UDP sockets', () => {
    const out = cmdSs(['-ua'], false, fixture(), resolveService);
    expect(out).toMatch(/\bUNCONN\b/);
  });

  it('hides listening sockets without -a/-l', () => {
    const out = cmdSs(['-tn'], false, fixture(), resolveService);
    expect(out).toMatch(/\bESTAB\b/);
    expect(out).not.toMatch(/\bLISTEN\b/);
  });

  it('shows only listening sockets with -l', () => {
    const out = cmdSs(['-tln'], false, fixture(), resolveService);
    expect(out).toMatch(/\bLISTEN\b/);
    expect(out).not.toMatch(/\bESTAB\b/);
  });

  it('shows both with -a', () => {
    const out = cmdSs(['-tan'], false, fixture(), resolveService);
    expect(out).toMatch(/\bLISTEN\b/);
    expect(out).toMatch(/\bESTAB\b/);
  });
});

const servicePorts: Record<string, number> = { ssh: 22, http: 80, domain: 53 };
const resolveServicePort = (name: string): number | null => servicePorts[name] ?? null;

describe('ss — sport/dport filters', () => {
  it('sport = :22 keeps only source port 22', () => {
    const out = cmdSs(['-tan', 'sport', '=', ':22'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/0\.0\.0\.0:22\b/);
    expect(out).not.toMatch(/10\.0\.0\.2/);
  });

  it('dport = :80 keeps only peer port 80', () => {
    const out = cmdSs(['-tan', 'dport', '=', ':80'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/10\.0\.0\.2:80\b/);
    expect(out).not.toMatch(/0\.0\.0\.0:22\b/);
  });

  it('sport != :22 excludes source port 22', () => {
    const out = cmdSs(['-tan', 'sport', '!=', ':22'], false, fixture(), resolveService, resolveServicePort);
    expect(out).not.toMatch(/0\.0\.0\.0:22\b/);
    expect(out).toMatch(/:54321\b/);
  });

  it('sport gt :1024 keeps high source ports', () => {
    const out = cmdSs(['-tan', 'sport', 'gt', ':1024'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/:54321\b/);
    expect(out).not.toMatch(/0\.0\.0\.0:22\b/);
  });

  it('resolves a service name in the filter (sport = :ssh)', () => {
    const out = cmdSs(['-tan', 'sport', '=', ':ssh'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/0\.0\.0\.0:22\b/);
    expect(out).not.toMatch(/10\.0\.0\.2/);
  });
});

describe('ss — src/dst and address-family filters', () => {
  it('dst ADDR keeps only sockets to that peer', () => {
    const out = cmdSs(['-tan', 'dst', '10.0.0.2'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/10\.0\.0\.2:80\b/);
    expect(out).not.toMatch(/0\.0\.0\.0:22\b/);
  });

  it('src ADDR keeps only sockets bound to that address', () => {
    const out = cmdSs(['-tan', 'src', '0.0.0.0'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/0\.0\.0\.0:22\b/);
    expect(out).not.toMatch(/10\.0\.0\.2/);
  });

  it('dst ADDR:PORT matches address and port together', () => {
    const out = cmdSs(['-tan', 'dst', '10.0.0.2:80'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/10\.0\.0\.2:80\b/);
  });

  it('dst ADDR:PORT with the wrong port matches nothing', () => {
    const out = cmdSs(['-tan', 'dst', '10.0.0.2:99'], false, fixture(), resolveService, resolveServicePort);
    expect(out).not.toMatch(/10\.0\.0\.2/);
  });

  it('dst CIDR matches any peer inside the subnet', () => {
    const out = cmdSs(['-tan', 'dst', '10.0.0.0/24'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/10\.0\.0\.2:80\b/);
    expect(out).not.toMatch(/0\.0\.0\.0:22\b/);
  });

  it('dst CIDR excludes peers outside the subnet', () => {
    const out = cmdSs(['-tan', 'dst', '192.168.0.0/16'], false, fixture(), resolveService, resolveServicePort);
    expect(out).not.toMatch(/10\.0\.0\.2/);
  });

  it('src CIDR matches the bound-address subnet', () => {
    const out = cmdSs(['-tan', 'src', '10.0.0.0/24'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/10\.0\.0\.1:54321\b/);
    expect(out).not.toMatch(/0\.0\.0\.0:22\b/);
  });

  it('-4 shows only IPv4 sockets', () => {
    const out = cmdSs(['-ltan', '-4'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/0\.0\.0\.0:22\b/);
    expect(out).not.toMatch(/631/);
  });

  it('-6 shows only IPv6 sockets, bracketed', () => {
    const out = cmdSs(['-ltan', '-6'], false, fixture(), resolveService, resolveServicePort);
    expect(out).toMatch(/\[::1\]:631\b/);
    expect(out).not.toMatch(/0\.0\.0\.0:22\b/);
  });
});

describe('netstat — address family', () => {
  it('-6 marks rows tcp6 and excludes IPv4', () => {
    const out = cmdNetstat(['-ltan', '-6'], null, false, fixture(), resolveService);
    expect(out).toMatch(/^tcp6/m);
    expect(out).toMatch(/631/);
    expect(out).not.toMatch(/0\.0\.0\.0:22/);
  });

  it('-4 excludes IPv6 rows', () => {
    const out = cmdNetstat(['-ltan', '-4'], null, false, fixture(), resolveService);
    expect(out).toMatch(/0\.0\.0\.0:22/);
    expect(out).not.toMatch(/^tcp6/m);
  });
});

describe('netstat — service names, filtering, header', () => {
  it('resolves the port to a service name without -n', () => {
    const out = cmdNetstat(['-lt'], null, false, fixture(), resolveService);
    expect(out).toMatch(/:ssh\b/);
  });

  it('keeps numeric with -n', () => {
    const out = cmdNetstat(['-ltn'], null, false, fixture(), resolveService);
    expect(out).toMatch(/:22\b/);
    expect(out).not.toMatch(/:ssh\b/);
  });

  it('default hides listeners and labels them "w/o servers"', () => {
    const out = cmdNetstat(['-tn'], null, false, fixture(), resolveService);
    expect(out).toMatch(/w\/o servers/);
    expect(out).not.toMatch(/\bLISTEN\b/);
  });

  it('-l shows only listeners labelled "only servers"', () => {
    const out = cmdNetstat(['-ltn'], null, false, fixture(), resolveService);
    expect(out).toMatch(/only servers/);
    expect(out).toMatch(/\bLISTEN\b/);
  });

  it('-a shows servers and established', () => {
    const out = cmdNetstat(['-atn'], null, false, fixture(), resolveService);
    expect(out).toMatch(/servers and established/);
    expect(out).toMatch(/\bLISTEN\b/);
    expect(out).toMatch(/\bESTABLISHED\b/);
  });
});

describe('ss/netstat — end-to-end through the real NSS /etc/services', () => {
  let pc: LinuxPC;
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('ss -ltn shows the sshd listener numerically', async () => {
    const out = await pc.executeCommand('ss -ltn');
    expect(out).toMatch(/:22\b/);
  });

  it('ss -lt resolves :22 to ssh via /etc/services', async () => {
    const out = await pc.executeCommand('ss -lt');
    expect(out).toMatch(/:ssh\b/);
  });

  it('ss -tln sport = :22 filters to the sshd listener', async () => {
    const out = await pc.executeCommand('ss -tln sport = :22');
    expect(out).toMatch(/:22\b/);
  });

  it('ss -tln sport = :443 matches nothing', async () => {
    const out = await pc.executeCommand('ss -tln sport = :443');
    expect(out).not.toMatch(/:443\b/);
    expect(out).not.toMatch(/:22\b/);
  });
});
