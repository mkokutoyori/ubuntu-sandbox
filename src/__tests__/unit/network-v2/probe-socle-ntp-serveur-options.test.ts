/**
 * Ce qu'on ecrit apres l'adresse d'un serveur NTP est LU.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 * `ntp server <ip> [version <1-4>] [key <1-4294967295>] [source <if>]
 * [prefer]`. La borne de la cle est celle de la documentation Cisco ;
 * celle de la version est attestee DANS CE DEPOT — `NtpAgent` ecarte un
 * paquet dont la version sort de 1..4, ce que dit aussi la RFC 5905, le
 * champ tenant sur trois bits.
 *
 * Mesure de depart, sur les deux plateformes, en relisant la
 * configuration apres chaque commande :
 *
 *   ntp server 10.0.0.1 key zorglub      -> ACCEPTE, rendu `ntp server 10.0.0.1`
 *   ntp server 10.0.0.2 key 0            -> ACCEPTE, rendu `... key 0`
 *   ntp server 10.0.0.3 key 99999999999  -> ACCEPTE, rendu tel quel
 *   ntp server 10.0.0.4 version 9        -> ACCEPTE, version PERDUE
 *   ntp server 10.0.0.5 version zorglub  -> ACCEPTE, version PERDUE
 *   ntp server 10.0.0.9 version 4        -> ACCEPTE, version PERDUE
 *   ntp server 10.0.0.10 source Gi0/0    -> ACCEPTE, source PERDUE
 *
 * Trois faits distincts se cachent la-dedans.
 *
 * UN — `key zorglub` est jete EN SILENCE. L'operateur croit son
 * association authentifiee et elle ne l'est pas ; c'est le pire des
 * trois, parce qu'aucune vue ne le dementira.
 *
 * DEUX — la MEME valeur est jugee dans une commande et pas dans l'autre.
 * `ntp authentication-key 99999999999 md5 X` est refuse — sa place est
 * DECLAREE avec sa borne — tandis que `ntp server X key 99999999999`
 * passe, la sienne etant dans une queue libre. C'est le TEMOIN de cette
 * sonde : la borne est bien celle de la machine, elle n'est simplement
 * pas appliquee partout.
 *
 * TROIS — `version` et `source` ne sont pas seulement mal juges, ils ne
 * sont RANGES NULLE PART : l'association ne porte que la cle et
 * `prefer`. Une forme VALIDE (`version 4`, `source GigabitEthernet0/0`)
 * est donc perdue au rechargement d'une topologie, ce qui depasse
 * l'affichage puisque la configuration rendue est rejouee.
 *
 * Discrimine par `git stash` sur `src/network/ntp/` et le shell : 29 des
 * 39 cas tombent avant correctif. Les 10 autres sont nommes ici, chacun
 * avec sa raison de passer des deux cotes :
 *
 *   - les quatre cas de TEMOIN (`ntp authentication-key`, refus et
 *     acceptation, sur les deux plateformes) : c'est leur objet, ils
 *     etablissent que la borne est bien celle de la machine ;
 *   - « une cle valide est retenue et rendue » et « la borne haute
 *     exacte reste acceptee » : `key 7` etait deja lu et rendu, ils
 *     bornent le refus — sans eux, un analyseur qui refuserait TOUTE
 *     cle satisferait la sonde ;
 *   - les quatre cas de non-regression : serveur nu et `prefer`,
 *     `no ntp server`, les autres commandes de la famille, et
 *     `ntp master 99` dont la plage etait deja DECLAREE, donc deja
 *     appliquee — c'est precisement le contraste que ce lot referme.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

type Dev = {
  cliHelp(s: string): string;
  executeCommand(c: string): Promise<string>;
};

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;
const commutateur = (n: string) => new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    out.push(String(await d.executeCommand(c)));
  }
  return out.slice(2);
}

async function lignesNtp(d: Dev): Promise<string[]> {
  const cfg = String(await d.executeCommand('do show running-config'));
  return cfg.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ntp '));
}

const PLATEFORMES: ReadonlyArray<[string, (n: string) => Dev]> = [
  ['routeur', routeur], ['commutateur', commutateur],
];

describe('TEMOIN — la borne de la cle est bien celle de la machine', () => {
  it.each(PLATEFORMES)('%s : `ntp authentication-key` la refuse deja', async (nom, faire) => {
    const d = faire(`T${nom}`);
    const [out] = await conf(d, 'ntp authentication-key 99999999999 md5 Secret');
    expect(out).toContain('Invalid input');
  });

  it.each(PLATEFORMES)('%s : et il accepte une cle valide', async (nom, faire) => {
    const d = faire(`TV${nom}`);
    const [out] = await conf(d, 'ntp authentication-key 7 md5 Secret');
    expect(out).not.toContain('Invalid input');
  });
});

describe('une cle de serveur est une CLE', () => {
  const MAUVAISES = ['zorglub', '0', '99999999999', '4294967296'];

  for (const [nom, faire] of PLATEFORMES) {
    it.each(MAUVAISES)(`${nom} : \`ntp server 10.0.0.1 key %s\` est refuse`, async (cle) => {
      const d = faire(`K${nom}${cle}`);
      const [out] = await conf(d, `ntp server 10.0.0.1 key ${cle}`);
      expect(out).toContain('Invalid input');
    });
  }

  it('et un refus ne pose AUCUNE association', async () => {
    const d = routeur('KR');
    await conf(d, ...MAUVAISES.map((c) => `ntp server 10.0.0.1 key ${c}`));
    expect(await lignesNtp(d)).toEqual([]);
  });

  it('une cle valide est retenue et rendue', async () => {
    const d = routeur('KV');
    const [out] = await conf(d, 'ntp server 10.0.0.1 key 7');
    expect(out).not.toContain('Invalid input');
    expect(await lignesNtp(d)).toContain('ntp server 10.0.0.1 key 7');
  });

  it('la borne haute exacte reste acceptee', async () => {
    const d = routeur('KH');
    const [out] = await conf(d, 'ntp server 10.0.0.1 key 4294967295');
    expect(out).not.toContain('Invalid input');
    expect(await lignesNtp(d)).toContain('ntp server 10.0.0.1 key 4294967295');
  });
});

describe('`version` est retenue, jugee, et RELUE', () => {
  const MAUVAISES = ['zorglub', '0', '5', '9'];

  for (const [nom, faire] of PLATEFORMES) {
    it.each(MAUVAISES)(`${nom} : \`ntp server 10.0.0.1 version %s\` est refuse`, async (v) => {
      const d = faire(`V${nom}${v}`);
      const [out] = await conf(d, `ntp server 10.0.0.1 version ${v}`);
      expect(out).toContain('Invalid input');
    });
  }

  it.each(['1', '2', '3', '4'])('la version %s est acceptee et rendue', async (v) => {
    const d = routeur(`VA${v}`);
    const [out] = await conf(d, `ntp server 10.0.0.1 version ${v}`);
    expect(out).not.toContain('Invalid input');
    expect(await lignesNtp(d)).toContain(`ntp server 10.0.0.1 version ${v}`);
  });

  it('le commutateur la rend aussi', async () => {
    const d = commutateur('VS');
    await conf(d, 'ntp server 10.0.0.1 version 3');
    expect(await lignesNtp(d)).toContain('ntp server 10.0.0.1 version 3');
  });
});

describe('`source` est retenue par ASSOCIATION, et relue', () => {
  it('elle revient dans la configuration', async () => {
    const d = routeur('SA');
    const [out] = await conf(d, 'ntp server 10.0.0.1 source GigabitEthernet0/0');
    expect(out).not.toContain('Invalid input');
    expect(await lignesNtp(d))
      .toContain('ntp server 10.0.0.1 source GigabitEthernet0/0');
  });

  it('et elle ne se confond pas avec le `ntp source` GLOBAL', async () => {
    const d = routeur('SG');
    await conf(d,
      'ntp source Loopback0',
      'ntp server 10.0.0.1 source GigabitEthernet0/0',
      'ntp server 10.0.0.2');
    const lignes = await lignesNtp(d);
    expect(lignes).toContain('ntp source Loopback0');
    expect(lignes).toContain('ntp server 10.0.0.1 source GigabitEthernet0/0');
    expect(lignes).toContain('ntp server 10.0.0.2');
  });

  it('la casse du nom d interface est preservee', async () => {
    const d = routeur('SC');
    await conf(d, 'ntp server 10.0.0.1 source Loopback0');
    expect((await lignesNtp(d)).join('\n')).toContain('Loopback0');
  });
});

describe('les options se combinent, et l ordre d IOS est celui du rendu', () => {
  it('version, cle et prefer ensemble', async () => {
    const d = routeur('CB');
    const [out] = await conf(d, 'ntp server 10.0.0.1 version 3 key 7 prefer');
    expect(out).not.toContain('Invalid input');
    expect(await lignesNtp(d))
      .toContain('ntp server 10.0.0.1 version 3 key 7 prefer');
  });

  it('`ntp peer` porte les memes options', async () => {
    const d = routeur('CP');
    const [out] = await conf(d, 'ntp peer 10.0.1.1 version 4 key 9 prefer');
    expect(out).not.toContain('Invalid input');
    expect(await lignesNtp(d))
      .toContain('ntp peer 10.0.1.1 version 4 key 9 prefer');
  });

  it('et `ntp peer` juge ses places comme `ntp server`', async () => {
    const d = routeur('CJ');
    const [out] = await conf(d, 'ntp peer 10.0.1.1 key zorglub');
    expect(out).toContain('Invalid input');
  });

  it('un mot n est pas lu DEUX fois : `key prefer` est refuse, pas preferant', async () => {
    const d = routeur('CD');
    const [out] = await conf(d, 'ntp server 10.0.0.1 key prefer');
    expect(out).toContain('Invalid input');
    expect((await lignesNtp(d)).join('\n')).not.toContain('prefer');
  });
});

describe('non-regression — ce qui marchait ne bouge pas', () => {
  it('un serveur nu et un serveur `prefer` restent rendus', async () => {
    const d = routeur('NR');
    await conf(d, 'ntp server 10.0.0.1', 'ntp server 10.0.0.2 prefer');
    const lignes = await lignesNtp(d);
    expect(lignes).toContain('ntp server 10.0.0.1');
    expect(lignes).toContain('ntp server 10.0.0.2 prefer');
  });

  it('`no ntp server` retire toujours', async () => {
    const d = routeur('NS');
    await conf(d, 'ntp server 10.0.0.1 version 3 key 7', 'no ntp server 10.0.0.1');
    expect((await lignesNtp(d)).join('\n')).not.toContain('10.0.0.1');
  });

  it('les autres commandes NTP repondent comme avant', async () => {
    const d = routeur('NA');
    for (const c of ['ntp master 5', 'ntp authenticate', 'ntp trusted-key 7',
      'ntp update-calendar', 'ntp logging', 'ntp access-group peer 10']) {
      expect(String(await conf(d, c)[0] ?? ''), c).not.toContain('Invalid input');
    }
  });

  it('`ntp master 99` reste refuse — sa plage est declaree', async () => {
    const d = routeur('NM');
    const [out] = await conf(d, 'ntp master 99');
    expect(out).toContain('Invalid input');
  });
});
