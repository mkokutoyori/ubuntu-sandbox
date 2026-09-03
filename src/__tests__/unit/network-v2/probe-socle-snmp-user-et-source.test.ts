/**
 * Un algorithme SNMPv3 se choisit dans une liste.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   snmp-server user <nom> <groupe> {v1 | v2c | v3}
 *       [auth {md5 | sha} <mot de passe>
 *         [priv {des | 3des | aes {128 | 192 | 256}} <mot de passe>]]
 *       [access <liste>]
 *
 * Les protocoles d'authentification de SNMPv3 sont HMAC-MD5-96 et
 * HMAC-SHA-96 (RFC 3414 §6 et §7), et le chiffrement est DES (RFC 3414
 * §8), 3DES ou AES (RFC 3826) : ce sont des ensembles FERMES, definis par
 * le protocole et non par un constructeur. La version, elle, est un
 * argument OBLIGATOIRE de la commande.
 *
 * UNE PREMISSE DE CETTE SONDE A ETE ABANDONNEE, et c'est ecrit ici plutot
 * qu'efface : elle exigeait au depart que l'interface de
 * `ip domain lookup source-interface` EXISTE, et le correctif faisait
 * tomber `tuto-dns-cisco-conformite`, qui nomme une `Loopback0` non
 * creee. Rien n'atteste ce que fait un vrai IOS dans ce cas — la
 * documentation de Cisco n'est pas atteignable depuis ce reseau — et un
 * test de conformite du depot dit le contraire de ma premisse. La regle
 * du depot tranche : quand la source ne peut pas etre atteinte, on
 * l'ecrit et on n'implante pas. Le point est inscrit au `TODO.md`.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   snmp-server user u1 g1 v3 auth zorglub pass
 *          -> ACCEPTE, rendu tel quel
 *   snmp-server user u3 g3 v3 auth sha pass priv zorglub cle
 *          -> ACCEPTE, rendu tel quel
 *   snmp-server user u5 g5 zorglub
 *          -> ACCEPTE, et rendu `snmp-server user u5 g5 v1`
 * Le troisieme est le plus retors : la version inventee n'est pas rangee,
 * elle est SILENCIEUSEMENT REMPLACEE par `v1`. La configuration ne
 * reproduit donc pas ce qui a ete tape, et comme elle est REJOUEE a
 * l'import d'une topologie, l'utilisateur revient en SNMPv1 — sans
 * authentification ni chiffrement — alors que l'operateur croyait poser
 * un compte v3.
 *
 * La cause tient en deux `as` : `args[i + 1].toLowerCase() as 'md5' |
 * 'sha'` et `as 'des' | '3des' | 'aes'`. Le vocabulaire est DEJA ecrit —
 * ce sont les types de `SnmpUser` — et l'analyseur ne le verifie pas, il
 * s'y CONVERTIT de force.
 *
 * Discrimine par `git stash` sur les fichiers cables : 9 des 21 cas
 * tombent avant correctif. Les 14 autres sont nommes ici :
 *
 *   - `auth md5` / `auth sha`, `priv des` / `priv 3des`, `priv aes 256`
 *     et les trois versions justes : un analyseur
 *     qui convertit de force acceptait deja le juste. Ce sont les
 *     TEMOINS, et ce sont eux qui verifient que le vocabulaire declare
 *     est COMPLET — sans eux, oublier `3des` satisferait la sonde ;
 *   - `snmp-server user seul` sans groupe : la commande etait deja sans
 *     effet, et le reste ainsi ;
 *   - les deux cas de non-regression `snmp-server community` et
 *     `snmp-server group`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
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

type Dev = { executeCommand(c: string): Promise<string> };

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

describe('un protocole d authentification SNMPv3 est `md5` ou `sha`', () => {
  const INVENTES = ['zorglub', 'sha256', 'hmac'];

  it.each(INVENTES)('`auth %s` est refuse', async (algo) => {
    const d = routeur(`A${INVENTES.indexOf(algo)}`);
    expect(await conf(d, `snmp-server user u g v3 auth ${algo} motdepasse`)).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('AR');
    await conf(d, ...INVENTES.map((a) => `snmp-server user u g v3 auth ${a} motdepasse`));
    expect(await config(d)).not.toContain('zorglub');
  });

  it.each(['md5', 'sha'])('`auth %s` reste accepte et RELU', async (algo) => {
    const d = routeur(`AO${algo}`);
    expect(await conf(d, `snmp-server user u g v3 auth ${algo} motdepasse`)).not.toContain('%');
    expect(await config(d)).toContain(`snmp-server user u g v3 auth ${algo} motdepasse`);
  });
});

describe('un protocole de chiffrement SNMPv3 est `des`, `3des` ou `aes`', () => {
  const INVENTES = ['zorglub', 'rc4', 'aes512'];

  it.each(INVENTES)('`priv %s` est refuse', async (algo) => {
    const d = routeur(`P${INVENTES.indexOf(algo)}`);
    expect(await conf(d,
      `snmp-server user u g v3 auth sha mdp priv ${algo} cle`)).toContain('%');
  });

  it.each(['des', '3des'])('`priv %s` reste accepte', async (algo) => {
    const d = routeur(`PO${algo}`);
    expect(await conf(d,
      `snmp-server user u g v3 auth sha mdp priv ${algo} cle`)).not.toContain('%');
  });

  it('`priv aes 256 cle` reste accepte et RELU', async () => {
    const d = routeur('PA');
    expect(await conf(d,
      'snmp-server user u g v3 auth sha mdp priv aes 256 cle')).not.toContain('%');
    expect(await config(d)).toContain('priv aes 256');
  });

  it('et une longueur de cle AES inventee est refusee', async () => {
    const d = routeur('PK');
    expect(await conf(d,
      'snmp-server user u g v3 auth sha mdp priv aes 512 cle')).toContain('%');
  });
});

describe('la version d un utilisateur SNMP est celle qu on a tapee', () => {
  it('`snmp-server user u g zorglub` est refuse', async () => {
    const d = routeur('V1');
    expect(await conf(d, 'snmp-server user u g zorglub')).toContain('%');
  });

  it('et ne revient PAS en `v1` dans la configuration', async () => {
    const d = routeur('V2');
    await conf(d, 'snmp-server user u g zorglub');
    expect(await config(d)).not.toContain('snmp-server user u g v1');
  });

  it.each(['v1', 'v2c', 'v3'])('`%s` reste acceptee et RELUE', async (v) => {
    const d = routeur(`VO${v}`);
    expect(await conf(d, `snmp-server user u g ${v}`)).not.toContain('%');
    expect(await config(d)).toContain(`snmp-server user u g ${v}`);
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('`snmp-server user` sans groupe reste sans effet visible', async () => {
    const d = routeur('XA');
    await conf(d, 'snmp-server user seul');
    expect(await config(d)).not.toContain('snmp-server user seul');
  });

  it('`snmp-server community` reste acceptee et RELUE', async () => {
    const d = routeur('XB');
    await conf(d, 'snmp-server community public RO');
    expect(await config(d)).toContain('snmp-server community public RO');
  });

  it('et `snmp-server group` reste acceptee', async () => {
    const d = routeur('XC');
    expect(await conf(d, 'snmp-server group g v3 priv')).not.toContain('%');
  });
});
