/**
 * Les trois derniers points ouverts de `docs/PRD-Pistes-Audit-Cisco.md`.
 *
 * — **RADIUS, le jumeau exact du défaut TACACS+.**
 *   `radius-server host <ip> key <clé>` était rangé dans `legacyHosts`,
 *   un tableau que SEUL le rendu de la configuration lisait :
 *   `show radius statistics` répondait « No RADIUS servers configured »
 *   pendant que la configuration décrivait le serveur, et le groupe
 *   n'avait aucun membre résolvable.
 *
 * — **`snmp-server user … priv aes 256 <mot de passe>`**, et le défaut
 *   était pire que l'affichage : l'analyseur lisait le mot suivant `aes`
 *   comme l'algorithme et le SUIVANT comme le mot de passe, donc `256`
 *   DEVENAIT le mot de passe et le vrai secret était jeté. La machine
 *   chiffrait avec une clé que personne n'avait saisie, et la
 *   configuration relue la reproduisait.
 *
 * — **`verify /md5 <fichier>`** répondait `% Incomplete command` même
 *   avec un argument : l'option était retirée du PREMIER argument par
 *   une expression régulière, comme si elle était collée au nom de
 *   fichier, alors que la CLI la découpe en un jeton à part. Seule la
 *   forme sans option était atteignable — c'est-à-dire pas celle qu'on
 *   tape.
 *
 * Discriminé par remise en état des cinq fichiers produit : **8 cas sur
 * 13 tombent** avant correctif. Les 5 qui passent des deux côtés sont
 * nommés ici : le TÉMOIN et le cas de non-régression (dont c'est l'objet),
 * le chemin DES de SNMP (qui n'a jamais eu de longueur de clé et n'était
 * donc pas touché), et deux qui ne prouvent rien du mécanisme —
 * « `no radius-server host` le retire » passait parce qu'il n'y avait
 * rien à voir de toute façon, et « sans argument, la commande est
 * incomplète » parce qu'elle l'était pour toutes les formes.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function cfg(r: CiscoRouter, cmds: string[]): Promise<string> {
  const sorties: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds, 'end']) {
    sorties.push(String(await r.executeCommand(c)));
  }
  return sorties.join('\n');
}

const RADIUS_MODERNE = [
  'aaa new-model',
  'radius server RAD1', 'address ipv4 10.0.0.2 auth-port 1812 acct-port 1813',
  'key Secret123', 'exit',
  'aaa group server radius GRP', 'server name RAD1', 'exit',
];

const RADIUS_HERITE = [
  'aaa new-model',
  'radius-server host 10.0.0.2 key Secret123',
  'aaa group server radius GRP', 'server 10.0.0.2', 'exit',
];

describe('RADIUS : la forme héritée déclare un vrai serveur', () => {
  /** Le témoin : sans lui, l'échec de la forme héritée ne prouverait rien. */
  it('témoin — la forme moderne est vue par `show radius statistics`', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, RADIUS_MODERNE);
    expect(String(await r.executeCommand('show radius statistics')))
      .toContain('Server: RAD1 (10.0.0.2)');
  });

  it('la forme héritée aussi', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, RADIUS_HERITE);
    const out = String(await r.executeCommand('show radius statistics'));
    expect(out).not.toContain('No RADIUS servers configured');
    expect(out).toContain('10.0.0.2');
  });

  /**
   * RADIUS a DEUX ports là où TACACS+ n'en a qu'un, et les confondre
   * enverrait les traces de comptabilité sur le port des demandes.
   */
  it('les deux ports sont retenus séparément', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, ['radius-server host 10.0.0.2 auth-port 1812 acct-port 1813 key K']);
    const cfgText = String(await r.executeCommand('show running-config'));
    expect(cfgText).toContain('auth-port 1812');
    expect(cfgText).toContain('acct-port 1813');
  });

  it('la configuration garde l\'orthographe de chaque forme', async () => {
    const a = new CiscoRouter('A');
    await cfg(a, RADIUS_HERITE);
    const cfgA = String(await a.executeCommand('show running-config'));
    expect(cfgA).toContain('radius-server host 10.0.0.2 key Secret123');
    expect(cfgA).toContain(' server 10.0.0.2');
    expect(cfgA).not.toContain(' server name 10.0.0.2');
    expect(cfgA).not.toContain('radius server 10.0.0.2');

    const b = new CiscoRouter('B');
    await cfg(b, RADIUS_MODERNE);
    const cfgB = String(await b.executeCommand('show running-config'));
    expect(cfgB).toContain('radius server RAD1');
    expect(cfgB).toContain(' server name RAD1');
  });

  it('`no radius-server host` le retire', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, ['radius-server host 10.0.0.2 key K']);
    await cfg(r, ['no radius-server host 10.0.0.2']);
    expect(String(await r.executeCommand('show radius statistics')))
      .toBe('No RADIUS servers configured');
  });
});

describe('SNMPv3 : la longueur de clé AES n\'est plus prise pour le secret', () => {
  it('le mot de passe survit à `priv aes 256`', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, ['snmp-server group G v3 priv',
      'snmp-server user U G v3 auth sha AuthPass2024 priv aes 256 PrivPass2024']);
    const cfgText = String(await r.executeCommand('show running-config'));
    expect(cfgText).toContain('priv aes 256 PrivPass2024');
    // Le defaut d'origine : `256` etait range COMME mot de passe.
    expect(cfgText).not.toMatch(/priv aes 256\s*$/m);
  });

  it('`show snmp user` nomme la longueur de clé — le contrôle A20', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, ['snmp-server group G v3 priv',
      'snmp-server user U G v3 auth sha AuthPass2024 priv aes 256 PrivPass2024']);
    expect(String(await r.executeCommand('show snmp user')))
      .toContain('Privacy Protocol: AES256');
  });

  it('sans longueur, rien n\'est inventé', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, ['snmp-server group G v3 priv',
      'snmp-server user U G v3 auth md5 AuthPass priv des DesPass']);
    expect(String(await r.executeCommand('show snmp user')))
      .toContain('Privacy Protocol: DES');
    expect(String(await r.executeCommand('show running-config')))
      .toContain('priv des DesPass');
  });
});

describe('`verify /md5` : le contrôle A22', () => {
  it('la forme avec option est acceptée', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    const out = String(await r.executeCommand(
      'verify /md5 flash:c2900-universalk9-mz.SPA.157-3.M5.bin'));
    expect(out).not.toContain('% Incomplete command');
    expect(out).toMatch(/Computed Hash\s+MD5 : [0-9a-f]{32}/);
  });

  /**
   * Un fichier qui a un CONTENU obtient sa vraie somme MD5 : c'est ce qui
   * rend la vérification d'une archive de configuration réelle plutôt que
   * décorative.
   */
  it('une archive de configuration obtient sa VRAIE somme', async () => {
    const r = new CiscoRouter('R1');
    await cfg(r, ['archive', 'path flash:archive/cfg', 'exit']);
    await r.executeCommand('archive config');
    const premier = String(await r.executeCommand('verify /md5 flash:archive/cfg-1'));
    const somme = /Computed Hash\s+MD5 : ([0-9a-f]{32})/.exec(premier)?.[1];
    expect(somme).toBeDefined();
    // La même archive rend la même somme, et une archive DIFFÉRENTE une
    // autre : sans cela le condensé ne vérifierait rien.
    await cfg(r, ['hostname CHANGE']);
    await r.executeCommand('archive config');
    const second = String(await r.executeCommand('verify /md5 flash:archive/cfg-2'));
    const somme2 = /Computed Hash\s+MD5 : ([0-9a-f]{32})/.exec(second)?.[1];
    expect(somme2).toBeDefined();
    expect(somme2).not.toBe(somme);
  });

  it('un fichier absent est nommé', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('verify /md5 flash:inexistant.bin')))
      .toContain('%Error opening flash:inexistant.bin');
  });

  it('sans argument, la commande est incomplète', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('verify /md5')))
      .toContain('% Incomplete command');
  });
});

describe('non-régression', () => {
  it('un routeur neuf ne déclare aucun serveur', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('show radius statistics')))
      .toBe('No RADIUS servers configured');
    expect(String(await r.executeCommand('show snmp user')))
      .toBe('No SNMP users configured');
  });
});
