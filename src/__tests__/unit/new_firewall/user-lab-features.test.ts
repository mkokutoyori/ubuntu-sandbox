/*
 * The user's lab (lan_with_firewall_fortigate.topology): every feature
 * delivered on this branch is exercised on that topology, unchanged —
 * only device configuration is added (a static route on FW1 and Router2,
 * PC1's address, nginx on Server1, SSH keys).
 *
 * LAN 192.168.1.0/24 (PC1, PC2, Router2) — FW1 port1 / port2 — R3 —
 * HQ 192.168.30.0/24 (Server1, WinServer1, PC3). FW1 policy 1 allows
 * LAN_SUBNET -> HQ_ADDRESS with NAT; nothing allows HQ -> LAN.
 */
import { describe, it, expect } from 'vitest';
import { loadUserLab, type UserLab } from './userLab';
import { taper, grantKeyAccess } from './fortigateBatteryHarness';

async function configuredLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  await taper(lab.FW1, [
    'config router static', 'edit 1', 'set dst 192.168.30.0 255.255.255.0',
    'set gateway 192.168.20.1', 'set device "port2"', 'next', 'end',
  ]);
  await taper(lab.PC1, ['ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.99']);
  await taper(lab.Server1, ['systemctl start nginx']);
  return lab;
}

describe('user lab — curl through FW1', () => {
  it('a LAN host reaches the HQ web server through policy 1', async () => {
    const lab = await configuredLab();
    expect(await lab.PC1.executeCommand('curl -sS --connect-timeout 3 http://192.168.30.4/')).toMatch(/nginx/i);
  });

  it('a closed port answers curl 8 code 7 through the firewall', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand('curl -sS --connect-timeout 3 http://192.168.30.4:81/; echo EC=$?');
    expect(out).toMatch(/^curl: \(7\) Failed to connect to 192\.168\.30\.4 port 81 after \d+ ms: Couldn't connect to server$/m);
    expect(out).toContain('EC=7');
  });

  it('HQ -> LAN is dropped by the implicit deny: --connect-timeout gives 28', async () => {
    const lab = await configuredLab();
    const out = await lab.PC3.executeCommand('curl -sS --connect-timeout 3 http://192.168.1.10/; echo EC=$?');
    expect(out).toMatch(/^curl: \(28\) Failed to connect to 192\.168\.1\.10 port 80 after 30\d\d ms: Timeout was reached$/m);
    expect(out).toContain('EC=28');
  });

  it('-m bounds the same dropped connection', async () => {
    const lab = await configuredLab();
    expect(await lab.PC3.executeCommand('curl -sS -m 2 http://192.168.1.10/'))
      .toMatch(/after 20\d\d ms: Timeout was reached/);
  });
});

describe('user lab — FW1 diagnostics', () => {
  it('the routing table carries no connected default route', async () => {
    const lab = await configuredLab();
    const table = await lab.FW1.executeCommand('get router info routing-table all');
    expect(table).toMatch(/^S\s+192\.168\.30\.0\/24 .*via 192\.168\.20\.1, port2/m);
    expect(table).not.toMatch(/0\.0\.0\.0\/0/);
  });

  it('the sniffer shows the handshake with its real numbers', async () => {
    const lab = await configuredLab();
    await lab.PC1.executeCommand('curl -s -o /dev/null --connect-timeout 3 http://192.168.30.4/');
    const trace = await lab.FW1.executeCommand("diagnose sniffer packet any 'host 192.168.30.4' 4 20");
    expect(trace).toMatch(/port1 .*192\.168\.1\.10\.\d+ -> 192\.168\.30\.4\.80: syn \d+$/m);
    expect(trace).toMatch(/port2 .*192\.168\.20\.2\.\d+ -> 192\.168\.30\.4\.80: syn \d+$/m);
    expect(trace).toMatch(/192\.168\.30\.4\.80 -> 192\.168\.20\.2\.\d+: syn \d+ ack \d+$/m);
    expect(trace).not.toMatch(/undefined|: syn -/);
  });
});

describe('user lab — ssh -J through FW1', () => {
  it('PC1 reaches PC3 through Server1 as a bastion', async () => {
    const lab = await configuredLab();
    await taper(lab.PC3, ['systemctl start ssh', 'hostnamectl set-hostname PC3-HQ']);
    await grantKeyAccess(lab.PC1, lab.Server1);
    await grantKeyAccess(lab.PC1, lab.PC3);
    const out = await lab.PC1.executeCommand('ssh -o PasswordAuthentication=no -J user@192.168.30.4 user@192.168.30.3 hostname; echo EC=$?');
    expect(out).toMatch(/^PC3-HQ$/m);
    expect(out).toContain('EC=0');
    expect(await lab.PC3.executeCommand('cat /var/log/auth.log')).toMatch(/Accepted publickey for user from 192\.168\.30\.4/);
  });
});
