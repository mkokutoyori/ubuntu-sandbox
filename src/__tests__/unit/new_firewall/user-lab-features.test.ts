/*
 * The user's lab (lan_with_firewall_fortigate.topology): every feature
 * delivered on this branch is exercised on that topology, imported as
 * exported. Configuration is added afterwards through each device's CLI:
 * addRoutesToHq types the routes to HQ on Router2 and FW1, and the tests
 * add PC1's address, services and SSH keys.
 *
 * LAN 192.168.1.0/24 (PC1, PC2, Router2) — FW1 port1 / port2 — R3 —
 * HQ 192.168.30.0/24 (Server1, WinServer1, PC3). FW1 policy 1 allows
 * LAN_SUBNET -> HQ_ADDRESS with NAT; nothing allows HQ -> LAN.
 */
import { describe, it, expect } from 'vitest';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper, grantKeyAccess } from './fortigateBatteryHarness';

async function configuredLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  await addRoutesToHq(lab);
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

describe('user lab — everyday tools across FW1', () => {
  it('ping crosses policy 1 and the answer comes back through the NAT', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand('ping -c 2 192.168.30.4');
    expect(out).toMatch(/^64 bytes from 192\.168\.30\.4: icmp_seq=1 ttl=62 /m);
    expect(out).toContain('2 packets transmitted, 2 received, 0% packet loss');
  });

  it('ping from HQ to the LAN meets the implicit deny', async () => {
    const lab = await configuredLab();
    expect(await lab.PC3.executeCommand('ping -c 2 -W 1 192.168.1.10'))
      .toContain('2 packets transmitted, 0 received, 100% packet loss');
  });

  it('arping finds FW1 and PC2 on the LAN', async () => {
    const lab = await configuredLab();
    expect(await lab.PC1.executeCommand('arping -c 1 -I eth0 192.168.1.99'))
      .toMatch(/^Unicast reply from 192\.168\.1\.99 \[[0-9A-F:]{17}\]/im);
    expect(await lab.PC1.executeCommand('arping -c 1 -I eth0 192.168.1.2'))
      .toMatch(/^Unicast reply from 192\.168\.1\.2 /m);
  });

  it('traceroute lists FW1, R3 and the server', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand('traceroute -n 192.168.30.4');
    expect(out).toMatch(/^ 1  192\.168\.1\.99 /m);
    expect(out).toMatch(/^ 2  192\.168\.20\.1 /m);
    expect(out).toMatch(/^ 3  192\.168\.30\.4 /m);
  });

  it('ping -t 2 names R3 behind the NAT', async () => {
    const lab = await configuredLab();
    expect(await lab.PC1.executeCommand('ping -c 1 -t 2 192.168.30.4'))
      .toContain('From 192.168.20.1 icmp_seq=1 Time to live exceeded');
  });

  it('tnsping reaches the listener of Server1 through FW1', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand('tnsping 192.168.30.4:1521/ORCL');
    expect(out).toContain('(HOST = 192.168.30.4)(PORT = 1521)');
    expect(out).toMatch(/^OK \(\d+ msec\)$/m);
  });

  it('ssh logs in on Server1 with a key, through FW1', async () => {
    const lab = await configuredLab();
    await grantKeyAccess(lab.PC1, lab.Server1);
    expect(await lab.PC1.executeCommand('ssh -o PasswordAuthentication=no user@192.168.30.4 whoami; echo EC=$?'))
      .toMatch(/^user\nEC=0$/m);
    expect(await lab.Server1.executeCommand('cat /var/log/auth.log')).toMatch(/Accepted publickey for user from 192\.168\.20\.2/);
  });

  it('curl ftp downloads and lists through the FTP session helper', async () => {
    const lab = await configuredLab();
    await taper(lab.Server1, ['apt install -y vsftpd', 'systemctl start vsftpd', 'echo HELLO_FTP > /srv/ftp/hello.txt']);
    expect(await lab.PC1.executeCommand('curl -sS --connect-timeout 3 ftp://192.168.30.4/hello.txt; echo EC=$?'))
      .toMatch(/^HELLO_FTP\nEC=0$/m);
    expect(await lab.PC1.executeCommand('curl -sS --connect-timeout 3 ftp://192.168.30.4/'))
      .toMatch(/ hello\.txt$/m);
  });

  it('systemctl is-active answers for every unit of Server1', async () => {
    const lab = await configuredLab();
    await taper(lab.Server1, ['systemctl stop vsftpd']);
    expect(await lab.Server1.executeCommand('systemctl is-active nginx ssh vsftpd; echo EC=$?'))
      .toBe('active\nactive\ninactive\nEC=0');
  });
});

describe('user lab — PC2 through Router2', () => {
  it('the routes typed after the import are in both routing tables', async () => {
    const lab = await loadUserLab();
    await addRoutesToHq(lab);
    await lab.Router2.executeCommand('enable');
    expect(await lab.Router2.executeCommand('show ip route static')).toMatch(/^S\s+192\.168\.30\.0\/24 \[1\/0\] via 192\.168\.1\.99$/m);
    expect(await lab.FW1.executeCommand('get router info routing-table static'))
      .toMatch(/^S\s+192\.168\.30\.0\/24 \[10\/0\] via 192\.168\.20\.1, port2$/m);
  });

  it('PC2 reaches Server1 through Router2, FW1 and R3', async () => {
    const lab = await loadUserLab();
    await addRoutesToHq(lab);
    const trace = await lab.PC2.executeCommand('tracert -d 192.168.30.4');
    expect(trace).toMatch(/^\s+1\s.*192\.168\.1\.1$/m);
    expect(trace).toMatch(/^\s+2\s.*192\.168\.1\.99$/m);
    expect(trace).toMatch(/^\s+3\s.*192\.168\.20\.1$/m);
    expect(trace).toMatch(/^\s+4\s.*192\.168\.30\.4$/m);
    expect(await lab.PC2.executeCommand('ping -n 2 192.168.30.4')).toContain('Received = 2, Lost = 0 (0% loss)');
  });
});
