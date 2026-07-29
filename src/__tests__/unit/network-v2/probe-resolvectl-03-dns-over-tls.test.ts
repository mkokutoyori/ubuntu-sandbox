/**
 * Probes — DNS-over-TLS branché sur le transport.
 *
 * `docs/PRD-resolvectl.md` §7 rangeait DoT dans les « réglages seuls » :
 * `DNSOverTLS=` était stocké, rendu par `status`, et n'atteignait aucun
 * transport. Le diagnostic était par ailleurs faux — `DnsTlsTransport.ts`
 * existait déjà, avec une vraie poignée de main TLS 1.3 (RFC 8446) sur le
 * 853 et une ALPN `dot` exigée ; il ne manquait que le raccordement.
 *
 * Ce qui est vérifié ici n'est pas qu'un drapeau vaut `yes` : c'est que
 * couper le 853 change le résultat. Un mode strict échoue alors, un mode
 * opportuniste retombe en clair, et le mode par défaut ne change pas. Un
 * réglage dont on ne peut pas observer l'effet ne prouve rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { DOT_PORT } from '@/network/dns/transport/DnsTlsTransport';

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

interface Lab {
  pc: LinuxPC;
  srv: LinuxServer;
  /** Coupe l'écoute chiffrée du serveur, en laissant le 53 en clair. */
  couperLe853(): void;
}

async function lab(): Promise<Lab> {
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

  return {
    pc,
    srv,
    couperLe853: () => {
      (srv as unknown as { getTcpStack(): { closeListener(p: number): void } })
        .getTcpStack().closeListener(DOT_PORT);
    },
  };
}

describe('Scénario 1 — le serveur écoute réellement en 853', () => {
  it('`ss` annonce le 853, et l\'annonce disparaît avec le service', async () => {
    const { srv } = await lab();
    expect(
      await srv.executeCommand('ss -tlnp'),
      'une écoute chiffrée invisible serait le même défaut que le stub muet',
    ).toContain('0.0.0.0:853');

    (srv as unknown as { dnsService: { stop(): void } }).dnsService.stop();
    await pause(50);
    expect(await srv.executeCommand('ss -tlnp')).not.toContain('0.0.0.0:853');
  }, LONG);

  it('`dig +tls` interroge le 853, et le dit', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('dig +tls @10.0.0.9 web.lab.local');
    expect(out).toContain('10.0.0.50');
    expect(out, 'le port rapporté doit être celui réellement interrogé').toContain('#853(');
  }, LONG);

  it('`dig +tls` échoue quand le 853 est coupé, `dig` seul continue', async () => {
    const { pc, couperLe853 } = await lab();
    couperLe853();

    expect(
      await pc.executeCommand('dig +tls @10.0.0.9 +short web.lab.local'),
      'sans cet échec, `+tls` ne serait qu\'un mot accepté',
    ).toContain('connection timed out');
    expect(
      await pc.executeCommand('dig @10.0.0.9 +short web.lab.local'),
      'le 53 en clair, lui, répond toujours',
    ).toContain('10.0.0.50');
  }, LONG);
});

describe('Scénario 2 — `DNSOverTLS=yes` est strict', () => {
  it('la réponse est annoncée comme chiffrée', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    const out = await pc.executeCommand('resolvectl query web.lab.local');
    expect(out).toContain('10.0.0.50');
    expect(out).toContain('Data was acquired via local or encrypted transport: yes');
  }, LONG);

  it('sans 853 en face, la requête échoue plutôt que de repasser en clair', async () => {
    const { pc, couperLe853 } = await lab();
    couperLe853();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    const out = await pc.executeCommand('resolvectl query web.lab.local; echo rc=$?');
    expect(
      out,
      'un mode strict qui retombe en clair ne protège de rien',
    ).toContain('All attempts to contact name servers or networks failed');
    expect(out).not.toContain('10.0.0.50');
    expect(out).toContain('rc=1');
  }, LONG);

  it('le refus se distingue d\'un nom inconnu', async () => {
    const { pc, couperLe853 } = await lab();
    couperLe853();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    expect(await pc.executeCommand('resolvectl query web.lab.local'))
      .not.toContain('Name or service not known');
  }, LONG);
});

describe('Scénario 3 — `opportunistic` et `no`', () => {
  it('`opportunistic` chiffre quand il peut', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 opportunistic');

    expect(await pc.executeCommand('resolvectl query web.lab.local'))
      .toContain('Data was acquired via local or encrypted transport: yes');
  }, LONG);

  it('`opportunistic` retombe en clair sans rien casser', async () => {
    const { pc, couperLe853 } = await lab();
    couperLe853();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 opportunistic');

    const out = await pc.executeCommand('resolvectl query web.lab.local');
    expect(out, 'c\'est tout ce que « opportuniste » promet').toContain('10.0.0.50');
    expect(out).toContain('Data was acquired via local or encrypted transport: no');
  }, LONG);

  it('le défaut reste le clair', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('resolvectl query web.lab.local'))
      .toContain('Data was acquired via local or encrypted transport: no');
  }, LONG);
});

describe('Scénario 4 — le réglage global de resolved.conf s\'applique', () => {
  it('un redémarrage relit `DNSOverTLS=` et le lien en hérite', async () => {
    const { pc } = await lab();
    await pc.executeCommand(
      "sudo sh -c 'printf \"[Resolve]\\nDNSOverTLS=yes\\n\" > /etc/systemd/resolved.conf'");
    await pc.executeCommand('sudo systemctl restart systemd-resolved');

    expect(
      await pc.executeCommand('resolvectl status eth0'),
      'un lien sans réglage propre suit le global, il ne le masque pas',
    ).toContain('DNSOverTLS setting: yes');
    expect(await pc.executeCommand('resolvectl query web.lab.local'))
      .toContain('Data was acquired via local or encrypted transport: yes');
  }, LONG);

  it('le réglage du lien l\'emporte sur le global', async () => {
    const { pc } = await lab();
    await pc.executeCommand(
      "sudo sh -c 'printf \"[Resolve]\\nDNSOverTLS=yes\\n\" > /etc/systemd/resolved.conf'");
    await pc.executeCommand('sudo systemctl restart systemd-resolved');
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 no');

    expect(await pc.executeCommand('resolvectl status eth0')).toContain('DNSOverTLS setting: no');
    expect(await pc.executeCommand('resolvectl query web.lab.local'))
      .toContain('Data was acquired via local or encrypted transport: no');
  }, LONG);

  it('avant ce correctif, écrire resolved.conf ne changeait rien', async () => {
    const { pc } = await lab();
    await pc.executeCommand(
      "sudo sh -c 'printf \"[Resolve]\\nDNSOverTLS=yes\\n\" > /etc/systemd/resolved.conf'");

    expect(
      await pc.executeCommand('resolvectl status'),
      'le fichier seul ne suffit pas : c\'est le redémarrage qui le relit',
    ).toContain('DNSOverTLS setting: no');
  }, LONG);
});

describe('Scénario 5 — le stub reste utilisable sous DoT', () => {
  it('`dig @127.0.0.53` traverse le stub, qui parle chiffré en amont', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    expect(await pc.executeCommand('dig @127.0.0.53 +short web.lab.local')).toContain('10.0.0.50');
  }, LONG);

  it('couper le 853 tarit aussi le stub, preuve qu\'il emprunte bien ce chemin', async () => {
    const { pc, couperLe853 } = await lab();
    couperLe853();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');

    expect(
      await pc.executeCommand('dig @127.0.0.53 +short web.lab.local'),
    ).not.toContain('10.0.0.50');
  }, LONG);

  it('gap confirmé : `getent` à froid ne peut pas attendre la poignée de main', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnsovertls eth0 yes');
    await pc.executeCommand("sudo sh -c 'printf \"nameserver 127.0.0.53\\n\" > /etc/resolv.conf'");

    // `INssSource.gethostbyname` est synchrone de bout en bout : il ne
    // peut pas attendre une poignée de main TLS. Le cache du stub est ce
    // qui rend le chemin NSS praticable ; à froid, il n'y a rien à servir.
    expect(await pc.executeCommand('getent hosts web.lab.local')).not.toContain('10.0.0.50');

    await pc.executeCommand('resolvectl query web.lab.local');
    expect(
      await pc.executeCommand('getent hosts web.lab.local'),
      'une fois la réponse en cache, le chemin synchrone repasse',
    ).toContain('10.0.0.50');
  }, LONG);
});

describe('Scénario 6 — `resolvectl nta` soustrait un domaine à la validation', () => {
  it('l\'ancre négative est posée et rendue par `status`', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl nta eth0 lab.local');

    expect(
      await pc.executeCommand('resolvectl status eth0'),
      'le verbe était accepté et sans effet ; il porte maintenant une valeur',
    ).toContain('DNSSEC NTA: lab.local');
  }, LONG);

  it('un nom couvert par l\'ancre n\'est pas validé', async () => {
    const { pc } = await lab();
    await pc.executeCommand('sudo resolvectl dnssec eth0 yes');
    await pc.executeCommand('sudo resolvectl nta eth0 lab.local');

    // `DNSSEC=yes` refuserait une zone non signée ; l'ancre négative la
    // laisse passer, ce qui est exactement sa raison d'être.
    expect(await pc.executeCommand('resolvectl query web.lab.local')).toContain('10.0.0.50');
  }, LONG);
});
