/*
 * hping3 on the user's lab (lan_with_firewall_fortigate.topology), imported
 * as exported and configured afterwards through each device's CLI — the
 * same lab and the same helpers as user-lab-features.test.ts.
 *
 * LAN 192.168.1.0/24 (PC1, PC2, Router2) — FW1 port1 / port2 — R3 —
 * HQ 192.168.30.0/24 (Server1, WinServer1, PC3). FW1 policy 1 allows
 * LAN_SUBNET -> HQ_ADDRESS with NAT; nothing allows HQ -> LAN.
 *
 * Why this lab and not a direct link: three things only a routed,
 * NAT'd, firewalled path can show, and all three were MEASURED here
 * before being written down.
 *
 *  - The TTL of the reply is 62, not 64. hping3 prints the ttl of the
 *    PACKET THAT CAME BACK (`log_ip`, waitpacket.c:160-183), and two
 *    router hops decremented it. On a direct link 62 and 64 are the same
 *    assertion; here they are not, so this lab is what proves the field
 *    is read from the reply rather than echoed from the request.
 *  - `-t 2` dies at R3 and R3 says so. The ICMP time-exceeded NAMES the
 *    router (`TTL 0 during transit from ip=192.168.20.1`, logicmp.c:19-28)
 *    — a hop that a direct link has no room for.
 *  - `-A` towards a closed HQ port draws NOTHING, where the same probe on
 *    a direct link draws a bare RST. The sniffer shows why: the ACK
 *    reaches port1 and never leaves port2, so FW1 drops a segment that
 *    belongs to no session. That asymmetry between `-S` and `-A` IS what
 *    an ACK scan is for, and only a stateful firewall in the path can
 *    exhibit it.
 *
 * DISCRIMINATION, mesuree de DEUX facons parce que les deux repondent a
 * des questions differentes :
 *   - contre l'arbre d'AVANT le lot hping3 (`git checkout <lot>~1 --
 *     src/network`) : 6 cas sur 11 tombent — les deux lignes de reponse,
 *     `-t 2`, `-V`, et les deux tables `--scan`.
 *   - contre l'arbre COURANT, le lot etant deja commite : 1 seul tombe,
 *     celui de `-t 2`, qui est le manque que ce lab a fait apparaitre et
 *     que le correctif ferme (`noteProbeTimeExceeded`).
 * Les trois cas ajoutes sur les interfaces de FW1 sont des temoins : ils
 * passent des deux cotes et montrent ce que `allowaccess` decide — un
 * service servi repond, un service non permis se TAIT, et le ttl vaut 64
 * sur le segment de PC1 la ou il vaut 62 pour Server1.
 * Les cas qui ne discriminent dans aucun des deux sens sont des TEMOINS
 * du chemin : `-A` sans reponse, le deny implicite depuis HQ, la trame
 * NAT-ee vue par le sniffer, et `-p ++` — ils prouvent que le laboratoire
 * lui-meme est sain, sans quoi une suite faite de silences ne prouverait
 * rien.
 */
import { describe, it, expect } from 'vitest';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';

const SERVER1 = '192.168.30.4';
const R3_LAN_SIDE = '192.168.20.1';
const FW1_NAT_SOURCE = '192.168.20.2';
const PC1 = '192.168.1.10';
const FW1_PORT1 = '192.168.1.99';

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

function replyLines(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('len='));
}

describe('user lab — hping3 reads the reply that crossed FW1', () => {
  it('an open HQ port answers SYN/ACK with the ttl of the REPLY, not of my request', async () => {
    const lab = await configuredLab();
    const line = replyLines(await lab.PC1.executeCommand(`hping3 -S -p 80 -c 1 ${SERVER1}`))[0];
    expect(line).toContain('flags=SA');
    expect(line).toContain('win=65535');
    expect(line).toMatch(/^len=44 ip=192\.168\.30\.4 ttl=62 DF id=\d+ sport=80 /);
  });

  it('a closed HQ port answers RST+ACK with a zero window and a bare header', async () => {
    const lab = await configuredLab();
    const line = replyLines(await lab.PC1.executeCommand(`hping3 -S -p 81 -c 1 ${SERVER1}`))[0];
    expect(line).toMatch(/^len=40 ip=192\.168\.30\.4 ttl=62 DF id=\d+ sport=81 flags=RA seq=0 win=0 /);
  });

  it('-t 2 dies at R3, and the ICMP time-exceeded names it', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`hping3 -S -p 80 -c 1 -t 2 ${SERVER1}`);
    expect(out).toContain(`TTL 0 during transit from ip=${R3_LAN_SIDE}`);
    expect(replyLines(out)).toHaveLength(0);
    expect(out).toContain('1 packets transmitted, 0 packets received, 100% packet loss');
  });

  it('-V prints the reply own header, cut where log_ip cuts it', async () => {
    const lab = await configuredLab();
    const out = (await lab.PC1.executeCommand(`hping3 -S -p 80 -c 1 -V ${SERVER1}`)).split('\n');
    expect(out.find((l) => l.startsWith('len='))).toMatch(/ttl=62 DF id=\d+ tos=0 iplen=44$/);
    expect(out.some((l) => l.startsWith('sport=80 flags=SA'))).toBe(true);
    expect(out.some((l) => /^seq=\d+ ack=\d+ sum=[0-9a-f]+ urp=0$/.test(l))).toBe(true);
  });

  it('-1 crosses policy 1 and the echo reply carries the same two-hop ttl', async () => {
    const lab = await configuredLab();
    const lines = replyLines(await lab.PC1.executeCommand(`hping3 -1 -c 2 ${SERVER1}`));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^len=28 ip=192\.168\.30\.4 ttl=62 id=\d+ icmp_seq=0 rtt=\d+\.\d ms$/);
    expect(lines[1]).toContain('icmp_seq=1');
  });

  it('-p ++79 walks the three ports and each one answers for itself', async () => {
    const lab = await configuredLab();
    const lines = replyLines(await lab.PC1.executeCommand(`hping3 -S -p ++79 -c 3 ${SERVER1}`));
    expect(lines.map((l) => /sport=(\d+)/.exec(l)?.[1])).toEqual(['79', '80', '81']);
    expect(lines[0]).toContain('flags=RA');
    expect(lines[1]).toContain('flags=SA');
    expect(lines[2]).toContain('flags=RA');
  });
});

describe('user lab — hping3 against the policy', () => {
  it('-A draws nothing because FW1 drops a segment that belongs to no session', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`hping3 -A -p 81 -c 1 ${SERVER1}`);
    expect(replyLines(out)).toHaveLength(0);
    expect(out).toContain('1 packets transmitted, 0 packets received, 100% packet loss');

    // Le silence est celui du PARE-FEU et non de la cible : l'ACK est vu
    // entrant sur port1 et ne ressort jamais par port2.
    const trace = await lab.FW1.executeCommand(
      `diagnose sniffer packet any 'host ${SERVER1}' 4 40`);
    expect(trace).toMatch(/^.*port1 .*192\.168\.1\.10\.\d+ -> 192\.168\.30\.4\.81: ack 0$/m);
    expect(trace).not.toMatch(/port2 .*-> 192\.168\.30\.4\.81: ack /);
  });

  it('the same probe from HQ towards the LAN meets the implicit deny', async () => {
    const lab = await configuredLab();
    const out = await lab.PC3.executeCommand(`hping3 -S -p 80 -c 2 ${PC1}`);
    expect(replyLines(out)).toHaveLength(0);
    expect(out).toContain('2 packets transmitted, 0 packets received, 100% packet loss');
  });

  it('a SYN really crosses FW1, and the wire shows it NAT-ed to port2', async () => {
    const lab = await configuredLab();
    await lab.PC1.executeCommand(`hping3 -S -p 80 -c 1 ${SERVER1}`);
    const trace = await lab.FW1.executeCommand(
      `diagnose sniffer packet any 'host ${SERVER1}' 4 20`);
    expect(trace).toMatch(/port1 .*192\.168\.1\.10\.\d+ -> 192\.168\.30\.4\.80: syn \d+$/m);
    expect(trace).toMatch(
      new RegExp(`port2 .*${FW1_NAT_SOURCE.replace(/\./g, '\\.')}\\.\\d+ -> 192\\.168\\.30\\.4\\.80: syn \\d+$`, 'm'));
    expect(trace).toMatch(/192\.168\.30\.4\.80 -> 192\.168\.20\.2\.\d+: syn \d+ ack \d+$/m);
    expect(trace).not.toMatch(/undefined|: syn -/);
  });
});

describe('user lab — hping3 --scan through FW1', () => {
  it('the scan table lists only the HQ ports that answered SYN, with their real ttl', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`hping3 --scan 22,80,81 -S ${SERVER1}`);
    const lines = out.split('\n');
    expect(lines[0]).toBe('3 ports to scan, use -V to see all the replies');
    expect(lines[2]).toBe('|port| serv name |  flags  |ttl| id  | win | len |');
    const rows = lines.filter((l) => /^\s+\d+ \S+\s*: /.test(l));
    expect(rows.map((r) => r.trim().split(/\s+/)[0])).toEqual(['22', '80']);
    expect(rows[0]).toContain('ssh');
    expect(rows[0]).toContain('.S..A...');
    expect(rows[0]).toMatch(/\.S\.\.A\.\.\.\s+62\s/);
    expect(out).toContain('All replies received. Done.');
  });

  it('-V adds the closed HQ port to the same table', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`hping3 --scan 80,81 -S -V ${SERVER1}`);
    const rows = out.split('\n').filter((l) => /^\s+\d+ \S+\s*: /.test(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('.S..A...');
    expect(rows[1]).toContain('..R.A...');
  });
});

describe('user lab — hping3 against FW1 own interface', () => {
  it('a management port FW1 serves answers SYN/ACK with the ttl of its OWN segment', async () => {
    const lab = await configuredLab();
    const line = replyLines(
      await lab.PC1.executeCommand(`hping3 -S -p 443 -c 1 ${FW1_PORT1}`))[0];
    // port1 est sur le segment de PC1 : aucun routeur n'a decremente le
    // ttl, donc 64 ici contre 62 pour Server1 — c'est la meme lecture du
    // champ dans la REPONSE qui rend les deux chiffres differents.
    expect(line).toMatch(/^len=44 ip=192\.168\.1\.99 ttl=64 DF id=\d+ sport=443 flags=SA /);
    expect(line).toContain('win=65535');
  });

  it('a management service FW1 does NOT allow stays silent, it does not refuse', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`hping3 -S -p 23 -c 1 ${FW1_PORT1}`);
    expect(replyLines(out)).toHaveLength(0);
    expect(out).toContain('1 packets transmitted, 0 packets received, 100% packet loss');
  });

  it('--scan separates what FW1 serves from what it drops, and names the silent one', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`hping3 --scan 22,23,80,443 -S -V ${FW1_PORT1}`);
    const rows = out.split('\n').filter((l) => /^\s+\d+ \S+\s*: /.test(l));
    expect(rows.map((r) => r.trim().split(/\s+/)[0])).toEqual(['22', '80', '443']);
    for (const row of rows) expect(row).toMatch(/\.S\.\.A\.\.\.\s+64\s/);
    expect(out).toContain('Not responding ports: (23 telnet)');
  });
});
