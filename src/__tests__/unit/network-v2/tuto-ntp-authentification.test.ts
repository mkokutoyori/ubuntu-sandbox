/**
 * PRD-NTP-Tutoriel.md §7 / lot N5 — l'authentification NTP signe.
 *
 * Le tutoriel (§3.6, §9) fait de l'authentification la contre-mesure a
 * l'usurpation : « un attaquant envoie de faux paquets NTP pour deregler
 * l'horloge ». Trois laboratoires mesures AVANT tout correctif :
 *
 *     | Configuration          | Attendu | Mesure  |
 *     | Memes cles             | synchro | synchro |
 *     | Cles DIFFERENTES       | REJET   | synchro |
 *     | Client SANS aucune cle | REJET   | synchro |
 *
 * Le troisieme dit tout : il suffisait d'ecrire `ntp server X key 1` —
 * de NOMMER un numero — pour etre accepte. **Nommer une cle suffisait,
 * connaitre son secret n'etait pas requis.**
 *
 * ── Ce qui a ete verifie contre le materiel reel ────────────────────
 *
 * Trois points, parce qu'un simulateur qui se trompe ici enseigne un
 * faux reflexe de diagnostic :
 *
 * 1. **La construction du condensé** — RFC 5905 §7.3 : « 128-bit MD5
 *    hash computed over the key followed by the NTP packet header and
 *    extension fields (but not the Key Identifier or Message Digest
 *    fields) ». La cle PRECEDE l'en-tete de 48 octets.
 * 2. **L'echec est SILENCIEUX** sur IOS. Aucune source consultee ne
 *    confirme un `%NTP-4-AUTHENTICATION_FAILURE` ; le comportement
 *    rapporte est que le client ignore simplement le serveur. Le
 *    tutoriel affirme le contraire, et ce fichier suit le materiel.
 * 3. **`show ntp associations detail` est la SEULE vue qui montre
 *    l'etat d'authentification** — `show ntp associations` ne le revele
 *    pas, ce que la documentation et les transcriptions de terrain
 *    soulignent toutes deux.
 * 4. **Un serveur ne se TAIT pas** devant une requete mal authentifiee :
 *    il repond par un crypto-NAK. La documentation de reference l'ecrit
 *    mot pour mot — « the server responds with authenticated packets if
 *    correct, or a crypto-NAK packet if not ».
 *
 * ── Ce que ce fichier discrimine, et ce qu'il ne discrimine pas ─────
 *
 * `git stash` : **6 des 20 cas tombent** avant correctif. Les 14 autres
 * se repartissent en deux familles, nommees plutot que laissees a
 * decouvrir :
 *
 * - **sept cas portent sur le module `auth.ts`**, qui n'existait pas :
 *   ils ne peuvent rien discriminer et sont la comme garde-fou du
 *   condensé lui-meme ;
 * - **sept cas sont des temoins** — memes cles, absence de
 *   `ntp authenticate`, vue breve qui ne montre rien, association sans
 *   cle, silence du journal. Ils doivent passer des DEUX cotes : ce sont
 *   eux qui prouvent que le correctif n'a pas simplement tout casse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  calculerMacNtp, serialiserEnteteNtp, verifierMacNtp,
} from '@/network/ntp/auth';
import type { NtpPacket } from '@/network/ntp/types';
import { md5 } from '@/crypto';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

interface Options {
  cleServeur: string;
  cleClient?: string;
  /** Le client arme-t-il `ntp authenticate` ? */
  authClient?: boolean;
  /** Le client declare-t-il la cle fiable ? */
  fiableClient?: boolean;
}

/** Un serveur authentifiant et un client, sur un vrai cable. */
async function paire(o: Options) {
  const srv = new CiscoRouter(`S${++serie}`);
  const cli = new CiscoRouter(`C${++serie}`);
  new Cable(`a${serie}`).connect(
    srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ntp authenticate', `ntp authentication-key 1 md5 ${o.cleServeur}`,
    'ntp trusted-key 1', 'ntp master 2', 'end']) await srv.executeCommand(c);

  const cmds = ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit'];
  if (o.authClient !== false) cmds.push('ntp authenticate');
  if (o.cleClient) cmds.push(`ntp authentication-key 1 md5 ${o.cleClient}`);
  if (o.fiableClient !== false && o.cleClient) cmds.push('ntp trusted-key 1');
  cmds.push('ntp server 10.0.0.1 key 1', 'end');
  for (const c of cmds) await cli.executeCommand(c);
  return { srv, cli };
}

const synchronise = (s: string) => /^Clock is synchronized/.test(s);

/** Un paquet de reference, pour les cas qui exercent le condensé seul. */
const PAQUET: NtpPacket = {
  type: 'ntp', leapIndicator: 0, version: 4, mode: 'server', stratum: 2,
  poll: 6, precision: -20, rootDelay: 1, rootDispersion: 2,
  refIdentifier: '10.0.0.1', refTimestampMs: 1_700_000_000_000,
  origTimestampMs: 1_700_000_001_000, rxTimestampMs: 1_700_000_002_000,
  txTimestampMs: 1_700_000_003_000,
};

describe('le condensé est celui de RFC 5905, et il est reel', () => {
  it('l\'en-tete signe fait exactement 48 octets', () => {
    // C'est la longueur que la RFC couvre : « the NTP packet header »,
    // douze mots de 32 bits, sans l'identifiant de cle ni le condensé.
    expect(serialiserEnteteNtp(PAQUET)).toHaveLength(48);
  });

  it('le condensé est un MD5, donc 32 caracteres hexadecimaux', () => {
    expect(calculerMacNtp('Secret', PAQUET)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changer la CLE change le condensé', () => {
    expect(calculerMacNtp('CleA', PAQUET)).not.toBe(calculerMacNtp('CleB', PAQUET));
  });

  it('changer n\'IMPORTE QUEL champ signe change le condensé', () => {
    // C'est la seule propriete qui compte : un condensé qui ne
    // dependrait pas des champs ne prouverait rien.
    const base = calculerMacNtp('Secret', PAQUET);
    const variantes: Partial<NtpPacket>[] = [
      { stratum: 3 }, { poll: 7 }, { precision: -19 }, { rootDelay: 9 },
      { rootDispersion: 9 }, { refIdentifier: '10.0.0.2' },
      { refTimestampMs: 1 }, { origTimestampMs: 1 },
      { rxTimestampMs: 1 }, { txTimestampMs: 1 },
      { mode: 'client' }, { leapIndicator: 1 },
    ];
    for (const v of variantes) {
      expect(calculerMacNtp('Secret', { ...PAQUET, ...v }), JSON.stringify(v))
        .not.toBe(base);
    }
  });

  it('le NUMERO de cle et le condensé ne sont PAS couverts', () => {
    // La RFC les exclut explicitement, et c'est necessaire : un condensé
    // qui se couvrirait lui-meme serait incalculable.
    const base = calculerMacNtp('Secret', PAQUET);
    expect(calculerMacNtp('Secret', { ...PAQUET, keyId: 7 })).toBe(base);
    expect(calculerMacNtp('Secret', { ...PAQUET, mac: 'ff'.repeat(16) })).toBe(base);
  });

  it('la cle PRECEDE l\'en-tete : la construction n\'est pas symetrique', () => {
    // La RFC dit « the key followed by the NTP packet header ».
    // L'inverse — en-tete puis cle — donnerait un condensé different,
    // et c'est ce qu'on verifie en le calculant ici a la main.
    const entete = serialiserEnteteNtp(PAQUET);
    const cle = new TextEncoder().encode('Secret');
    const inverse = new Uint8Array(entete.length + cle.length);
    inverse.set(entete, 0);
    inverse.set(cle, entete.length);
    const macInverse = [...md5(inverse)]
      .map((o) => o.toString(16).padStart(2, '0')).join('');
    expect(calculerMacNtp('Secret', PAQUET)).not.toBe(macInverse);
  });

  it('la verification refuse un condensé absent ou faux', () => {
    const bon = calculerMacNtp('Secret', PAQUET);
    expect(verifierMacNtp('Secret', PAQUET, bon)).toBe(true);
    expect(verifierMacNtp('Secret', PAQUET, undefined)).toBe(false);
    expect(verifierMacNtp('Secret', PAQUET, 'ff'.repeat(16))).toBe(false);
    expect(verifierMacNtp('Autre', PAQUET, bon)).toBe(false);
  });
});

describe('§3.6 — les trois laboratoires du tutoriel', () => {
  it('memes cles : la synchronisation aboutit', async () => {
    const { cli } = await paire({ cleServeur: 'ClefNTP2024', cleClient: 'ClefNTP2024' });
    expect(await cli.executeCommand('show ntp status')).toMatch(/stratum 3/);
  });

  it('cles DIFFERENTES : la synchronisation echoue', async () => {
    // Le cas central. Il aboutissait.
    const { cli } = await paire({ cleServeur: 'CleServeur', cleClient: 'CleAutre' });
    const st = await cli.executeCommand('show ntp status');
    expect(synchronise(st)).toBe(false);
    expect(st).toMatch(/stratum 16/);
  });

  it('client SANS aucune cle : nommer `key 1` ne suffit plus', async () => {
    // Le cas le plus net : le client n'a ni cle ni `ntp authenticate`,
    // il ecrit seulement `ntp server 10.0.0.1 key 1`. Le serveur
    // l'acceptait.
    const { cli } = await paire({ cleServeur: 'CleServeur', authClient: false });
    expect(synchronise(await cli.executeCommand('show ntp status'))).toBe(false);
  });

  it('une cle connue mais NON declaree fiable ne suffit pas', async () => {
    // « Definir une cle n'est pas la faire confiance » — sans
    // `ntp trusted-key`, la cle existe et n'authentifie personne.
    const { cli } = await paire({
      cleServeur: 'MemeCle', cleClient: 'MemeCle', fiableClient: false,
    });
    expect(synchronise(await cli.executeCommand('show ntp status'))).toBe(false);
  });

  it('sans `ntp authenticate`, les cles ne font rien — dans les DEUX sens', async () => {
    // C'est la cause la plus frequente de « je croyais authentifier » :
    // des cles declarees et aucun `ntp authenticate`. Le client se
    // synchronise alors, parce qu'il n'exige rien.
    const srv = new CiscoRouter(`S${++serie}`);
    const cli = new CiscoRouter(`C${++serie}`);
    new Cable(`b${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 2', 'end']) await srv.executeCommand(c);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
      'ntp authentication-key 1 md5 UneCle', 'ntp trusted-key 1',
      'ntp server 10.0.0.1', 'end']) await cli.executeCommand(c);
    expect(await cli.executeCommand('show ntp status')).toMatch(/stratum 3/);
  });
});

describe('le diagnostic est celui d\'un vrai IOS', () => {
  it('`show ntp associations detail` porte `authenticated`', async () => {
    // Verifie contre le materiel : c'est la SEULE vue qui montre l'etat
    // d'authentification.
    const { cli } = await paire({ cleServeur: 'MemeCle', cleClient: 'MemeCle' });
    const d = await cli.executeCommand('show ntp associations detail');
    expect(d).toMatch(/^10\.0\.0\.1 configured, authenticated, our_master, sane, valid/m);
  });

  it('et `show ntp associations` ne le montre PAS', async () => {
    // La consequence pratique : un operateur qui reste sur la vue breve
    // ne peut pas savoir si l'authentification a joue.
    const { cli } = await paire({ cleServeur: 'MemeCle', cleClient: 'MemeCle' });
    expect(await cli.executeCommand('show ntp associations'))
      .not.toContain('authenticated');
  });

  it('une cle qui ne correspond pas se lit dans la meme vue', async () => {
    const { cli } = await paire({ cleServeur: 'CleServeur', cleClient: 'CleAutre' });
    expect(await cli.executeCommand('show ntp associations detail'))
      .toContain('unauthenticated');
  });

  it('une association SANS cle n\'est ni l\'un ni l\'autre', async () => {
    // Annoncer `unauthenticated` la ou aucune verification n'a eu lieu
    // serait affirmer un controle qui n'a pas ete fait.
    const srv = new CiscoRouter(`S${++serie}`);
    const cli = new CiscoRouter(`C${++serie}`);
    new Cable(`c${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp master 2', 'end']) await srv.executeCommand(c);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
      'ntp server 10.0.0.1', 'end']) await cli.executeCommand(c);
    const d = await cli.executeCommand('show ntp associations detail');
    expect(d).toContain('configured, our_master');
    expect(d).not.toContain('authenticated');
  });

  it('l\'echec est SILENCIEUX : aucun message n\'est journalise', async () => {
    // Verifie contre le materiel, et CONTRE le tutoriel : celui-ci
    // annonce un `%NTP-4-AUTHENTICATION_FAILURE` qu'aucune source
    // consultee ne confirme. Un simulateur qui l'emettrait apprendrait a
    // chercher une ligne qu'un vrai routeur n'ecrit pas.
    const { cli } = await paire({ cleServeur: 'CleServeur', cleClient: 'CleAutre' });
    const journal = await cli.executeCommand('show logging');
    expect(journal).not.toContain('NTP-4-AUTHENTICATION_FAILURE');
    expect(journal.toLowerCase()).not.toContain('authentication failure');
  });
});

describe('Huawei authentifie par le meme moteur', () => {
  it('memes cles : la synchronisation aboutit', async () => {
    const srv = new CiscoRouter(`S${++serie}`);
    const hw = new HuaweiRouter(`H${++serie}`);
    new Cable(`d${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, hw.getPort('GE0/0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp authenticate', 'ntp authentication-key 1 md5 MemeCle',
      'ntp trusted-key 1', 'ntp master 2', 'end']) await srv.executeCommand(c);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.2 255.255.255.0', 'undo shutdown', 'quit',
      'ntp-service authentication enable',
      'ntp-service authentication-keyid 1 authentication-mode md5 MemeCle',
      'ntp-service reliable authentication-keyid 1',
      'ntp-service unicast-server 10.0.0.1 authentication-keyid 1',
      'quit']) await hw.executeCommand(c);
    expect(await hw.executeCommand('display ntp-service status'))
      .toContain('Clock status: synchronized');
  });

  it('cles differentes : la synchronisation echoue, comme cote Cisco', async () => {
    const srv = new CiscoRouter(`S${++serie}`);
    const hw = new HuaweiRouter(`H${++serie}`);
    new Cable(`e${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, hw.getPort('GE0/0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp authenticate', 'ntp authentication-key 1 md5 CleServeur',
      'ntp trusted-key 1', 'ntp master 2', 'end']) await srv.executeCommand(c);
    for (const c of ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.0.2 255.255.255.0', 'undo shutdown', 'quit',
      'ntp-service authentication enable',
      'ntp-service authentication-keyid 1 authentication-mode md5 CleAutre',
      'ntp-service reliable authentication-keyid 1',
      'ntp-service unicast-server 10.0.0.1 authentication-keyid 1',
      'quit']) await hw.executeCommand(c);
    expect(await hw.executeCommand('display ntp-service status'))
      .toContain('Clock status: unsynchronized');
  });
});

describe('§9 — l\'usurpation que l\'authentification empeche', () => {
  it('un faux serveur ne peut pas se faire passer pour le vrai', async () => {
    // Le scenario du tutoriel : un attaquant repond a la place du
    // serveur. Il connait l'adresse, le numero de cle, tout — sauf le
    // secret. Sans condensé, il reussissait.
    const attaquant = new CiscoRouter(`A${++serie}`);
    const cli = new CiscoRouter(`C${++serie}`);
    new Cable(`f${serie}`).connect(
      attaquant.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      // L'attaquant declare la MEME cle numero 1, avec un autre secret.
      'ntp authenticate', 'ntp authentication-key 1 md5 SecretDeLAttaquant',
      'ntp trusted-key 1', 'ntp master 2', 'end']) await attaquant.executeCommand(c);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
      'ntp authenticate', 'ntp authentication-key 1 md5 LeVraiSecret',
      'ntp trusted-key 1', 'ntp server 10.0.0.1 key 1', 'end']) {
      await cli.executeCommand(c);
    }
    expect(synchronise(await cli.executeCommand('show ntp status'))).toBe(false);
    expect(await cli.executeCommand('show ntp associations detail'))
      .toContain('unauthenticated');
  });
});
