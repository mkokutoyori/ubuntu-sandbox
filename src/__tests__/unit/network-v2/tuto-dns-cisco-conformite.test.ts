import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const refuse = (r: string) =>
  /% Invalid input|% Incomplete|% Unknown|Unrecognized|% Invalid IP address/.test(r);

async function routeur(...cfg: string[]): Promise<CiscoRouter> {
  const d = new CiscoRouter('R1', 0, 0);
  d.powerOn();
  await d.executeCommand('enable');
  if (cfg.length) {
    await d.executeCommand('configure terminal');
    for (const c of cfg) await d.executeCommand(c);
    await d.executeCommand('end');
  }
  return d;
}

async function commutateur(...cfg: string[]): Promise<CiscoSwitch> {
  const d = new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
  d.powerOn();
  await d.executeCommand('enable');
  if (cfg.length) {
    await d.executeCommand('configure terminal');
    for (const c of cfg) await d.executeCommand(c);
    await d.executeCommand('end');
  }
  return d;
}

async function enConfig(d: CiscoRouter | CiscoSwitch, cmd: string): Promise<string> {
  await d.executeCommand('configure terminal');
  const r = await d.executeCommand(cmd);
  await d.executeCommand('end');
  return r;
}

interface Labo {
  r: CiscoRouter;
  srv: LinuxServer;
}

async function laboAvecServeurDns(): Promise<Labo> {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const srv = new LinuxServer('linux-server', 'dns', 0, 0);
  const r = new CiscoRouter('R1', 0, 0);
  [srv, r].forEach((d, i) => {
    const c = new Cable(`c${i}`);
    c.connect(d.getPorts()[0], sw.getPorts()[i]);
  });
  srv.getPorts()[0].configureIP(new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  [srv, r, sw].forEach((d) => d.powerOn());
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit', 'end']) {
    await r.executeCommand(c);
  }
  const conf = [
    'address=/www.lab.local/192.168.1.50',
    'address=/srv.lab.local/192.168.1.60',
  ].join('\n');
  await srv.executeCommand(`echo '${conf}' > /tmp/dnsmasq.conf`);
  await srv.executeCommand('sudo dnsmasq -C /tmp/dnsmasq.conf --no-daemon &');
  return { r, srv };
}

describe('partie 1 : les deux formes de la commande, et le defaut', () => {
  const FORMES = [
    'ip domain-lookup',
    'ip domain lookup',
    'no ip domain-lookup',
    'no ip domain lookup',
    'ip domain-name lab.local',
    'ip domain name lab.local',
    'ip name-server 192.168.1.10',
    'ip name-server 192.168.1.10 8.8.8.8',
  ];
  it.each(FORMES)('`%s` est acceptee', async (cmd) => {
    const d = await routeur();
    expect(refuse(await enConfig(d, cmd)), cmd).toBe(false);
  }, 30_000);

  it('la resolution est ACTIVE par defaut, donc non rendue', async () => {
    const d = await routeur();
    expect(await d.executeCommand('show running-config')).not.toContain('ip domain-lookup');
    expect(await d.executeCommand('show hosts')).toContain('Name/address lookup');
  }, 30_000);

  it('`no ip domain-lookup` est rendue, elle — c\'est un ecart au defaut', async () => {
    const d = await routeur('no ip domain-lookup');
    expect(await d.executeCommand('show running-config')).toContain('no ip domain-lookup');
  }, 30_000);

  it('la desactivation survit a un aller-retour de configuration', async () => {
    const d = await routeur('no ip domain-lookup');
    const rc = await d.executeCommand('show running-config');
    const d2 = await routeur();
    await d2.executeCommand('configure terminal');
    for (const l of rc.split('\n').filter((x) => x.trim() === 'no ip domain-lookup')) {
      await d2.executeCommand(l.trim());
    }
    await d2.executeCommand('end');
    expect(await d2.executeCommand('show running-config')).toContain('no ip domain-lookup');
  }, 30_000);

  it('jusqu\'a six serveurs de noms sont retenus, dans l\'ordre', async () => {
    const d = await routeur('ip name-server 1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4 5.5.5.5 6.6.6.6');
    const rc = await d.executeCommand('show running-config');
    expect(rc).toContain('ip name-server 1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4 5.5.5.5 6.6.6.6');
    expect(await d.executeCommand('show hosts')).toContain('1.1.1.1');
  }, 30_000);

  it('une adresse de serveur invalide est refusee', async () => {
    const d = await routeur();
    expect(refuse(await enConfig(d, 'ip name-server 300.1.1.1'))).toBe(true);
  }, 30_000);

  it('`no ip name-server <ip>` retire CE serveur et garde les autres', async () => {
    const d = await routeur('ip name-server 1.1.1.1 2.2.2.2', 'no ip name-server 1.1.1.1');
    const rc = await d.executeCommand('show running-config');
    expect(rc).toContain('ip name-server 2.2.2.2');
    expect(rc).not.toContain('1.1.1.1');
  }, 30_000);
});

describe('partie 2 : le domaine par defaut et la liste de domaines', () => {
  it('`ip domain-name` est retenue et rendue', async () => {
    const d = await routeur('ip domain-name lab.local');
    expect(await d.executeCommand('show running-config')).toContain('ip domain-name lab.local');
    expect(await d.executeCommand('show hosts')).toContain('Default domain is lab.local');
  }, 30_000);

  it('sans domaine, `show hosts` le dit', async () => {
    const d = await routeur();
    expect(await d.executeCommand('show hosts')).toContain('Default domain is not set');
  }, 30_000);

  it('`ip domain list` accepte plusieurs suffixes et les rend dans l\'ordre', async () => {
    const d = await routeur(
      'ip domain list lab.local', 'ip domain list corp.example', 'ip domain list dmz.example');
    const rc = await d.executeCommand('show running-config');
    const lignes = rc.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ip domain list'));
    expect(lignes).toEqual([
      'ip domain list lab.local',
      'ip domain list corp.example',
      'ip domain list dmz.example',
    ]);
  }, 30_000);

  it('`show hosts` liste les suffixes de recherche', async () => {
    const d = await routeur('ip domain list lab.local', 'ip domain list corp.example');
    const out = await d.executeCommand('show hosts');
    expect(out).toContain('lab.local');
    expect(out).toContain('corp.example');
  }, 30_000);

  it('`no ip domain list <nom>` retire ce suffixe seul', async () => {
    const d = await routeur(
      'ip domain list lab.local', 'ip domain list corp.example',
      'no ip domain list lab.local');
    const rc = await d.executeCommand('show running-config');
    expect(rc).toContain('ip domain list corp.example');
    expect(rc).not.toContain('ip domain list lab.local');
  }, 30_000);

  it('`ip domain timeout` et `ip domain retry` sont retenues et rendues', async () => {
    const d = await routeur('ip domain timeout 5', 'ip domain retry 4');
    const rc = await d.executeCommand('show running-config');
    expect(rc).toContain('ip domain timeout 5');
    expect(rc).toContain('ip domain retry 4');
  }, 30_000);

  it('leurs valeurs par defaut (3 s, 2 essais) ne sont pas rendues', async () => {
    const d = await routeur('ip domain timeout 3', 'ip domain retry 2');
    const rc = await d.executeCommand('show running-config');
    expect(rc).not.toContain('ip domain timeout');
    expect(rc).not.toContain('ip domain retry');
  }, 30_000);

  it('`ip domain round-robin` est acceptee et rendue', async () => {
    const d = await routeur('ip domain round-robin');
    expect(await d.executeCommand('show running-config')).toContain('ip domain round-robin');
  }, 30_000);

  it('`ip domain lookup source-interface` est acceptee et rendue', async () => {
    const d = await routeur('ip domain lookup source-interface Loopback0');
    expect(await d.executeCommand('show running-config'))
      .toMatch(/ip domain[- ]lookup source-interface Loopback0/);
  }, 30_000);
});

describe('partie 3 : la table d\'hotes statique', () => {
  it('`ip host` pose une entree que `show hosts` decrit', async () => {
    const d = await routeur('ip host R2 10.0.0.2');
    const out = await d.executeCommand('show hosts');
    expect(out).toContain('R2');
    expect(out).toContain('10.0.0.2');
    expect(out, 'une entree statique est permanente').toMatch(/R2.*\(perm, OK\)/);
  }, 30_000);

  it('`ip host` accepte plusieurs adresses pour un meme nom', async () => {
    const d = await routeur('ip host web 10.0.0.10 10.0.0.11 10.0.0.12');
    const out = await d.executeCommand('show hosts');
    for (const ip of ['10.0.0.10', '10.0.0.11', '10.0.0.12']) expect(out, ip).toContain(ip);
    expect(await d.executeCommand('show running-config'))
      .toContain('ip host web 10.0.0.10 10.0.0.11 10.0.0.12');
  }, 30_000);

  it('un nom est insensible a la casse, comme le DNS', async () => {
    const d = await routeur('ip host R2 10.0.0.2');
    expect(await d.executeCommand('show hosts')).toContain('10.0.0.2');
    await enConfig(d, 'no ip host r2');
    expect(await d.executeCommand('show hosts')).not.toContain('10.0.0.2');
  }, 30_000);

  it('une adresse invalide est refusee et rien n\'est range', async () => {
    const d = await routeur();
    expect(refuse(await enConfig(d, 'ip host bad 999.1.1.1'))).toBe(true);
    expect(await d.executeCommand('show hosts')).not.toContain('bad');
  }, 30_000);

  it('`clear host <nom>` retire l\'entree', async () => {
    const d = await routeur('ip host R2 10.0.0.2', 'ip host R3 10.0.0.3');
    await d.executeCommand('clear host R2');
    const out = await d.executeCommand('show hosts');
    expect(out).not.toContain('10.0.0.2');
    expect(out, 'les autres restent').toContain('10.0.0.3');
  }, 30_000);

  it('`clear host *` vide le cache appris mais garde le statique', async () => {
    const d = await routeur('ip host R2 10.0.0.2');
    await d.executeCommand('clear host *');
    expect(await d.executeCommand('show hosts'),
      'une entree `ip host` est configuree, pas apprise').toContain('10.0.0.2');
  }, 30_000);

  it('la table survit a un aller-retour de configuration', async () => {
    const d = await routeur('ip host R2 10.0.0.2');
    const rc = await d.executeCommand('show running-config');
    expect(rc).toContain('ip host R2 10.0.0.2');
  }, 30_000);
});

describe('partie 4 : resoudre pour de vrai, sur le fil', () => {
  it('`ping <nom>` resout par la table statique sans serveur', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip host serveur 192.168.1.10');
    await r.executeCommand('end');
    const out = await r.executeCommand('ping serveur');
    expect(out).toContain('192.168.1.10');
    expect(out, 'le premier paquet part en ARP, comme sur un vrai IOS')
      .toMatch(/Success rate is (80|100) percent/);
  }, 60_000);

  it('`ping <nom>` interroge le serveur DNS configure', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip name-server 192.168.1.10');
    await r.executeCommand('ip domain-lookup');
    await r.executeCommand('end');
    const out = await r.executeCommand('ping www.lab.local');
    expect(out, 'le nom a ete resolu en une adresse').toContain('192.168.1.50');
  }, 60_000);

  it('un nom resolu par DNS entre dans le cache en TEMPORAIRE', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip name-server 192.168.1.10');
    await r.executeCommand('end');
    await r.executeCommand('ping www.lab.local');
    const out = await r.executeCommand('show hosts');
    expect(out).toContain('www.lab.local');
    expect(out, 'appris par DNS, donc temporaire').toMatch(/www\.lab\.local.*\(temp, OK\)/);
  }, 60_000);

  it('`clear host *` vide ce que le DNS a appris', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip name-server 192.168.1.10');
    await r.executeCommand('end');
    await r.executeCommand('ping www.lab.local');
    await r.executeCommand('clear host *');
    expect(await r.executeCommand('show hosts')).not.toContain('www.lab.local');
  }, 60_000);

  it('le suffixe de `ip domain-name` complete un nom court', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip name-server 192.168.1.10');
    await r.executeCommand('ip domain-name lab.local');
    await r.executeCommand('end');
    const out = await r.executeCommand('ping www');
    expect(out, '`www` a ete complete en `www.lab.local`').toContain('192.168.1.50');
  }, 60_000);

  it('`no ip domain-lookup` empeche vraiment la resolution', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip name-server 192.168.1.10');
    await r.executeCommand('no ip domain-lookup');
    await r.executeCommand('end');
    const out = await r.executeCommand('ping www.lab.local');
    expect(out).not.toContain('192.168.1.50');
    expect(out).toMatch(/% Unrecognized host or address|% Bad IP address/);
  }, 60_000);

  it('une commande inconnue ne part PAS en resolution quand la recherche est coupee', async () => {
    const d = await routeur('no ip domain-lookup');
    const out = await d.executeCommand('sh runn');
    expect(out).not.toMatch(/Translating/);
  }, 30_000);

  it('la table statique l\'emporte sur le serveur DNS', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip name-server 192.168.1.10');
    await r.executeCommand('ip host www.lab.local 192.168.1.99');
    await r.executeCommand('end');
    const out = await r.executeCommand('ping www.lab.local');
    expect(out, 'la table locale est consultee en premier').toContain('192.168.1.99');
    expect(out).not.toContain('192.168.1.50');
  }, 60_000);

  it('`traceroute <nom>` resout aussi', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip name-server 192.168.1.10');
    await r.executeCommand('end');
    expect(await r.executeCommand('traceroute www.lab.local')).toContain('192.168.1.50');
  }, 60_000);
});

describe('partie 5 : le routeur comme SERVEUR DNS', () => {
  it('`ip dns server` est acceptee et rendue', async () => {
    const d = await routeur('ip dns server');
    expect(await d.executeCommand('show running-config')).toContain('ip dns server');
  }, 30_000);

  it('`no ip dns server` la retire', async () => {
    const d = await routeur('ip dns server', 'no ip dns server');
    expect(await d.executeCommand('show running-config')).not.toContain('ip dns server');
  }, 30_000);

  it('le routeur ecoute vraiment sur UDP/53 une fois active', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dns server');
    await r.executeCommand('end');
    const svc = (r as unknown as {
      getDnsService(): { estLie(): boolean };
    }).getDnsService();
    expect(svc.estLie(), 'un serveur qui ne lie aucun port ne sert personne').toBe(true);
    await r.executeCommand('configure terminal');
    await r.executeCommand('no ip dns server');
    await r.executeCommand('end');
    expect(svc.estLie(), 'et il libere le port quand on le coupe').toBe(false);
  }, 60_000);

  it('il repond a une requete pour un nom de sa table `ip host`', async () => {
    const { r, srv } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip host imprimante 192.168.1.77');
    await r.executeCommand('ip dns server');
    await r.executeCommand('end');
    const out = await srv.executeCommand('dig @192.168.1.1 imprimante +short');
    expect(out, 'le routeur a repondu depuis sa table').toContain('192.168.1.77');
  }, 60_000);

  it('il repond NXDOMAIN pour un nom qu\'il ne connait pas', async () => {
    const { r, srv } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dns server');
    await r.executeCommand('end');
    const out = await srv.executeCommand('dig @192.168.1.1 inconnu.example');
    expect(out).toMatch(/NXDOMAIN/);
  }, 60_000);

  it('`ip dns primary <zone> soa` declare la zone et est rendue', async () => {
    const d = await routeur('ip dns primary lab.local soa ns.lab.local admin.lab.local');
    expect(await d.executeCommand('show running-config'))
      .toContain('ip dns primary lab.local soa ns.lab.local admin.lab.local');
  }, 30_000);

  it('`ip host <zone> ns <serveur>` declare un enregistrement NS', async () => {
    const d = await routeur('ip host lab.local ns ns1.lab.local');
    expect(await d.executeCommand('show running-config'))
      .toContain('ip host lab.local ns ns1.lab.local');
  }, 30_000);

  it('`show ip dns statistics` compte ce qui est vraiment passe', async () => {
    const { r, srv } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip host imprimante 192.168.1.77');
    await r.executeCommand('ip dns server');
    await r.executeCommand('end');
    const avant = await r.executeCommand('show ip dns statistics');
    expect(refuse(avant)).toBe(false);
    await srv.executeCommand('dig @192.168.1.1 imprimante +short');
    const apres = await r.executeCommand('show ip dns statistics');
    expect(apres, 'les compteurs sont une mesure').not.toBe(avant);
  }, 60_000);
});

describe('partie 6 : DNS et DHCP', () => {
  it('`dns-server` et `domain-name` sont acceptes dans un pool', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('ip dhcp pool LAN');
    const a = await d.executeCommand('network 192.168.1.0 255.255.255.0');
    const b = await d.executeCommand('dns-server 192.168.1.10 192.168.1.11');
    const c = await d.executeCommand('domain-name lab.local');
    await d.executeCommand('end');
    for (const [nom, r] of [['network', a], ['dns-server', b], ['domain-name', c]] as const) {
      expect(refuse(r), nom).toBe(false);
    }
  }, 30_000);

  it('le pool rend ses deux lignes dans la configuration', async () => {
    const d = await routeur();
    await d.executeCommand('configure terminal');
    await d.executeCommand('ip dhcp pool LAN');
    await d.executeCommand('network 192.168.1.0 255.255.255.0');
    await d.executeCommand('dns-server 192.168.1.10 192.168.1.11');
    await d.executeCommand('domain-name lab.local');
    await d.executeCommand('end');
    const rc = await d.executeCommand('show running-config');
    expect(rc).toContain('dns-server 192.168.1.10 192.168.1.11');
    expect(rc).toContain('domain-name lab.local');
  }, 30_000);
});

describe('partie 7 : le diagnostic', () => {
  it('`debug ip domain` est acceptee', async () => {
    const d = await routeur();
    expect(refuse(await d.executeCommand('debug ip domain'))).toBe(false);
    await d.executeCommand('undebug all');
  }, 30_000);

  it('`debug domain` est le synonyme historique et repond pareil', async () => {
    const d = await routeur();
    expect(refuse(await d.executeCommand('debug domain'))).toBe(false);
    await d.executeCommand('undebug all');
  }, 30_000);

  it('`show debugging` annonce la trace DNS active', async () => {
    const d = await routeur();
    await d.executeCommand('debug ip domain');
    expect(await d.executeCommand('show debugging')).toMatch(/[Dd]omain/);
    await d.executeCommand('undebug all');
  }, 30_000);

  it('une resolution reelle produit une ligne de trace', async () => {
    const { r } = await laboAvecServeurDns();
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip name-server 192.168.1.10');
    await r.executeCommand('end');
    await r.executeCommand('debug ip domain');
    await r.executeCommand('ping www.lab.local');
    expect(await r.executeCommand('show logging')).toMatch(/[Dd]omain|DNS/);
  }, 60_000);
});

describe('partie 8 : le meme tutoriel sur un commutateur', () => {
  const COMMANDES = [
    'ip domain-lookup',
    'ip domain-name lab.local',
    'ip name-server 192.168.1.10',
    'ip host R2 10.0.0.2',
  ];
  it.each(COMMANDES)('`%s` est acceptee sur un Catalyst', async (cmd) => {
    const d = await commutateur();
    expect(refuse(await enConfig(d, cmd)), cmd).toBe(false);
  }, 30_000);

  it('`show hosts` du commutateur decrit la meme table', async () => {
    const d = await commutateur('ip domain-name lab.local', 'ip host R2 10.0.0.2');
    const out = await d.executeCommand('show hosts');
    expect(out).toContain('Default domain is lab.local');
    expect(out).toContain('10.0.0.2');
  }, 30_000);

  it('le commutateur rend la meme configuration que le routeur', async () => {
    const sw = await commutateur('ip domain-name lab.local', 'ip name-server 192.168.1.10');
    const rc = await sw.executeCommand('show running-config');
    expect(rc).toContain('ip domain-name lab.local');
    expect(rc).toContain('ip name-server 192.168.1.10');
  }, 30_000);
});

describe('partie 9 : le pendant Huawei', () => {
  const COMMANDES = [
    'dns resolve',
    'dns server 192.168.1.10',
    'dns domain lab.local',
    'ip host R2 10.0.0.2',
  ];
  it.each(COMMANDES)('`%s` est acceptee sur VRP', async (cmd) => {
    const d = new HuaweiRouter('H1', 0, 0);
    d.powerOn();
    await d.executeCommand('system-view');
    const r = await d.executeCommand(cmd);
    await d.executeCommand('quit');
    expect(/Error:|Unrecognized/.test(r), cmd).toBe(false);
  }, 30_000);

  it('`display dns server` decrit les serveurs configures', async () => {
    const d = new HuaweiRouter('H1', 0, 0);
    d.powerOn();
    await d.executeCommand('system-view');
    await d.executeCommand('dns resolve');
    await d.executeCommand('dns server 192.168.1.10');
    await d.executeCommand('quit');
    expect(await d.executeCommand('display dns server')).toContain('192.168.1.10');
  }, 30_000);

  it('`display dns domain` decrit les suffixes', async () => {
    const d = new HuaweiRouter('H1', 0, 0);
    d.powerOn();
    await d.executeCommand('system-view');
    await d.executeCommand('dns domain lab.local');
    await d.executeCommand('quit');
    expect(await d.executeCommand('display dns domain')).toContain('lab.local');
  }, 30_000);

  it('la configuration VRP est rendue', async () => {
    const d = new HuaweiRouter('H1', 0, 0);
    d.powerOn();
    await d.executeCommand('system-view');
    await d.executeCommand('dns resolve');
    await d.executeCommand('dns server 192.168.1.10');
    await d.executeCommand('dns domain lab.local');
    await d.executeCommand('quit');
    const cc = await d.executeCommand('display current-configuration');
    expect(cc).toContain('dns resolve');
    expect(cc).toContain('dns server 192.168.1.10');
    expect(cc).toContain('dns domain lab.local');
  }, 30_000);
});
