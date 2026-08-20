/**
 * F7.1 / F7.2 — deleting sshd's own files must break SSH, for real.
 *
 * The point is NOT that an incident is reported: it is that the feature
 * stops working (docs/PRD-Pannes.md §2, objective O2). Every test here
 * asserts a FUNCTIONAL consequence — a client that can no longer log in, a
 * unit that refuses to start, a command that fails with the daemon's own
 * wording and exit code — and only then, if at all, the reporting.
 *
 * Each test follows the four-beat shape the PRD mandates (§26.2):
 * nominal → break → observe → repair, with the repair proving no residue
 * is left behind.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const MASK = new SubnetMask('255.255.255.0');

interface Lab { client: LinuxPC; srv: LinuxServer }

function lab(): Lab {
  EquipmentRegistry.getInstance().clear();
  const client = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  new Cable('c1').connect(client.getPorts()[0], srv.getPorts()[0]);
  return { client, srv };
}

const run = (d: LinuxPC | LinuxServer, cmd: string) => d.executeCommand(cmd);

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

describe('F7.1 — /etc/ssh/sshd_config deleted', () => {
  it('nominal: the service is active and a client can reach it', async () => {
    const { client, srv } = lab();

    expect(await run(srv, 'systemctl is-active ssh')).toContain('active');
    const probe = await run(client, 'nc -zv 10.0.0.2 22');
    expect(probe).toMatch(/succeeded|open/i);
  });

  it('restarting after the deletion fails, and the unit lands in failed', async () => {
    const { srv } = lab();

    await run(srv, 'sudo rm /etc/ssh/sshd_config');
    const restart = await run(srv, 'sudo systemctl restart ssh');

    // The daemon's own wording, not a paraphrase (P3).
    expect(restart).toContain('/etc/ssh/sshd_config');
    expect(restart).toMatch(/No such file or directory/);
    expect(await run(srv, 'systemctl is-active ssh')).not.toContain('active');
  });

  it('and SSH really stops answering — the feature is gone, not just flagged', async () => {
    const { client, srv } = lab();
    await run(srv, 'sudo rm /etc/ssh/sshd_config');
    await run(srv, 'sudo systemctl restart ssh');

    // This is the assertion that matters: the client cannot get in.
    const out = await run(client, 'ssh alice@10.0.0.2 hostname');
    expect(out).toMatch(/Connection refused|No route to host|refused/i);
  });

  it('an EMPTY config is legal and still starts — absent is not the same as empty', async () => {
    const { srv } = lab();

    // Real sshd runs on built-in defaults with an empty config file. Only
    // a MISSING file is fatal; conflating the two is the bug this fixes.
    await run(srv, 'sudo truncate -s 0 /etc/ssh/sshd_config');
    await run(srv, 'sudo systemctl restart ssh');

    expect(await run(srv, 'systemctl is-active ssh')).toContain('active');
  });

  it('restoring the file brings the service back with no residue', async () => {
    const { client, srv } = lab();
    await run(srv, 'sudo rm /etc/ssh/sshd_config');
    await run(srv, 'sudo systemctl restart ssh');
    expect(await run(srv, 'systemctl is-active ssh')).not.toContain('active');

    await run(srv, "sudo sh -c 'echo Port 22 > /etc/ssh/sshd_config'");
    await run(srv, 'sudo systemctl restart ssh');

    expect(await run(srv, 'systemctl is-active ssh')).toContain('active');
    const out = await run(client, 'nc -zv 10.0.0.2 22');
    expect(out).toMatch(/succeeded|open/i);
  });
});

describe('F7.2 — host keys deleted', () => {
  it('sshd refuses to start with OpenSSH\'s exact message', async () => {
    const { srv } = lab();

    await run(srv, 'sudo rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_ecdsa_key');
    const restart = await run(srv, 'sudo systemctl restart ssh');

    expect(restart).toContain('sshd: no hostkeys available -- exiting.');
    expect(await run(srv, 'systemctl is-active ssh')).not.toContain('active');
  });

  it('losing ONE algorithm is survivable — sshd needs any key, not a specific one', async () => {
    const { srv } = lab();
    // Seed a second algorithm so removing ed25519 is not fatal.
    await run(srv, "sudo sh -c 'echo stub > /etc/ssh/ssh_host_rsa_key'");

    await run(srv, 'sudo rm -f /etc/ssh/ssh_host_ed25519_key');
    await run(srv, 'sudo systemctl restart ssh');

    expect(await run(srv, 'systemctl is-active ssh')).toContain('active');
  });

  it('the config is reported before the keys, in the order sshd hits them', async () => {
    const { srv } = lab();

    await run(srv, 'sudo rm /etc/ssh/sshd_config');
    await run(srv, 'sudo rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_ecdsa_key');
    const restart = await run(srv, 'sudo systemctl restart ssh');

    // sshd reads the config first — it is what names the host keys — so a
    // missing config always wins over missing keys.
    expect(restart).toContain('sshd_config');
    expect(restart).not.toContain('no hostkeys available');
  });
});
