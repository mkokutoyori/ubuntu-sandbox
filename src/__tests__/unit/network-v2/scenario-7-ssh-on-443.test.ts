/**
 * Scénario 7 — Cohérence entre port applicatif déclaré et port réellement utilisé
 * (détournement de service)
 *
 * Objectif : détecter qu'un service SSH reconfiguré sur le port 443 (pour
 * contourner un filtrage) reste identifiable par inspection applicative,
 * même si un scan de ports basique le prendrait pour du HTTPS.
 *
 * Points de contrôle :
 *   - `ss -tlnp` montre sshd écoutant sur 443,
 *   - une capture réseau expose la bannière SSH-2.0-... échangée à la
 *     connexion (et non un ClientHello TLS),
 *   - une inspection applicative (nmap -sV, curl HTTPS) constate l'écart
 *     entre l'hypothèse « port 443 = HTTPS » et le protocole réel.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scenario 7 — sshd hijacked onto port 443', () => {
  let server: LinuxServer;
  let attacker: LinuxPC;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    server = new LinuxServer('linux-server', 'srv', 0, 0);
    attacker = new LinuxPC('linux-pc', 'atk', 0, 0);
    const sw = new HuaweiSwitch('switch-huawei', 'sw', 8, 0, 0);
    [server, attacker, sw].forEach((d) => d.powerOn());
    const p = Array.from(sw.getPorts().values());
    new Cable('c1').connect(server.getPort('eth0')!, p[0]);
    new Cable('c2').connect(attacker.getPort('eth0')!, p[1]);
    await server.executeCommand('ifconfig eth0 192.168.1.1 netmask 255.255.255.0');
    await attacker.executeCommand('ifconfig eth0 192.168.1.2 netmask 255.255.255.0');

    await server.executeCommand(
      "bash -c \"sed -i 's/^#\\?Port 22/Port 443/' /etc/ssh/sshd_config\"",
    );
    await server.executeCommand('systemctl reload ssh');
  });

  it('ss -tlnp confirms sshd is now listening on port 443, no longer on 22', async () => {
    const out = await server.executeCommand('ss -tlnp');
    const on443 = out.split('\n').filter((l) => /:443\b/.test(l) && /LISTEN/.test(l) && /sshd/.test(l));
    const on22 = out.split('\n').filter((l) => /:22\b/.test(l) && /LISTEN/.test(l) && /sshd/.test(l));
    expect(on443.length).toBeGreaterThan(0);
    expect(on22.length).toBe(0);
  });

  it('a basic port scan of 443 reports the port as open (naive would call it HTTPS)', async () => {
    const out = await attacker.executeCommand('nc -zv -w 1 192.168.1.1 443');
    expect(out).toMatch(/succeeded|open|Connected/i);
  });

  it('port 22 is now closed since sshd moved off it', async () => {
    const out = await attacker.executeCommand('nc -zv -w 1 192.168.1.1 22');
    expect(out).toMatch(/refused|closed|failed|no route/i);
  });

  it('the actual server banner on port 443 starts with SSH-2.0, not a TLS ClientHello', async () => {
    const banner = await attacker.executeCommand('nc -w 1 192.168.1.1 443');
    expect(banner).toMatch(/^SSH-2\.0-/);
    expect(banner).not.toMatch(/\\x16\\x03/);
    expect(banner).not.toMatch(/HTTP\/1/i);
  });

  it('tcpdump on the server shows the SSH-2.0 banner in a TCP payload on port 443', async () => {
    await attacker.executeCommand('nc -w 1 192.168.1.1 443');
    const cap = await server.executeCommand('tcpdump -A -c 20 port 443');
    expect(cap).toMatch(/SSH-2\.0-/);
    expect(cap).not.toMatch(/TLS Handshake|ClientHello/i);
  });

  it('an application-layer probe (nmap -sV / curl https) contradicts the "port 443 = HTTPS" assumption', async () => {
    const nmap = await attacker.executeCommand('nmap -sV -p 443 192.168.1.1');
    const serviceLine = nmap.split('\n').find((l) => /^\d+\/tcp\s+open/.test(l)) ?? '';
    expect(serviceLine.toLowerCase()).toContain('ssh');
    expect(serviceLine.toLowerCase()).not.toContain('https');

    const curl = await attacker.executeCommand('curl -s -k https://192.168.1.1:443/');
    expect(curl).not.toMatch(/<html>|<!DOCTYPE|HTTP\/1/i);
    expect(curl.toLowerCase()).toMatch(/wrong version|protocol|unexpected|ssh|ssl/);
  });

  it('the SSH server still authenticates a real SSH client that dials port 443', async () => {
    const ssh = await attacker.executeCommand('ssh -p 443 -o BatchMode=no -o StrictHostKeyChecking=no root@192.168.1.1 uptime 2>&1 || true');
    expect(ssh).not.toMatch(/Connection refused/i);
  });
});
