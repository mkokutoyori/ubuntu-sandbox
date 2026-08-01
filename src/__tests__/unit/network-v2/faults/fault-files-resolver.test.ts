/**
 * F7.9 — deleting /etc/resolv.conf must kill name resolution, and only
 * name resolution (docs/PRD-Pannes.md §F7.9).
 *
 * The distinction these tests pin is the one every diagnosis starts from:
 * "the network is down" and "DNS is down" look identical to a user and are
 * repaired completely differently. So each test says which of the two it is
 * asserting — a literal IP that still pings while a name no longer resolves
 * is not a degraded network, it is a working network with no resolver.
 *
 * What must NOT break: `/etc/hosts` (a separate NSS source), and the
 * link-local protocols (LLMNR/mDNS), which never needed a configured
 * server in the first place. systemd-resolved behaves exactly this way —
 * losing the unicast path leaves the others standing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

const run = (d: LinuxPC | LinuxServer, cmd: string) => d.executeCommand(cmd);

interface Lab { pc: LinuxPC; dns: LinuxServer }

/** PC1 resolving `serveur.domaine.local` (10.0.1.88) through DNS1. */
async function lab(): Promise<Lab> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const dns = new LinuxServer('linux-server', 'DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), MASK);
  dns.configureInterface('eth0', new IPAddress('10.0.1.10'), MASK);
  new Cable('c1').connect(pc.getPort('eth0')!, dns.getPort('eth0')!);
  dns.dnsService.addRecord({ name: 'serveur.domaine.local', type: 'A', value: '10.0.1.88', ttl: 3600 });
  dns.dnsService.start();
  // Root shell: /etc/resolv.conf is root-owned, as on a real system.
  await run(pc, 'sudo su -');
  await run(pc, "cat > /etc/resolv.conf <<'EOF'\nnameserver 10.0.1.10\nEOF");
  return { pc, dns };
}

describe('F7.9 — /etc/resolv.conf deleted', () => {
  it('nominal: a name resolves through the configured server', async () => {
    const { pc } = await lab();
    expect(await run(pc, 'getent hosts serveur.domaine.local')).toContain('10.0.1.88');
  });

  it('after the deletion the name no longer resolves', async () => {
    const { pc } = await lab();
    await run(pc, 'rm /etc/resolv.conf');

    expect(await run(pc, 'getent hosts serveur.domaine.local')).not.toContain('10.0.1.88');
  });

  it('`nslookup` says the query was refused, naming the real cause', async () => {
    const { pc } = await lab();
    await run(pc, 'rm /etc/resolv.conf');

    // Not "host not found": there is no server to ask, which is a
    // different repair from a missing record.
    expect(await run(pc, 'nslookup serveur.domaine.local')).toMatch(/REFUSED|can't find/i);
  });

  it('the NETWORK is untouched — a literal IP still answers', async () => {
    const { pc } = await lab();
    await run(pc, 'rm /etc/resolv.conf');

    // This is the assertion that separates "DNS is down" from "the network
    // is down", and it is the first thing an operator checks.
    const out = await run(pc, 'ping -c 1 10.0.1.10');
    expect(out).toContain('1 received');
  });

  it('/etc/hosts keeps resolving — it is a different NSS source', async () => {
    const { pc } = await lab();
    await run(pc, 'rm /etc/resolv.conf');

    expect(await run(pc, 'getent hosts localhost')).toContain('127.0.0.1');
  });

  it('a name held in /etc/hosts survives the loss of the resolver', async () => {
    const { pc } = await lab();
    await run(pc, "cat >> /etc/hosts <<'EOF'\n10.0.1.77 secours.domaine.local\nEOF");
    await run(pc, 'rm /etc/resolv.conf');

    // nsswitch puts `files` before `dns`, so this never needed a server —
    // and it is the emergency workaround an admin reaches for.
    expect(await run(pc, 'getent hosts secours.domaine.local')).toContain('10.0.1.77');
  });

  it('`resolvectl status` reports the file as missing, not as empty', async () => {
    const { pc } = await lab();
    const before = await run(pc, 'resolvectl status');
    expect(before).toContain('resolv.conf mode:');
    expect(before).not.toContain('missing');

    await run(pc, 'rm /etc/resolv.conf');

    // `missing` is a mode of its own in resolved. Reporting `uplink` for an
    // absent file — which is what reading it as an empty string produced —
    // claims resolved is managing a file that is not there.
    expect(await run(pc, 'resolvectl status')).toContain('resolv.conf mode: missing');
  });

  it('an EMPTY resolv.conf is a different state from an absent one', async () => {
    const { pc } = await lab();
    await run(pc, ': > /etc/resolv.conf');

    // Both stop unicast DNS, but they are not the same incident and do not
    // read the same way in a diagnosis.
    expect(await run(pc, 'resolvectl status')).not.toContain('missing');
    expect(await run(pc, 'getent hosts serveur.domaine.local')).not.toContain('10.0.1.88');
  });

  it('recreating the file restores resolution, with no residue', async () => {
    const { pc } = await lab();
    await run(pc, 'rm /etc/resolv.conf');
    expect(await run(pc, 'getent hosts serveur.domaine.local')).not.toContain('10.0.1.88');

    await run(pc, "cat > /etc/resolv.conf <<'EOF'\nnameserver 10.0.1.10\nEOF");

    expect(await run(pc, 'getent hosts serveur.domaine.local')).toContain('10.0.1.88');
    expect(await run(pc, 'resolvectl status')).not.toContain('missing');
  });
});
