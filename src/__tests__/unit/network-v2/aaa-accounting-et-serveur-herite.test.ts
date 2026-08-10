/**
 * Les deux chantiers laissés ouverts par `docs/PRD-Pistes-Audit-Cisco.md`
 * §6, refermés ensemble parce qu'ils sont le même sujet.
 *
 * **La mesure a été faite contre un TÉMOIN monté dans le même
 * laboratoire**, et c'était nécessaire : au premier essai les DEUX formes
 * échouaient, ce qui aurait fait conclure à un défaut alors que c'était le
 * laboratoire qui était mal bâti. Avec le témoin, la mesure devient
 * lisible — la forme moderne authentifie, la forme héritée non.
 *
 * — `tacacs-server host <ip> key <clé>`, la forme la plus tapée de tous
 *   les cours, était rangée dans `legacyHosts`, un tableau que SEUL le
 *   rendu de la configuration lisait. La machine décrivait donc un
 *   serveur qu'elle n'avait pas : `show tacacs` répondait « No TACACS+
 *   servers configured » au même instant, et l'authentification ne
 *   trouvait rien. Un laboratoire monté entièrement à l'ancienne
 *   échouait en silence.
 * — `server <ip>` comme membre de groupe (la forme qui va avec) était
 *   acceptée et JETÉE : seul `server name <nom>` était lu.
 * — Les compteurs de `show tacacs` étaient uniquement LUS, jamais
 *   incrémentés : ils affichaient zéro après une authentification
 *   réussie.
 * — `TacacsClientAgent.accountCommand()` était écrit, correct, et
 *   n'avait AUCUN appelant de production — seul un test l'appelait.
 *   `aaa accounting commands 15` était donc accepté, rendu, et aucun
 *   paquet ne partait.
 * — `show accounting` répondait `% Invalid input detected`, donc le
 *   contrôle A10 d'une liste d'audit ne portait sur rien.
 *
 * Discriminé par remise en état des quatre fichiers produit : **10 cas
 * sur 13 tombent** avant correctif. Les 3 qui passent des deux côtés sont
 * nommés ici : le TÉMOIN (dont c'est l'objet même de passer des deux
 * côtés), « sans `aaa accounting`, rien ne part » (non-régression), et
 * « un mauvais mot de passe reste refusé », qui passait avant pour une
 * raison qui ne prouve rien — l'authentification échouait de toute façon.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

async function cfg(r: CiscoRouter, cmds: string[]): Promise<string> {
  const sorties: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds, 'end']) {
    sorties.push(String(await r.executeCommand(c)));
  }
  return sorties.join('\n');
}

/** Un NAS et un vrai serveur TACACS+, câblés. */
async function lab(): Promise<{ nas: CiscoRouter; srv: CiscoRouter }> {
  const nas = new CiscoRouter('NAS');
  const srv = new CiscoRouter('SRV');
  new Cable('c1').connect(nas.getPort('GigabitEthernet0/0')!, srv.getPort('GigabitEthernet0/0')!);
  nas.getPort('GigabitEthernet0/0')!
    .configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('GigabitEthernet0/0')!
    .configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  srv.getTacacsServer().setEnabled(true);
  srv.getTacacsServer().setSharedSecret('Secret123');
  srv.getTacacsServer().addUser('alice', 'Alice123', 15);
  return { nas, srv };
}

const MODERNE = [
  'aaa new-model',
  'tacacs server TAC1', 'address ipv4 10.0.0.2', 'port 49', 'key Secret123', 'exit',
  'aaa group server tacacs+ GRP', 'server name TAC1', 'exit',
  'aaa authentication login default group GRP local',
];

const HERITEE = [
  'aaa new-model',
  'tacacs-server host 10.0.0.2 key Secret123',
  'aaa group server tacacs+ GRP', 'server 10.0.0.2', 'exit',
  'aaa authentication login default group GRP local',
];

describe('§6a : un serveur déclaré à l\'ancienne EST un serveur', () => {
  /**
   * Le témoin. Sans lui, l'échec de la forme héritée ne prouverait rien :
   * un laboratoire mal monté et une fonction morte sont indiscernables.
   */
  it('témoin — la forme moderne authentifie', async () => {
    const { nas } = await lab();
    await cfg(nas, MODERNE);
    expect(await nas.authenticateViaAaa('alice', 'Alice123')).toBe(true);
  });

  it('la forme héritée authentifie aussi', async () => {
    const { nas } = await lab();
    await cfg(nas, HERITEE);
    expect(await nas.authenticateViaAaa('alice', 'Alice123')).toBe(true);
  });

  it('un mauvais mot de passe reste refusé (pas de faux positif)', async () => {
    const { nas } = await lab();
    await cfg(nas, HERITEE);
    expect(await nas.authenticateViaAaa('alice', 'MauvaisMot')).toBe(false);
  });

  it('`show tacacs` voit le serveur déclaré à l\'ancienne', async () => {
    const { nas } = await lab();
    await cfg(nas, HERITEE);
    const out = String(await nas.executeCommand('show tacacs'));
    expect(out).not.toContain('No TACACS+ servers configured');
    expect(out).toContain('Tacacs+ Server : 10.0.0.2/49');
  });

  /**
   * La configuration doit reproduire ce qui a été TAPÉ : elle est
   * rejouée à l'import d'une topologie, et réécrire la forme héritée en
   * `tacacs server <nom>` déclarerait un nom que l'opérateur n'a jamais
   * donné.
   */
  it('la configuration garde l\'orthographe de chaque forme', async () => {
    const { nas: a } = await lab();
    await cfg(a, HERITEE);
    const cfgA = String(await a.executeCommand('show running-config'));
    expect(cfgA).toContain('tacacs-server host 10.0.0.2 key Secret123');
    expect(cfgA).toContain(' server 10.0.0.2');
    expect(cfgA).not.toContain(' server name 10.0.0.2');

    const { nas: b } = await lab();
    await cfg(b, MODERNE);
    const cfgB = String(await b.executeCommand('show running-config'));
    expect(cfgB).toContain('tacacs server TAC1');
    expect(cfgB).toContain(' server name TAC1');
  });
});

describe('§6b : les compteurs de `show tacacs` sont mesurés', () => {
  it('une authentification réussie fait monter les compteurs', async () => {
    const { nas } = await lab();
    await cfg(nas, MODERNE);
    expect(String(await nas.executeCommand('show tacacs')))
      .toContain('Authen: request 0, success 0, fail 0');
    await nas.authenticateViaAaa('alice', 'Alice123');
    const out = String(await nas.executeCommand('show tacacs'));
    expect(out).toContain('Authen: request 1, success 1, fail 0');
    expect(out).toContain('Socket opens: 1, closes: 1');
  });

  it('un refus est compté comme un refus, pas comme un succès', async () => {
    const { nas } = await lab();
    await cfg(nas, MODERNE);
    await nas.authenticateViaAaa('alice', 'MauvaisMot');
    expect(String(await nas.executeCommand('show tacacs')))
      .toContain('Authen: request 1, success 0, fail 1');
  });
});

describe('§6c : l\'accounting émet vraiment', () => {
  it('une commande tapée arrive chez le collecteur', async () => {
    const { nas, srv } = await lab();
    await cfg(nas, [...MODERNE,
      'aaa accounting commands 15 default start-stop group GRP']);
    const avant = srv.getTacacsServer().getAccountingLog().length;
    await cfg(nas, ['hostname NASBIS']);
    const recus = srv.getTacacsServer().getAccountingLog();
    expect(recus.length).toBeGreaterThan(avant);
    expect(recus.some((r) => r.cmd.includes('hostname NASBIS'))).toBe(true);
    expect(recus.some((r) => r.user === 'console')).toBe(true);
  });

  /**
   * `start-stop` promet DEUX enregistrements par commande, `stop-only`
   * un seul. Les rendre identiques ferait mentir la configuration sur ce
   * que le collecteur reçoit.
   */
  it('`start-stop` émet un début ET une fin', async () => {
    const { nas, srv } = await lab();
    await cfg(nas, [...MODERNE,
      'aaa accounting commands 15 default start-stop group GRP']);
    srv.getTacacsServer().getAccountingLog();
    await cfg(nas, ['hostname CIBLE']);
    const pourCible = srv.getTacacsServer().getAccountingLog()
      .filter((r) => r.cmd.includes('hostname CIBLE'));
    expect(pourCible.some((r) => r.flags.includes('start'))).toBe(true);
    expect(pourCible.some((r) => r.flags.includes('stop'))).toBe(true);
  });

  it('sans `aaa accounting`, rien ne part', async () => {
    const { nas, srv } = await lab();
    await cfg(nas, MODERNE);
    await cfg(nas, ['hostname SANSCOMPTA']);
    expect(srv.getTacacsServer().getAccountingLog().length).toBe(0);
  });

  it('`show accounting` compte ce qui est réellement parti', async () => {
    const { nas } = await lab();
    await cfg(nas, [...MODERNE,
      'aaa accounting commands 15 default start-stop group GRP']);
    await cfg(nas, ['hostname COMPTE']);
    const out = String(await nas.executeCommand('show accounting'));
    expect(out).toContain('Overall Accounting Traffic:');
    expect(out).toMatch(/commands\s+\d+\s+\d+\s+0/);
    expect(out).not.toContain('(no accounting records)');
  });

  it('`Failed accounting` figure dans `show tacacs` — le contrôle A10', async () => {
    const { nas } = await lab();
    await cfg(nas, MODERNE);
    expect(String(await nas.executeCommand('show tacacs')))
      .toContain('Failed accounting: 0');
  });
});

describe('§6d : sans AAA, les vues le disent au lieu de mentir', () => {
  it('un routeur sans `aaa new-model` n\'émet rien, et les vues le disent', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, ['hostname R2']);
    expect(String(await r.executeCommand('show accounting')))
      .toContain('(no accounting records)');
    expect(String(await r.executeCommand('show tacacs')))
      .toBe('No TACACS+ servers configured');
  });
});
