/**
 * PRD-NTP-Tutoriel.md §13 / lot N11 — les requetes de controle (mode 6).
 *
 * ── Le defaut ───────────────────────────────────────────────────────
 *
 * Deux commandes de durcissement etaient **structurellement inertes** :
 *
 * - `ntp access-group query-only` : `verdictAccesNtp` connait l'action
 *   `control-query` depuis le lot N6, et rien dans le depot n'emettait ni
 *   ne recevait de requete de controle. Le seul effet observable de
 *   `query-only` etait donc de REFUSER le temps, jamais d'AUTORISER ce
 *   qu'il autorise ;
 * - `no ntp allow mode control` — la commande qui ferme la porte de
 *   `monlist` et de CVE-2013-5211 — etait rangee et lue par personne :
 *   une machine durcie et une machine ouverte se comportaient pareil.
 *
 * ── Ce qui passe des deux cotes, et pourquoi c'est dit ───────────────
 *
 * Les cas portant sur `control.ts` seul (disposition des bits, format des
 * variables, pointage) exercent un module NEUF : ce sont des garde-fous
 * de format, et non des preuves de correction. Ceux qui comptent envoient
 * un vrai datagramme sur un vrai cable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  serialiserEnteteControle, formaterVariables, analyserVariables,
  formaterListeAssociations, analyserListeAssociations,
  motEtatPair, motEtatSysteme, pointageDepuisSelect, SELECT,
  MODE_CONTROLE, OPCODES_CONTROLE, type NtpControlPacket,
} from '@/network/ntp/control';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/**
 * Un routeur `ntp master` avec une source, et un poste Linux qui
 * l'interroge par `ntpq`.
 *
 * Le routeur porte une association pour que `ntpq -p` ait quelque chose
 * a montrer : une liste vide passerait le test sans rien prouver.
 */
async function labo(confRouteur: string[] = []) {
  const amont = new CiscoRouter(`A${++serie}`);
  const rtr = new CiscoRouter(`R${serie}`);
  const pc = new LinuxPC(`P${serie}`);
  new Cable(`m${serie}`).connect(
    amont.getPort('GigabitEthernet0/0')!, rtr.getPort('GigabitEthernet0/0')!);
  new Cable(`n${serie}`).connect(
    rtr.getPort('GigabitEthernet0/1')!, pc.getPort('eth0')!);

  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ntp master 2', 'end']) await amont.executeCommand(c);
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ntp server 10.0.0.1', ...confRouteur, 'end']) await rtr.executeCommand(c);
  await pc.executeCommand('ip addr add 192.168.1.2/24 dev eth0');
  return { amont, rtr, pc };
}

describe('l\'en-tete de controle est celui de RFC 9327', () => {
  const PAQUET: NtpControlPacket = {
    type: 'ntp-control', leapIndicator: 0, version: 2,
    response: true, error: false, more: true,
    opcode: 2, sequence: 0x1234, status: 0x961a,
    associationId: 0x0007, offset: 0, count: 5, data: 'abcde',
  };

  it('il fait exactement douze octets', () => {
    expect(serialiserEnteteControle(PAQUET)).toHaveLength(12);
  });

  it('le mode vaut 6, et il partage l\'octet avec la version', () => {
    const o = serialiserEnteteControle(PAQUET);
    expect(o[0] & 0x7).toBe(MODE_CONTROLE);
    expect((o[0] >> 3) & 0x7).toBe(2);
  });

  it('R, E et M sont trois bits distincts au-dessus de l\'opcode', () => {
    // C'est la raison d'etre du module : ces trois-la partagent un octet
    // avec l'opcode, donc rien n'oblige un code qui les manipule
    // separement a rester d'accord avec la RFC.
    const o = serialiserEnteteControle(PAQUET);
    expect(o[1] & 0x80).toBe(0x80);
    expect(o[1] & 0x40).toBe(0);
    expect(o[1] & 0x20).toBe(0x20);
    expect(o[1] & 0x1f).toBe(2);
    const requete = serialiserEnteteControle({ ...PAQUET, response: false, more: false });
    expect(requete[1]).toBe(2);
  });

  it('les cinq champs de seize bits sont gros-boutiens', () => {
    const v = new DataView(serialiserEnteteControle(PAQUET).buffer);
    expect(v.getUint16(2)).toBe(0x1234);
    expect(v.getUint16(4)).toBe(0x961a);
    expect(v.getUint16(6)).toBe(0x0007);
    expect(v.getUint16(8)).toBe(0);
    expect(v.getUint16(10)).toBe(5);
  });

  it('les treize opcodes de la RFC sont nommes', () => {
    expect(OPCODES_CONTROLE[1]).toBe('read status');
    expect(OPCODES_CONTROLE[2]).toBe('read variables');
    expect(OPCODES_CONTROLE[10]).toBe('retrieve MRU list');
    expect(OPCODES_CONTROLE[31]).toBe('unset trap');
  });
});

describe('les mots d\'etat et la charge utile', () => {
  it('le champ `select` d\'un pair se relit ou il a ete ecrit', () => {
    const mot = motEtatPair(true, true, SELECT.SYSPEER, 0, 0);
    expect((mot >> 8) & 0x7).toBe(SELECT.SYSPEER);
  });

  it('le pointage de `ntpq -p` est DERIVE du champ `select`', () => {
    // Deux calculs pour une seule information finiraient par se
    // contredire ; il n'y en a qu'un.
    expect(pointageDepuisSelect(SELECT.SYSPEER)).toBe('*');
    expect(pointageDepuisSelect(SELECT.CANDIDATE)).toBe('+');
    expect(pointageDepuisSelect(SELECT.FALSETICK)).toBe('x');
    expect(pointageDepuisSelect(SELECT.REJECT)).toBe(' ');
  });

  it('l\'indicateur de saut occupe les deux bits de poids fort du mot systeme', () => {
    expect((motEtatSysteme(3, 0, 0, 0) >> 14) & 0x3).toBe(3);
    expect((motEtatSysteme(0, 6, 0, 0) >> 8) & 0x3f).toBe(6);
  });

  it('une valeur contenant une virgule est mise entre guillemets, et se relit', () => {
    // Sans les guillemets, `refid=A, x=1` et une valeur `A, x=1` seraient
    // indiscernables a la relecture.
    const texte = formaterVariables({ refid: 'A, x=1', stratum: '2' });
    expect(texte).toContain('refid="A, x=1"');
    expect(analyserVariables(texte)).toEqual({ refid: 'A, x=1', stratum: '2' });
  });

  it('la liste d\'associations fait l\'aller-retour', () => {
    const entrees = [{ id: 5, status: 0x961a }, { id: 9, status: 0x0014 }];
    expect(analyserListeAssociations(formaterListeAssociations(entrees))).toEqual(entrees);
  });
});

describe('`ntpq` interroge un vrai routeur, sur un vrai cable', () => {
  it('`ntpq -p` liste le pair du routeur avec sa strate et sa joignabilite', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand('ntpq -p 192.168.1.1');
    expect(out.split('\n')[0])
      .toBe('     remote           refid      st t when poll reach   delay   offset  jitter');
    const ligne = out.split('\n').find((l) => l.includes('10.0.0.1'));
    expect(ligne).toBeDefined();
    // Le routeur s'est synchronise sur l'amont : son pair est la source
    // retenue, donc pointe `*`.
    expect(ligne!.startsWith('*')).toBe(true);
    expect(ligne).toMatch(/\s2\su\s/);
  });

  it('`ntpq -c "rv 0"` rend les variables SYSTEME du routeur', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand('ntpq -c "rv 0" 192.168.1.1');
    expect(out).toMatch(/^associd=0 status=[0-9a-f]{4},/);
    expect(out).toContain('stratum=3');
    expect(out).toContain('refid=10.0.0.1');
  });

  it('`rv 0 stratum` ne rend QUE ce qu\'on demande', async () => {
    const { pc } = await labo();
    const out = await pc.executeCommand('ntpq -c "rv 0 stratum" 192.168.1.1');
    expect(out).toContain('stratum=3');
    expect(out).not.toContain('refid=');
  });

  it('une variable inconnue est NOMMEE plutot que tue', async () => {
    // La taire ferait croire a une valeur vide.
    const { pc } = await labo();
    expect(await pc.executeCommand('ntpq -c "rv 0 pasunevariable" 192.168.1.1'))
      .toContain('pasunevariable=?');
  });

  it('un identifiant d\'association inconnu est refuse en le nommant', async () => {
    const { pc } = await labo();
    expect(await pc.executeCommand('ntpq -c "rv 4242" 192.168.1.1'))
      .toContain('unknown association identifier');
  });

  it('un opcode que cette machine ne sert pas est refuse, bit E et code', async () => {
    // `monlist` n'a jamais ete un opcode standard, et les opcodes
    // d'ECRITURE sont refuses par conception.
    const { pc, rtr } = await labo();
    const agent = pc.getNtpAgent();
    for (const opcode of [3, 5, 8, 10]) {
      const rep = agent.controlQuery('192.168.1.1', opcode);
      expect(rep, String(opcode)).not.toBeNull();
      expect(rep!.error, String(opcode)).toBe(true);
      expect((rep!.status >> 8) & 0xff, String(opcode)).toBe(3);
    }
    expect(rtr.getNtpAgent().getCounters().receivedControl).toBeGreaterThan(0);
  });

  it('une machine sans repondeur de mode 6 ne repond pas', async () => {
    // C'est le cas de chronyd, qui n'implemente pas le mode 6 : ce n'est
    // pas un manque de ce simulateur mais le comportement du vrai
    // logiciel.
    const a = new LinuxPC(`X${++serie}`);
    const b = new LinuxPC(`Y${serie}`);
    new Cable(`z${serie}`).connect(a.getPort('eth0')!, b.getPort('eth0')!);
    await a.executeCommand('ip addr add 172.16.0.1/24 dev eth0');
    await b.executeCommand('ip addr add 172.16.0.2/24 dev eth0');
    expect(await a.executeCommand('ntpq -p 172.16.0.2'))
      .toContain('Connection refused');
  });
});

describe('les deux commandes de durcissement agissent enfin', () => {
  it('`no ntp allow mode control` FERME la porte, en silence', async () => {
    // Le refus est silencieux comme celui d'une liste d'acces : une
    // machine qui repondrait « je ne reponds pas » confirmerait son
    // existence a qui la sonde.
    const { pc, rtr } = await labo(['no ntp allow mode control']);
    expect(await pc.executeCommand('ntpq -p 192.168.1.1'))
      .toContain('Connection refused');
    const c = rtr.getNtpAgent().getCounters();
    expect(c.receivedControl).toBeGreaterThan(0);
    expect(c.controlDenied).toBeGreaterThan(0);
  });

  it('elle est rendue par la configuration, donc survit a un rechargement', async () => {
    const { rtr } = await labo(['no ntp allow mode control']);
    expect(await rtr.executeCommand('show running-config'))
      .toContain('no ntp allow mode control');
  });

  it('`query-only` AUTORISE la requete de controle et REFUSE le temps', async () => {
    // C'est tout l'objet du mot, et il etait inobservable.
    const { pc, rtr } = await labo([
      'access-list 20 permit 192.168.1.0 0.0.0.255',
      'ntp access-group query-only 20',
    ]);
    expect(await pc.executeCommand('ntpq -p 192.168.1.1')).toContain('10.0.0.1');
    // Le meme poste ne peut PAS obtenir l'heure.
    const avant = rtr.getNtpAgent().getCounters().accessDenied;
    pc.getNtpAgent().addServer('192.168.1.1');
    expect(rtr.getNtpAgent().getCounters().accessDenied).toBeGreaterThan(avant);
  });

  it('`serve-only` REFUSE la requete de controle et SERT le temps', async () => {
    // La symetrie exacte du cas precedent : sans elle, `query-only`
    // pourrait « marcher » parce que tout marche.
    // Le routeur est `ntp master` ici : sans cela il ne SERT pas le
    // temps du tout, et le cas passerait pour la mauvaise raison.
    const { pc, rtr } = await labo([
      'ntp master 3',
      'access-list 21 permit 192.168.1.0 0.0.0.255',
      'ntp access-group serve-only 21',
    ]);
    expect(await pc.executeCommand('ntpq -p 192.168.1.1'))
      .toContain('Connection refused');
    pc.getNtpAgent().addServer('192.168.1.1');
    expect(pc.getNtpAgent().getConfig().associations.get('192.168.1.1')!.reach)
      .toBeGreaterThan(0);
    expect(rtr.getNtpAgent().getCounters().sentByMode.server).toBeGreaterThan(0);
  });

  it('une source qu\'aucun groupe ne reconnait est refusee des deux cotes', async () => {
    const { pc } = await labo([
      'access-list 22 permit 10.9.9.0 0.0.0.255',
      'ntp access-group peer 22',
    ]);
    expect(await pc.executeCommand('ntpq -p 192.168.1.1'))
      .toContain('Connection refused');
  });
});

describe('la machine dit ce qu\'elle porte', () => {
  it('`dpkg -l` nomme les paquets dont cette image execute les binaires', async () => {
    // Le defaut inverse de celui du lot N3 : la table niait des logiciels
    // que la machine exécute.
    const pc = new LinuxPC(`D${++serie}`);
    const out = await pc.executeCommand('dpkg -l');
    expect(out).toContain('chrony');
    expect(out).toContain('ntpsec');
  });

  it('`which ntpq` le trouve sur le disque', async () => {
    const pc = new LinuxPC(`D${++serie}`);
    expect(await pc.executeCommand('which ntpq')).toContain('/usr/bin/ntpq');
  });

  it('supprimer le binaire fait echouer la commande, pas le simulateur', async () => {
    const pc = new LinuxPC(`D${++serie}`);
    await pc.executeCommand('sudo rm /usr/bin/ntpq');
    expect(await pc.executeCommand('ntpq -p 10.0.0.1'))
      .toContain('No such file or directory');
  });
});
