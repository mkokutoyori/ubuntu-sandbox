/*
 * nmap on the user's lab (lan_with_firewall_fortigate.topology), imported
 * as exported and configured afterwards through each device's CLI — the
 * same lab and the same helpers as user-lab-features.test.ts.
 *
 * LAN 192.168.1.0/24 (PC1, PC2, Router2) — FW1 port1 / port2 — R3 —
 * HQ 192.168.30.0/24 (Server1, WinServer1, PC3). FW1 policy 1 allows
 * LAN_SUBNET -> HQ_ADDRESS with NAT; nothing allows HQ -> LAN.
 *
 * Why this lab and not a direct link. nmap does ARP discovery whenever it
 * can ("The -PR option is deprecated. ARP scan is always done when
 * possible."), and an ARP reply SHORT-CIRCUITS every IP ping: on a direct
 * link `-PS`, `-PA`, `-PU`, `-PE` and `-PO` all report `arp-response` and
 * none of them is ever exercised. Server1 is off-link from PC1, so here —
 * and only here — each `-P` form actually puts its own packet on the wire
 * and its own reason comes back.
 *
 * Three results this path produces that a direct link cannot:
 *   - `-PS80` is up on `syn-ack` while `-PA80` reports the host DOWN. The
 *     bare ACK belongs to no session, so FW1 drops it; the SYN matches
 *     policy 1 and goes through. That asymmetry is what an ACK ping is
 *     for, and it needs a stateful firewall in the path.
 *   - `-PE` names the ttl of the reply: `received echo-reply ttl 62`, two
 *     hops down from the 64 the target emitted.
 *   - `Network Distance: 3 hops` (`FPEngine.cc:1559-1568` — one for a
 *     directly connected target, else `sent_ttl - rcvd_ttl + 1`), which
 *     agrees with the three hops `--traceroute` walks.
 *
 * Every expectation below was MEASURED on this lab before being written.
 *
 * DISCRIMINATION mesuree par `git stash push -- src/network` : 10 des 17
 * cas de ce fichier tombent avant le lot — les cinq formes `-P`, le refus
 * nomme, les deux cas de `-sL`, le bloc `-O` et la distance d'un saut vers
 * FW1. Les SEPT qui ne discriminent pas sont des temoins du chemin, et ils
 * comptent : la table des ports, `-sV`, `-sn`, `--traceroute`, le deny
 * implicite depuis HQ, et les deux cas d'`allowaccess` sur les interfaces
 * de FW1 — sans eux, une suite faite de refus et de silences ne prouverait
 * pas que le laboratoire lui-meme repond.
 */
import { describe, it, expect } from 'vitest';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';

const SERVER1 = '192.168.30.4';
const PC1_ADDRESS = '192.168.1.10';
const FW1_PORT1 = '192.168.1.99';
const FW1_PORT2 = '192.168.20.2';

async function configuredLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  await addRoutesToHq(lab);
  await taper(lab.PC1, [
    'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.99',
  ]);
  await taper(lab.Server1, ['systemctl start nginx', 'systemctl start ssh']);
  return lab;
}

describe('user lab — nmap host discovery puts the asked-for packet on the wire', () => {
  it('-PS80 finds Server1 through policy 1, on its syn-ack', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -PS80 --reason -p 80 ${SERVER1}`);
    expect(out).toMatch(/^Host is up, received syn-ack \(/m);
    expect(out).toMatch(/^80\/tcp open {2}http {4}syn-ack$/m);
  });

  it('-PA80 reports the host DOWN, because FW1 drops a session-less ACK', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -PA80 --reason -p 80 ${SERVER1}`);
    expect(out).toContain('[host down, received no-response]');
    expect(out).toContain('Note: Host seems down. If it is really up,'
      + ' but blocking our ping probes, try -Pn');
  });

  it('-PE names the ttl of the reply, two hops down from what Server1 emitted', async () => {
    const lab = await configuredLab();
    expect(await lab.PC1.executeCommand(`nmap -PE --reason -p 80 ${SERVER1}`))
      .toMatch(/^Host is up, received echo-reply ttl 62 \(/m);
  });

  it('-PU on the default probe port is up on the port-unreachable it draws', async () => {
    const lab = await configuredLab();
    expect(await lab.PC1.executeCommand(`nmap -PU --reason -p 80 ${SERVER1}`))
      .toMatch(/^Host is up, received port-unreach \(/m);
  });

  it('-PO is up on the protocol-unreachable RFC 1122 makes Server1 send', async () => {
    const lab = await configuredLab();
    expect(await lab.PC1.executeCommand(`nmap -PO --reason -p 80 ${SERVER1}`))
      .toMatch(/^Host is up, received proto-unreach \(/m);
  });

  it('a -P form this simulator cannot build is refused by name', async () => {
    const lab = await configuredLab();
    expect(await lab.PC1.executeCommand(`nmap -PM ${SERVER1}`))
      .toBe('nmap: option -PM: this simulator cannot build'
        + ' an ICMP address-mask request (type 17)');
    expect(await lab.PC1.executeCommand(`nmap -PZ ${SERVER1}`))
      .toBe('Unknown -P option -PZ.');
    expect(await lab.PC1.executeCommand(`nmap -PS22 -PS80 ${SERVER1}`))
      .toBe('Only one -PS option is allowed. Combine port ranges with commas.');
  });
});

describe('user lab — nmap -sL lists without touching the wire', () => {
  it('every address of the HQ range is listed, and none counts as up', async () => {
    const lab = await configuredLab();
    const out = (await lab.PC1.executeCommand('nmap -sL 192.168.30.1-4')).split('\n');
    expect(out[0]).toBe('Starting Nmap 7.94 ( https://nmap.org )');
    expect(out.slice(1, 5)).toEqual([
      'Nmap scan report for 192.168.30.1',
      'Nmap scan report for 192.168.30.2',
      'Nmap scan report for 192.168.30.3',
      'Nmap scan report for 192.168.30.4',
    ]);
    expect(out[5]).toMatch(/^Nmap done: 4 IP addresses \(0 hosts up\) scanned in /);
  });

  it('the list carries no port table and no host-status line', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -sL ${SERVER1}`);
    expect(out).toContain(`Nmap scan report for ${SERVER1}`);
    expect(out).not.toContain('Host is up');
    expect(out).not.toContain('PORT');
  });
});

describe('user lab — nmap -O across three hops', () => {
  it('the OS block carries its class, its CPEs and the hop distance', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -O -p 80 ${SERVER1}`);
    expect(out).toMatch(/^Device type: general purpose$/m);
    expect(out).toMatch(/^Running: Linux 4\.X\|5\.X$/m);
    expect(out).toMatch(
      /^OS CPE: cpe:\/o:linux:linux_kernel:4 cpe:\/o:linux:linux_kernel:5$/m);
    expect(out).toMatch(/^OS details: Linux 4\.15 - 5\.19$/m);
    expect(out).toMatch(/^Network Distance: 3 hops$/m);
  });

  it('the hop distance agrees with the path --traceroute walks', async () => {
    const lab = await configuredLab();
    const trace = await lab.PC1.executeCommand(`nmap --traceroute -p 80 ${SERVER1}`);
    expect(trace).toMatch(/^1\s+[\d.]+ ms 192\.168\.1\.99$/m);
    expect(trace).toMatch(/^2\s+[\d.]+ ms 192\.168\.20\.1$/m);
    expect(trace).toMatch(/^3\s+[\d.]+ ms 192\.168\.30\.4$/m);
  });
});

describe('user lab — nmap through and against the policy', () => {
  it('the port table names what HQ really serves', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -p 22,80,81 ${SERVER1}`);
    expect(out).toMatch(/^22\/tcp open {3}ssh$/m);
    expect(out).toMatch(/^80\/tcp open {3}http$/m);
    expect(out).toMatch(/^81\/tcp closed hosts2-ns$/m);
  });

  it('-sV reads the versions of both HQ services through the NAT', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -sV -p 22,80 ${SERVER1}`);
    expect(out).toMatch(/^22\/tcp open {2}ssh {5}OpenSSH_8\.9p1 \(protocol 2\.0\)$/m);
    expect(out).toMatch(/^80\/tcp open {2}http {4}nginx 1\.24\.0$/m);
  });

  it('-sn reports the host without a port table', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -sn ${SERVER1}`);
    expect(out).toMatch(/^Host is up \(/m);
    expect(out).not.toContain('PORT');
    expect(out).toMatch(/^Nmap done: 1 IP address \(1 host up\) scanned in /m);
  });

  it('a scan from HQ towards the LAN meets the implicit deny', async () => {
    const lab = await configuredLab();
    const out = await lab.PC3.executeCommand(`nmap -p 80 --reason ${PC1_ADDRESS}`);
    expect(out).toContain('[host down, received no-response]');
    expect(out).toMatch(/^Nmap done: 1 IP address \(0 hosts up\) scanned in /m);
  });
});

describe('user lab — nmap against FW1 own interfaces', () => {
  it('allowaccess decides: a served port is open, a refused one FILTERED, an unserved one closed', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(
      `nmap -p 22,23,80,443,541 --reason ${FW1_PORT1}`);
    expect(out).toMatch(/^Host is up, received arp-response \(/m);
    expect(out).toMatch(/^22\/tcp {2}open {5}ssh {5}syn-ack$/m);
    expect(out).toMatch(/^23\/tcp {2}filtered telnet {2}no-response$/m);
    expect(out).toMatch(/^80\/tcp {2}open {5}http {4}syn-ack$/m);
    expect(out).toMatch(/^443\/tcp open {5}https {3}syn-ack$/m);
    expect(out).toMatch(/^541\/tcp closed {3}unknown reset$/m);
  });

  it('the two FW1 interfaces do not allow the same services', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -p 22,80,443 ${FW1_PORT2}`);
    expect(out).toMatch(/^22\/tcp {2}open {5}ssh$/m);
    expect(out).toMatch(/^80\/tcp {2}filtered http$/m);
    expect(out).toMatch(/^443\/tcp filtered https$/m);
  });

  it('FW1 is one hop away, where Server1 is three', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`nmap -O -p 443 ${FW1_PORT1}`);
    expect(out).toMatch(/^Network Distance: 1 hop$/m);
    expect(out).toMatch(/^MAC Address: [0-9A-F:]{17} \(Unknown\)$/m);
    // Le doigt de gant est une DEDUCTION PAR TTL et rien d'autre : FortiOS
    // emet 64 comme Linux, donc le nom rendu est celui de la famille que
    // ce seul indice permet de nommer. Ne pas le pretendre plus precis.
    expect(out).toMatch(/^OS details: Linux 4\.15 - 5\.19$/m);
  });
});
