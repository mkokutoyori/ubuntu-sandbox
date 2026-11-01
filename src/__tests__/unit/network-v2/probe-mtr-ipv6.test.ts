/**
 * `mtr -6`, `mtr -4` et un litteral IPv6 seul. Mesure de depart : `mtr -6` repondait « unrecognized option '-6' » (le texte d'usage annonce pourtant `-4*6*`), un litteral IPv6 « Failed to resolve host »,
 * et ni la voie rapport (`MtrReport`, un tube ou un script) ni la voie interactive (`planMtr`, le terminal) n'avaient de chemin IPv6. La decouverte des sauts est celle de `traceroute -6`
 * (`EndHost.executeTraceroute6`, une seule boucle de sauts) et la mesure par saut un echo ICMPv6 (`sendPingProbeSync6`, jumeau synchrone de la version IPv4, meme abonnement au bus de la machine).
 * `-4` force IPv4 comme avant ; sans option, un nom reste resolu en IPv4 et un litteral contenant « : » choisit IPv6, comme pour `traceroute`.
 *
 * Discrimine par `git stash` sur src/network et src/terminal : 6 des 7 cas tombent avant. TEMOIN : la trace IPv4 sans option, seul cas qui passe des deux cotes (`-4` n'etait pas reconnu avant : le cas `-4` tombe).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import { EventBus } from '@/events/EventBus';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { IPv6Packet } from '@/network/core/types';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

type Machine = LinuxPC | LinuxServer;

async function lab() {
  const a = new LinuxPC('linux-pc', 'A');
  const gw = new LinuxServer('linux-server', 'GW');
  const b = new LinuxPC('linux-pc', 'B');
  for (const device of [a, gw, b]) device.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, gw.getPort('eth0')!);
  new Cable('c2').connect(gw.getPort('eth1')!, b.getPort('eth0')!);
  const run = async (device: Machine, command: string): Promise<string> => {
    const machine = device as unknown as { executor: { runAsUser<T>(user: string, work: () => Promise<T>): Promise<T> } };
    return String(await machine.executor.runAsUser('root', () => device.executeCommand(command))).trim();
  };
  for (const [device, lines] of [
    [a, ['sysctl -w net.ipv6.conf.all.accept_ra=0', 'ip -6 addr add 2001:db8:1::2/64 dev eth0', 'ip -6 route add default via 2001:db8:1::1']],
    [gw, ['ip -6 addr add 2001:db8:1::1/64 dev eth0', 'ip -6 addr add 2001:db8:2::1/64 dev eth1', 'sysctl -w net.ipv6.conf.all.forwarding=1']],
    [b, ['sysctl -w net.ipv6.conf.all.accept_ra=0', 'ip -6 addr add 2001:db8:2::2/64 dev eth0', 'ip -6 route add default via 2001:db8:2::1']],
  ] as const) {
    for (const line of lines) await run(device, line);
  }
  return { a, gw, b, run };
}


describe('mtr over IPv6 (report form)', () => {
  it('-6 lists the gateway and the target', async () => {
    const { a, run } = await lab();
    const out = await run(a, 'mtr -6 -n -r -c 1 2001:db8:2::2');
    expect(out).toMatch(/^\s*1\.\s+2001:db8:1::1\s/m);
    expect(out).toMatch(/^\s*2\.\s+2001:db8:2::2\s/m);
  });

  it('an IPv6 literal alone selects the family', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'mtr -n -r -c 1 2001:db8:2::2')).toMatch(/^\s*2\.\s+2001:db8:2::2\s/m);
  });

  it('-4 on an IPv6 literal does not resolve', async () => {
    const { a, run } = await lab();
    expect(await run(a, 'mtr -4 -n -r -c 1 2001:db8:2::2')).toBe('mtr: Failed to resolve host: 2001:db8:2::2');
  });

  it('a name from /etc/hosts resolves to its IPv6 address under -6', async () => {
    const { a, run } = await lab();
    await run(a, "sh -c 'echo \"2001:db8:2::2 farhost\" >> /etc/hosts'");
    expect(await run(a, 'mtr -6 -n -r -c 1 farhost')).toMatch(/^\s*2\.\s+2001:db8:2::2\s/m);
  });

  async function ipv4Lab() {
    const parts = await lab();
    const { a, gw, b, run } = parts;
    await run(a, 'ip addr add 10.0.1.2/24 dev eth0');
    await run(gw, 'ip addr add 10.0.1.1/24 dev eth0');
    await run(gw, 'ip addr add 10.0.2.1/24 dev eth1');
    await run(b, 'ip addr add 10.0.2.2/24 dev eth0');
    await run(a, 'ip route add default via 10.0.1.1');
    await run(b, 'ip route add default via 10.0.2.1');
    await run(gw, 'sysctl -w net.ipv4.ip_forward=1');
    return parts;
  }

  it('WITNESS — an IPv4 trace without option still works', async () => {
    const { a, run } = await ipv4Lab();
    expect(await run(a, 'mtr -n -r -c 1 10.0.2.2')).toMatch(/^\s*2\.\s+10\.0\.2\.2\s/m);
  });

  it('-4 forces IPv4', async () => {
    const { a, run } = await ipv4Lab();
    expect(await run(a, 'mtr -4 -n -r -c 1 10.0.2.2')).toMatch(/^\s*2\.\s+10\.0\.2\.2\s/m);
  });
});

describe('mtr over IPv6 (interactive form)', () => {
  it('-6 -r in the terminal prints the IPv6 hops and unlocks the prompt', async () => {
    const { a } = await lab();
    const manager = new TerminalManager(new EventBus());
    const session = manager.getSession(manager.openTerminal(a)!) as LinuxTerminalSession;
    session.setInput('mtr -6 -n -r -c 1 2001:db8:2::2');
    session.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    for (let i = 0; i < 80 && (session.hasForegroundAsyncJob || session.lines.length < 3); i++) await new Promise((r) => setTimeout(r, 50));
    const text = session.lines.map((l) => l.text).join('\n');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(text).toMatch(/\s1\.\s+2001:db8:1::1\s/);
    expect(text).toMatch(/\s2\.\s+2001:db8:2::2\s/);
  });
});
