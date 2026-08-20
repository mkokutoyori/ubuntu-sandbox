import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function buildLab() {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  const um = (server as unknown as { executor: { userMgr: { useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'wonderland');
  return { client, server };
}

describe('Scénario 5 — Cohérence fichier vs état runtime', () => {
  it("une règle ajoutée en runtime sans sauvegarde diverge de iptables-save comparé à /etc/iptables/rules.v4", async () => {
    const { server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j ACCEPT');
    await server.executeCommand('netfilter-persistent save');

    await server.executeCommand('iptables -A INPUT -p tcp --dport 9999 -j DROP');

    const live = await server.executeCommand('iptables-save');
    const onDisk = await server.executeCommand('cat /etc/iptables/rules.v4');
    expect(live).toContain('9999');
    expect(onDisk).not.toContain('9999');
    expect(live).not.toBe(onDisk);
  });

  it("iptables -L -n -v --line-numbers affiche les règles actives avec compteurs et numéros de ligne", async () => {
    const { server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
    await server.executeCommand('iptables -A INPUT -p tcp --dport 23 -j DROP');

    const listing = await server.executeCommand('iptables -L INPUT -n -v --line-numbers');
    expect(listing).toMatch(/^1\s+\d+\s+\d+\s+ACCEPT.*dpt:22/m);
    expect(listing).toMatch(/^2\s+\d+\s+\d+\s+DROP.*dpt:23/m);
  });

  it("les compteurs de paquets/octets de la règle REJECT sur le port 22 croissent exactement en fonction du trafic généré", async () => {
    const { client, server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT --reject-with icmp-port-unreachable');

    const before = await server.executeCommand('iptables -L INPUT -n -v');
    const beforeCount = parseInt(/^\s*(\d+)\s+\d+\s+REJECT/m.exec(before)?.[1] ?? '0', 10);

    await client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 whoami', 'wonderland\n');
    await client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 whoami', 'wonderland\n');

    const after = await server.executeCommand('iptables -L INPUT -n -v');
    const afterCount = parseInt(/^\s*(\d+)\s+\d+\s+REJECT/m.exec(after)?.[1] ?? '0', 10);
    expect(afterCount).toBe(beforeCount + 2);
  });

  it("nft list ruleset affiche le jeu de règles complet actif, comparable au contenu de /etc/nftables.conf", async () => {
    const { server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 8080 -j ACCEPT');
    await server.executeCommand('iptables -A INPUT -p tcp --dport 9999 -j DROP');

    const ruleset = await server.executeCommand('nft list ruleset');
    expect(ruleset).toMatch(/table ip filter \{/);
    expect(ruleset).toMatch(/chain INPUT \{/);
    expect(ruleset).toMatch(/type filter hook input priority 0; policy accept;/);
    expect(ruleset).toMatch(/tcp dport 8080 counter packets \d+ bytes \d+ accept/);
    expect(ruleset).toMatch(/tcp dport 9999 counter packets \d+ bytes \d+ drop/);

    await server.executeCommand('nft list ruleset > /etc/nftables.conf');
    const onDisk = await server.executeCommand('cat /etc/nftables.conf');
    expect(onDisk).toBe(ruleset);

    await server.executeCommand('iptables -A INPUT -p tcp --dport 5000 -j ACCEPT');
    const afterChange = await server.executeCommand('nft list ruleset');
    const stillOnDisk = await server.executeCommand('cat /etc/nftables.conf');
    expect(afterChange).not.toBe(stillOnDisk);
    expect(afterChange).toContain('5000');
    expect(stillOnDisk).not.toContain('5000');
  });

  it("un ensemble usuel de règles (DROP entrant, ACCEPT avec log, REJECT ICMP, NAT/MASQUERADE) est visible côté iptables et côté nft", async () => {
    const { server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 4444 -j DROP');
    await server.executeCommand('iptables -A OUTPUT -p tcp --dport 80 -j LOG --log-prefix "HTTP-OUT: "');
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT --reject-with icmp-port-unreachable');
    await server.executeCommand('iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE');

    const saved = await server.executeCommand('iptables-save');
    expect(saved).toContain('-A INPUT -p tcp --dport 4444 -j DROP');
    expect(saved).toContain('LOG');
    expect(saved).toContain('REJECT');
    expect(saved).toContain('MASQUERADE');

    const ruleset = await server.executeCommand('nft list ruleset');
    expect(ruleset).toMatch(/tcp dport 4444 counter packets \d+ bytes \d+ drop/);
    expect(ruleset).toMatch(/log prefix "HTTP-OUT: "/);
    expect(ruleset).toMatch(/reject with icmp type port-unreachable/);
    expect(ruleset).toMatch(/table ip nat \{[\s\S]*masquerade/);
  });
});

describe('Scénario 5 — Persistance au redémarrage', () => {
  it("iptables-restore < /etc/iptables/rules.v4 restaure exactement les règles sauvegardées", async () => {
    const { server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 3000 -j ACCEPT');
    await server.executeCommand('iptables-save > /etc/iptables/rules.v4');
    await server.executeCommand('iptables -F INPUT');

    let listing = await server.executeCommand('iptables -L INPUT -n');
    expect(listing).not.toContain('3000');

    await server.executeCommand('iptables-restore < /etc/iptables/rules.v4');
    listing = await server.executeCommand('iptables -L INPUT -n');
    expect(listing).toContain('3000');
  });

  it("netfilter-persistent + redémarrage restaurent exactement les règles sauvegardées, sans règle manquante ni additionnelle", async () => {
    const { server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 2000 -j ACCEPT');
    await server.executeCommand('iptables -A INPUT -p tcp --dport 2001 -j DROP');
    await server.executeCommand('netfilter-persistent save');
    const savedFile = await server.executeCommand('cat /etc/iptables/rules.v4');

    await server.executeCommand('reboot');

    const postReboot = await server.executeCommand('iptables-save');
    expect(postReboot).toContain('2000');
    expect(postReboot).toContain('2001');
    expect(postReboot).toBe(savedFile);
  });

  it("une règle ajoutée en runtime sans sauvegarde disparaît après un redémarrage", async () => {
    const { server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 1000 -j ACCEPT');
    await server.executeCommand('netfilter-persistent save');

    await server.executeCommand('iptables -A INPUT -p tcp --dport 9999 -j DROP');
    let listing = await server.executeCommand('iptables -L INPUT -n');
    expect(listing).toContain('9999');

    await server.executeCommand('reboot');

    listing = await server.executeCommand('iptables -S INPUT');
    expect(listing).toContain('1000');
    expect(listing).not.toContain('9999');
  });
});

describe('Scénario 5 — Corrélation règles / trafic observé', () => {
  it('une règle LOG avec --log-prefix génère une entrée /var/log/syslog pour chaque tentative SSH, corrélée avec le SYN capturé', async () => {
    const { client, server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j LOG --log-prefix "SSH-ATTEMPT: "');

    void client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 whoami', 'wonderland\n');
    const sniffed = await client.executeCommand('tcpdump -ni eth0 port 22 -c 2');

    const syslog = await server.executeCommand('cat /var/log/syslog');
    expect(syslog).toMatch(/SSH-ATTEMPT: IN=eth0.*SRC=10\.0\.0\.1.*PROTO=TCP.*DPT=22/);
    expect(sniffed).toMatch(/Flags \[S\]|Flags \[S\.\]/);
    expect(sniffed).toMatch(/10\.0\.0\.2\.22/);
  });

  it('REJECT --reject-with icmp-port-unreachable produit "Connection refused" côté client, DROP produit "Connection timed out" (signature réseau différente)', async () => {
    const { client, server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j REJECT --reject-with icmp-port-unreachable');
    const rejected = await client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 whoami', 'wonderland\n');
    expect(rejected).toMatch(/Connection refused/);
    expect(rejected).not.toMatch(/Connection timed out/);

    await server.executeCommand('iptables -F INPUT');
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j DROP');
    const dropped = await client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 whoami', 'wonderland\n');
    expect(dropped).toMatch(/Connection timed out/);
    expect(dropped).not.toMatch(/Connection refused/);
  });

  it("les compteurs paquets/octets d'une règle spécifique croissent exactement en fonction du trafic de test généré, validant sa sélectivité", async () => {
    const { client, server } = buildLab();
    await server.executeCommand('iptables -A INPUT -p tcp --dport 22 -j ACCEPT');
    await server.executeCommand('iptables -A INPUT -p tcp --dport 12345 -j DROP');

    const before = await server.executeCommand('iptables -L INPUT -n -v');
    const acceptBefore = parseInt(/^\s*(\d+)\s+\d+\s+ACCEPT/m.exec(before)?.[1] ?? '0', 10);
    const dropBefore = parseInt(/^\s*(\d+)\s+\d+\s+DROP/m.exec(before)?.[1] ?? '0', 10);

    await client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 whoami', 'wonderland\n');
    await client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 whoami', 'wonderland\n');
    await client.executeCommand('ssh -o StrictHostKeyChecking=no alice@10.0.0.2 whoami', 'wonderland\n');

    const after = await server.executeCommand('iptables -L INPUT -n -v');
    const acceptAfter = parseInt(/^\s*(\d+)\s+\d+\s+ACCEPT/m.exec(after)?.[1] ?? '0', 10);
    const dropAfter = parseInt(/^\s*(\d+)\s+\d+\s+DROP/m.exec(after)?.[1] ?? '0', 10);

    expect(acceptAfter).toBe(acceptBefore + 3);
    expect(dropAfter).toBe(dropBefore);
  });
});
