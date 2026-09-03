/**
 * Un jeu de transformations ne contient que des transformations qui
 * existent — sans quoi le tunnel monte SANS CHIFFREMENT.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference IOS :
 *
 *   crypto ipsec transform-set <nom> <transformation> [<transformation>]…
 *
 * Les transformations forment un vocabulaire FERME : chiffrement ESP
 * (`esp-aes`, `esp-3des`, `esp-des`, `esp-gcm`, `esp-null`),
 * authentification ESP (`esp-sha-hmac`, `esp-md5-hmac`, …) et
 * authentification AH (`ah-sha-hmac`, `ah-md5-hmac`, …). La forme
 * `esp-aes 256` s'ecrit en DEUX mots.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   crypto ipsec transform-set FAUX zorglub
 *              -> ACCEPTE, rendu `crypto ipsec transform-set FAUX zorglub`
 *   crypto ipsec transform-set MIXTE esp-aes zorglub
 *              -> ACCEPTE, rendu tel quel
 *
 * et `show crypto ipsec transform-set` les DECRIT comme des jeux
 * legitimes : `Transform set FAUX: { zorglub }`.
 *
 * LA CONSEQUENCE EST LA PARTIE QUI COMPTE, et elle a ete VERIFIEE dans le
 * moteur plutot que supposee : `deriveCryptoKeys` parcourt les
 * transformations dans une chaine de `else if` et n'a AUCUNE branche
 * finale — un mot inconnu ne correspond a rien, la boucle passe, et les
 * valeurs de depart restent celles de la declaration :
 * `espEncAlgorithm = 'null'`, `espAuthAlgorithm = 'none'`. Un jeu de
 * transformations mal orthographie donne donc un tunnel qui monte, que
 * `show crypto ipsec transform-set` decrit comme configure, et qui ne
 * chiffre RIEN. C'est l'inverse exact de ce qu'un apprenant croit avoir
 * pose, et rien ne le dit.
 *
 * Le vocabulaire ETAIT DEJA ECRIT — c'est cette meme chaine de `else if`
 * du moteur — et l'analyseur ne le lisait pas.
 *
 * TROUVE PAR L'EXTRACTION ELLE-MEME, et c'est ce qui la justifie :
 * `esp-aes 128` — forme legitime, que la suite `wan-vpn-topology` tape —
 * ne figurait dans AUCUNE branche de la chaine du moteur, qui connaissait
 * `esp-aes`, `esp-aes-128`, `esp-aes 192` et `esp-aes 256` mais pas
 * celle-la. Elle tombait donc au travers, exactement comme `zorglub`, et
 * ce laboratoire montait depuis toujours un tunnel a chiffrement NUL en
 * croyant poser de l'AES-128. Le defaut etait invisible tant que la table
 * n'etait lue par personne ; il est devenu visible a la seconde ou un
 * analyseur s'est mis a la lire, et un cas l'epingle.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 6 des 24 cas
 * tombent avant correctif, et la proportion est DITE plutot que
 * maquillee : ce lot n'ajoute qu'un refus, donc seuls les cas de refus
 * peuvent tomber. Les 18 autres sont la pour une raison precise — un
 * analyseur qui acceptait TOUT acceptait aussi les treize formes VRAIES
 * du vocabulaire, et sans elles un correctif qui refuserait tout, ou qui
 * oublierait la moitie de la table en la recopiant, satisferait la sonde.
 * Ce sont elles qui verifient que la table extraite du moteur est
 * COMPLETE, y compris la forme en deux mots `esp-aes 256` et les alias
 * (`esp-sha1-hmac`, `esp-aes-128`), et les quatre derniers cas gardent ce
 * que la famille faisait deja : le refus d'un jeu vide, la vue, le `no`,
 * et la declaration d'un second jeu depuis le mode du premier.
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

async function vue(d: Dev): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show crypto ipsec transform-set'));
}

describe('une transformation qui n existe pas est refusee', () => {
  const INVENTEES = [
    'crypto ipsec transform-set FAUX zorglub',
    'crypto ipsec transform-set MIXTE esp-aes zorglub',
    'crypto ipsec transform-set AUSSI esp-aes-999',
    'crypto ipsec transform-set ENCORE esp-sha-hmac ah-zorglub',
  ];

  it.each(INVENTEES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`I${INVENTEES.indexOf(cmd)}`);
    expect(await conf(d, cmd)).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('IR');
    await conf(d, ...INVENTEES);
    expect(await config(d)).not.toContain('zorglub');
  });

  it('ni dans la vue', async () => {
    const d = routeur('IV');
    await conf(d, ...INVENTEES);
    expect(await vue(d)).not.toContain('zorglub');
  });
});

describe('le vocabulaire du moteur est accepte en entier', () => {
  const VRAIES = [
    'esp-aes esp-sha-hmac',
    'esp-aes-256 esp-sha256-hmac',
    'esp-aes 256 esp-sha-hmac',
    'esp-aes 128 esp-sha-hmac',
    'esp-aes 192 esp-sha-hmac',
    'esp-3des esp-md5-hmac',
    'esp-des esp-sha-hmac',
    'esp-null esp-sha-hmac',
    'esp-gcm',
    'esp-gcm 256',
    'ah-sha-hmac',
    'ah-md5-hmac esp-aes',
    'esp-sha384-hmac',
    'esp-sha512-hmac',
    'ah-sha256-hmac',
  ];

  it.each(VRAIES)('`%s` est accepte et RELU', async (transforms) => {
    const d = routeur(`V${VRAIES.indexOf(transforms)}`);
    expect(await conf(d, `crypto ipsec transform-set TS ${transforms}`)).not.toContain('%');
    expect(await config(d)).toContain(`crypto ipsec transform-set TS ${transforms}`);
  });
});

describe('la casse ne change rien', () => {
  it('`ESP-AES ESP-SHA-HMAC` est accepte', async () => {
    const d = routeur('CA');
    expect(await conf(d, 'crypto ipsec transform-set TS ESP-AES ESP-SHA-HMAC'))
      .not.toContain('%');
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('un jeu sans transformation reste incomplet', async () => {
    const d = routeur('XA');
    expect(await conf(d, 'crypto ipsec transform-set VIDE')).toContain('% Incomplete command.');
  });

  it('`show crypto ipsec transform-set` decrit toujours un jeu pose', async () => {
    const d = routeur('XB');
    await conf(d, 'crypto ipsec transform-set BON esp-aes esp-sha-hmac');
    expect(await vue(d)).toContain('Transform set BON: { esp-aes esp-sha-hmac }');
  });

  it('`no crypto ipsec transform-set` retire toujours', async () => {
    const d = routeur('XC');
    await conf(d, 'crypto ipsec transform-set BON esp-aes esp-sha-hmac', 'exit',
      'no crypto ipsec transform-set BON');
    expect(await config(d)).not.toContain('transform-set BON');
  });

  it('et le jeu se declare aussi depuis le mode d un AUTRE jeu', async () => {
    const d = routeur('XD');
    await conf(d, 'crypto ipsec transform-set UN esp-aes esp-sha-hmac',
      'crypto ipsec transform-set DEUX esp-3des esp-md5-hmac');
    const cfg = await config(d);
    expect(cfg).toContain('crypto ipsec transform-set UN esp-aes esp-sha-hmac');
    expect(cfg).toContain('crypto ipsec transform-set DEUX esp-3des esp-md5-hmac');
  });
});
