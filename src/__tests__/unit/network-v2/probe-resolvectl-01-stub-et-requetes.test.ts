/**
 * Probes — resolvectl, et le stub qui répond enfin.
 *
 * `docs/PRD-resolvectl.md`.
 *
 * Le défaut d'origine était une affirmation fausse : `systemctl is-active
 * systemd-resolved` disait « active », `ss -ulnp` montrait un service à
 * l'écoute sur 127.0.0.53:53, et ce socket ne répondait à rien — un
 * `bind()` sans gestionnaire. La commande qui l'aurait interrogé,
 * `resolvectl`, n'existait pas.
 *
 * Le test qui compte est `dig @127.0.0.53` : il traverse la vraie pile
 * UDP, avec de vrais messages DNS encodés et décodés. Une méthode que
 * seule `resolvectl` appellerait ne serait pas un résolveur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 30_000;
const MASK = new SubnetMask('255.255.255.0');
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** PC1 câblé à un vrai serveur DNS qui sert `web.lab.local`. */
async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'DNS1');
  pc.powerOn();
  srv.powerOn();
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.9'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);

  const dns = (srv as unknown as {
    dnsService: { addRecord(r: unknown): void; start(): void };
  }).dnsService;
  dns.addRecord({ name: 'web.lab.local', type: 'A', value: '10.0.0.50', ttl: 300 });
  dns.start();
  await pause(150);

  await pc.executeCommand('sudo resolvectl dns eth0 10.0.0.9');
  await pc.executeCommand('sudo resolvectl domain eth0 lab.local');
  return { pc, srv };
}

describe('Scénario 1 — le stub répond à de vraies requêtes DNS', () => {
  it('`dig @127.0.0.53` obtient une réponse, sur la vraie pile UDP', async () => {
    const { pc } = await lab();
    expect(
      await pc.executeCommand('dig @127.0.0.53 +short web.lab.local'),
      'ce socket n\'était qu\'un bind() décoratif : il répond désormais',
    ).toContain('10.0.0.50');
  }, LONG);

  it('le stub relaie vers l\'amont, il n\'invente pas la réponse', async () => {
    const { pc, srv } = await lab();
    // Le serveur d'en face est arrêté : sans amont, plus de réponse.
    (srv as unknown as { dnsService: { stop(): void } }).dnsService.stop();
    await pause(150);

    expect(await pc.executeCommand('dig @127.0.0.53 +short absent.lab.local')).not.toContain('10.0.0.50');
  }, LONG);

  it('un vrai serveur DNS local supplante le stub, comme dnsmasq sur Ubuntu', async () => {
    const { srv } = await lab();
    // DNS1 fait tourner dnsmasq : c'est lui qui doit tenir le port 53,
    // pas le stub. Sans cette cession, le serveur ne se liait plus.
    expect(await srv.executeCommand('dig @10.0.0.9 +short web.lab.local')).toContain('10.0.0.50');
  }, LONG);
});

describe('Scénario 2 — `resolvectl query` et le reste du système s\'accordent', () => {
  it('query rend l\'adresse et nomme le lien qui l\'a fournie', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('resolvectl query web.lab.local');
    expect(out).toContain('10.0.0.50');
    expect(out).toContain('link: eth0');
  }, LONG);

  it('query et dig s\'accordent sur la même machine au même instant', async () => {
    const { pc } = await lab();
    const parDig = (await pc.executeCommand('dig @10.0.0.9 +short web.lab.local')).trim();
    const parResolvectl = await pc.executeCommand('resolvectl query web.lab.local');

    expect(parDig).toBe('10.0.0.50');
    expect(
      parResolvectl,
      'deux chemins vers le même serveur ne peuvent pas diverger',
    ).toContain(parDig);
  }, LONG);

  it('un nom inconnu est refusé, avec un code de retour non nul', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('resolvectl query nulle.part; echo rc=$?');
    expect(out).toContain('Name or service not known');
    expect(out).toContain('rc=1');
  }, LONG);

  it('un verbe inconnu est refusé', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('resolvectl frobnicate'))
      .toContain("Unknown command verb 'frobnicate'.");
  }, LONG);
});

describe('Scénario 3 — le cache est réel', () => {
  it('la deuxième requête vient du cache, pas du réseau', async () => {
    const { pc } = await lab();
    const premiere = await pc.executeCommand('resolvectl query web.lab.local');
    const seconde = await pc.executeCommand('resolvectl query web.lab.local');

    expect(premiere).toContain('Data from: network');
    expect(seconde, 'la réponse est conservée, comme sur un vrai système').toContain('Data from: cache');
  }, LONG);

  it('les compteurs distinguent succès du cache et du réseau', async () => {
    const { pc } = await lab();
    await pc.executeCommand('resolvectl query web.lab.local');
    await pc.executeCommand('resolvectl query web.lab.local');

    const stats = await pc.executeCommand('resolvectl statistics');
    expect(stats).toMatch(/Cache Hits:\s+1/);
    expect(stats).toMatch(/Total Transactions:\s+2/);
    expect(stats).toMatch(/Current Cache Size:\s+1/);
  }, LONG);

  it('`flush-caches` vide vraiment, et la requête suivante repart sur le fil', async () => {
    const { pc } = await lab();
    await pc.executeCommand('resolvectl query web.lab.local');
    await pc.executeCommand('sudo resolvectl flush-caches');

    expect(await pc.executeCommand('resolvectl statistics')).toMatch(/Current Cache Size:\s+0/);
    expect(await pc.executeCommand('resolvectl query web.lab.local')).toContain('Data from: network');
  }, LONG);

  it('vider le cache exige les privilèges', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('resolvectl flush-caches')).toContain('Permission denied');
  }, LONG);
});

describe('Scénario 4 — configuration par lien', () => {
  it('`status` rend le serveur et le domaine posés sur le lien', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('resolvectl status');
    expect(out).toContain('Link 2 (eth0)');
    expect(out).toContain('Current DNS Server: 10.0.0.9');
    expect(out).toContain('DNS Domain: lab.local');
  }, LONG);

  it('`status` annonce le mode de resolv.conf', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('resolvectl status')).toMatch(/resolv\.conf mode: \w+/);
  }, LONG);

  it('`revert` retire ce qui avait été posé sur le lien', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl revert eth0');

    const out = await pc.executeCommand('resolvectl status eth0');
    expect(out).not.toContain('10.0.0.9');
    expect(out).not.toContain('lab.local');
  }, LONG);

  it('poser une configuration exige les privilèges', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('resolvectl dns eth0 8.8.8.8')).toContain('Permission denied');
  }, LONG);

  it('un lien inexistant est refusé', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('sudo resolvectl dns nosuchif 8.8.8.8; echo rc=$?');
    expect(out).toContain('Failed to resolve interface "nosuchif".');
    expect(out).toContain('rc=1');
  }, LONG);
});

describe('Scénario 5 — les fichiers de /run', () => {
  it('stub-resolv.conf pointe vers le stub et porte les domaines', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('cat /run/systemd/resolve/stub-resolv.conf');
    expect(out).toContain('nameserver 127.0.0.53');
    expect(out).toContain('search lab.local');
  }, LONG);

  it('resolv.conf de /run porte les serveurs en amont, pas le stub', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('cat /run/systemd/resolve/resolv.conf');
    expect(out).toContain('nameserver 10.0.0.9');
    expect(out).not.toContain('127.0.0.53');
  }, LONG);

  it('les deux fichiers suivent un changement de configuration', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dns eth0 10.0.0.99');

    expect(await pc.executeCommand('cat /run/systemd/resolve/resolv.conf')).toContain('10.0.0.99');
  }, LONG);
});

describe('Scénario 6 — resolv.conf peut enfin désigner le stub', () => {
  it('le résolveur du système accepte 127.0.0.53 et résout à travers lui', async () => {
    const { pc } = await lab();
    await pc.executeCommand("sudo sh -c 'printf \"nameserver 127.0.0.53\\n\" > /etc/resolv.conf'");

    expect(
      await pc.executeCommand('getent hosts web.lab.local'),
      'le filtre 127.* rendait le stub inutilisable par construction',
    ).toContain('10.0.0.50');
  }, LONG);

  it('les autres adresses de bouclage restent filtrées, faute de service', async () => {
    const { pc } = await lab();
    await pc.executeCommand("sudo sh -c 'printf \"nameserver 127.0.0.1\\n\" > /etc/resolv.conf'");

    expect(await pc.executeCommand('getent hosts web.lab.local')).not.toContain('10.0.0.50');
  }, LONG);
});
