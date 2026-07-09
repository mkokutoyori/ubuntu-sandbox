import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { parseResolvConf, searchCandidates } from '@/network/devices/linux/nss/ResolvConf';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('Scénario 2 — parsing de /etc/resolv.conf (search / ndots)', () => {
  it('extrait nameserver, search et ndots', () => {
    const content = 'nameserver 10.0.1.10\nsearch domaine.local\noptions ndots:5\n';
    const parsed = parseResolvConf(content);
    expect(parsed.nameservers).toEqual(['10.0.1.10']);
    expect(parsed.search).toEqual(['domaine.local']);
    expect(parsed.ndots).toBe(5);
  });

  it('domain: est un alias de search: à un seul domaine', () => {
    const parsed = parseResolvConf('nameserver 10.0.1.10\ndomain domaine.local\n');
    expect(parsed.search).toEqual(['domaine.local']);
  });

  it('ndots par défaut vaut 1 en l\'absence de options ndots:', () => {
    const parsed = parseResolvConf('nameserver 10.0.1.10\n');
    expect(parsed.ndots).toBe(1);
  });
});

describe('Scénario 2 — searchCandidates() : qualification des noms courts', () => {
  it('un nom sans point est suffixé en priorité (ndots=1 par défaut)', () => {
    expect(searchCandidates('serveur', ['domaine.local'], 1)).toEqual([
      'serveur.domaine.local', 'serveur',
    ]);
  });

  it('un nom déjà qualifié (>= ndots points) est essayé tel quel en premier', () => {
    expect(searchCandidates('serveur.domaine.local', ['domaine.local'], 1)).toEqual([
      'serveur.domaine.local', 'serveur.domaine.local.domaine.local',
    ]);
  });

  it('ndots:5 fait basculer un nom à 1 point vers le suffixage prioritaire', () => {
    expect(searchCandidates('sub.serveur', ['domaine.local'], 5)).toEqual([
      'sub.serveur.domaine.local', 'sub.serveur',
    ]);
  });

  it('un nom absolu (point final) n\'est jamais suffixé', () => {
    expect(searchCandidates('serveur.', ['domaine.local'], 1)).toEqual(['serveur']);
  });

  it('sans search configuré, seul le nom brut est essayé', () => {
    expect(searchCandidates('serveur', [], 1)).toEqual(['serveur']);
  });
});

function buildLab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const dns = new LinuxServer('linux-server', 'DNS1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  dns.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, dns.getPort('eth0')!);
  dns.dnsService.addRecord({ name: 'serveur.domaine.local', type: 'A', value: '10.0.1.88', ttl: 3600 });
  dns.dnsService.start();
  return { pc, dns };
}

async function configureResolver(pc: LinuxPC, opts: { search?: string; ndots?: number } = {}): Promise<void> {
  const lines = ['nameserver 10.0.1.10'];
  if (opts.search) lines.push(`search ${opts.search}`);
  if (opts.ndots) lines.push(`options ndots:${opts.ndots}`);
  await pc.executeCommand(`sudo su -`);
  await pc.executeCommand(`cat > /etc/resolv.conf <<'EOF'\n${lines.join('\n')}\nEOF`);
}

async function hijackHosts(pc: LinuxPC): Promise<void> {
  await pc.executeCommand(`cat >> /etc/hosts <<'EOF'\n10.0.1.99 serveur.domaine.local\nEOF`);
}

describe('Scénario 2 — conflit /etc/hosts vs DNS et ordre nsswitch.conf', () => {
  it('getent hosts respecte nsswitch.conf (files avant dns) et renvoie l\'adresse de /etc/hosts', async () => {
    const { pc } = buildLab();
    await configureResolver(pc);
    await hijackHosts(pc);

    const out = await pc.executeCommand('getent hosts serveur.domaine.local');
    expect(out).toMatch(/10\.0\.1\.99/);
    expect(out).not.toMatch(/10\.0\.1\.88/);
  });

  it('nslookup et dig interrogent directement le DNS et renvoient une réponse différente de getent', async () => {
    const { pc } = buildLab();
    await configureResolver(pc);
    await hijackHosts(pc);

    const nslookupOut = await pc.executeCommand('nslookup serveur.domaine.local');
    expect(nslookupOut).toMatch(/10\.0\.1\.88/);
    expect(nslookupOut).not.toMatch(/10\.0\.1\.99/);

    const digOut = await pc.executeCommand('dig serveur.domaine.local +short');
    expect(digOut).toMatch(/10\.0\.1\.88/);
  });

  it('ping et curl utilisent la libc/NSS et résolvent donc vers /etc/hosts, pas le DNS', async () => {
    const { pc } = buildLab();
    await configureResolver(pc);
    await hijackHosts(pc);

    const pingOut = await pc.executeCommand('ping -c 1 serveur.domaine.local');
    expect(pingOut).toMatch(/10\.0\.1\.99/);
    expect(pingOut).not.toMatch(/10\.0\.1\.88/);
  });

  it('changer l\'ordre nsswitch.conf en "dns files" est effectif immédiatement, sans redémarrage', async () => {
    const { pc } = buildLab();
    await configureResolver(pc);
    await hijackHosts(pc);

    const before = await pc.executeCommand('getent hosts serveur.domaine.local');
    expect(before).toMatch(/10\.0\.1\.99/);

    await pc.executeCommand(
      `sh -c "sed -i 's/^hosts:.*/hosts: dns files/' /etc/nsswitch.conf"`,
    );

    const after = await pc.executeCommand('getent hosts serveur.domaine.local');
    expect(after).toMatch(/10\.0\.1\.88/);
    expect(after).not.toMatch(/10\.0\.1\.99/);
  });

  it('un nom court sans entrée /etc/hosts se résout via le domaine de recherche (search) du resolv.conf', async () => {
    const { pc } = buildLab();
    await configureResolver(pc, { search: 'domaine.local' });

    const out = await pc.executeCommand('getent hosts serveur');
    expect(out).toMatch(/10\.0\.1\.88/);
  });

  it('le même nom court interrogé directement en dig échoue: dig n\'applique pas le search domain', async () => {
    const { pc } = buildLab();
    await configureResolver(pc, { search: 'domaine.local' });

    const out = await pc.executeCommand('dig serveur +short');
    expect(out).not.toMatch(/10\.0\.1\.88/);
  });
});
