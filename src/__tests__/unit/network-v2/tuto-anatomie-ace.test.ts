/**
 * L'ANATOMIE D'UNE ACE — la sonde du tutoriel, ecrite A L'AVEUGLE.
 *
 * Chaque cas vient d'une ligne du tutoriel et de rien d'autre : ni le
 * moteur ni l'analyseur n'ont ete lus avant de l'ecrire. C'est ce qui
 * en fait une mesure — une sonde ecrite apres lecture du code herite de
 * ses angles morts et ne trouve que ce qu'il sait deja faire.
 *
 * Le squelette de reference, six emplacements dont trois obligatoires :
 *
 *   30 permit  tcp   192.168.10.0 0.0.0.255   host 192.168.30.10   eq 80   log
 *    │   │      │    └──────── source ──────┘ └─── destination ──┘  │       │
 *    │   │      └─ protocole                                        │       └─ option
 *    │   └─ action                                                  └─ port
 *    └─ numero de sequence
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
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

type Machine = { executeCommand(c: string): Promise<string> };

const REFUS = /Invalid input|Incomplete command|Unrecognized|Unknown command|Invalid/;

let serie = 0;

async function routeur(...config: string[]): Promise<CiscoRouter> {
  const r = new CiscoRouter(`R${serie++}`, 0, 0);
  r.powerOn();
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const l of config) await r.executeCommand(l);
  await r.executeCommand('end');
  return r;
}

/** Ce que la machine repond a une ligne tapee en configuration. */
async function enConfig(d: Machine, ...lignes: string[]): Promise<string> {
  await d.executeCommand('configure terminal');
  let derniere = '';
  for (const l of lignes) derniere = String(await d.executeCommand(l));
  await d.executeCommand('end');
  return derniere;
}

const refuse = (sortie: string): boolean => REFUS.test(sortie);

// ─── 0. Le squelette complet du tutoriel ──────────────────────────

describe('le squelette complet du tutoriel est accepte et relu', () => {
  it('`30 permit tcp <reseau> <masque> host <ip> eq 80 log` s ecrit', async () => {
    const r = await routeur('ip access-list extended ANATOMIE');
    const sortie = await enConfig(r, 'ip access-list extended ANATOMIE',
      '30 permit tcp 192.168.10.0 0.0.0.255 host 192.168.30.10 eq 80 log');
    expect(refuse(sortie), sortie).toBe(false);

    const vue = await r.executeCommand('show access-lists');
    expect(vue).toContain('30 permit tcp 192.168.10.0 0.0.0.255 host 192.168.30.10 eq 80 log');
  });

  it('le NUMERO DE SEQUENCE ecrit est celui qui est rendu', async () => {
    const r = await routeur('ip access-list extended SEQ');
    await enConfig(r, 'ip access-list extended SEQ',
      '30 permit ip any any', '10 deny ip host 10.0.0.9 any');
    const vue = await r.executeCommand('show access-lists SEQ');
    const rangs = [...vue.matchAll(/^\s*(\d+)\s+(?:permit|deny)/gm)].map(m => Number(m[1]));
    expect(rangs).toEqual([10, 30]);
  });
});

// ─── 1. L'action : trois valeurs, pas deux ────────────────────────

describe('1. l action a TROIS valeurs', () => {
  it('`permit` laisse passer, et l evaluation s arrete la', async () => {
    const r = await routeur('ip access-list extended A1',
      'permit ip any any', 'deny ip any any');
    const vue = await r.executeCommand('show access-lists A1');
    expect(vue).toContain('permit ip any any');
    expect(vue).toContain('deny ip any any');
  });

  it('`deny` jette, et l evaluation s arrete la', async () => {
    const r = await routeur('access-list 100 deny ip any any',
      'access-list 100 permit ip any any');
    const vue = await r.executeCommand('show access-lists 100');
    expect(vue).toContain('deny ip any any');
  });

  it('`remark <texte>` est une LIGNE de la liste, visible en configuration', async () => {
    const r = await routeur('access-list 10 remark Poste de direction',
      'access-list 10 permit 192.168.10.0 0.0.0.255');
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('access-list 10 remark Poste de direction');
  });

  it('`remark` existe aussi dans une liste NOMMEE', async () => {
    const r = await routeur('ip access-list standard NOMMEE');
    const sortie = await enConfig(r, 'ip access-list standard NOMMEE',
      'remark Le commentaire de la liste', 'permit any');
    expect(refuse(sortie), sortie).toBe(false);
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('remark Le commentaire de la liste');
  });

  it('`remark` ne filtre RIEN : aucun paquet ne lui est compare', async () => {
    const r = await routeur('access-list 10 remark tout est bloque',
      'access-list 10 deny any');
    const vue = await r.executeCommand('show access-lists 10');
    // La remarque n'a pas de compteur de correspondances : elle n'est
    // jamais comparee. Seule la regle `deny` en porte un.
    const lignesRemark = vue.split('\n').filter(l => l.includes('remark'));
    for (const l of lignesRemark) expect(l).not.toMatch(/\d+\s+match(es)?/);
  });
});

// ─── 2. Les deux familles ─────────────────────────────────────────

describe('2. le routeur DEDUIT la famille du type de la liste', () => {
  it('une liste STANDARD accepte la forme courte', async () => {
    const r = await routeur();
    expect(refuse(await enConfig(r, 'access-list 10 permit 192.168.10.0 0.0.0.255')))
      .toBe(false);
  });

  it('une liste STANDARD REFUSE la forme longue', async () => {
    const r = await routeur();
    const sortie = await enConfig(r, 'access-list 10 permit tcp 192.168.10.0 0.0.0.255 any');
    expect(refuse(sortie), sortie).toBe(true);
  });

  it('une liste ETENDUE accepte la forme longue', async () => {
    const r = await routeur();
    expect(refuse(await enConfig(r,
      'access-list 100 permit tcp 192.168.10.0 0.0.0.255 host 192.168.30.10')))
      .toBe(false);
  });

  it('une liste ETENDUE REFUSE la forme courte', async () => {
    const r = await routeur();
    const sortie = await enConfig(r, 'access-list 100 permit 192.168.10.0 0.0.0.255');
    expect(refuse(sortie), sortie).toBe(true);
  });

  it('la liste NOMMEE standard refuse la forme longue elle aussi', async () => {
    const r = await routeur('ip access-list standard STD');
    const sortie = await enConfig(r, 'ip access-list standard STD',
      'permit tcp any any eq 80');
    expect(refuse(sortie), sortie).toBe(true);
  });
});

// ─── 3. Les quatre formes d'ecriture d'une adresse ────────────────

describe('3. les quatre formes d une adresse', () => {
  it('`host <ip>` equivaut a `<ip> 0.0.0.0`', async () => {
    const r = await routeur('access-list 100 permit ip host 192.168.30.10 any',
      'access-list 101 permit ip 192.168.30.10 0.0.0.0 any');
    const vue = await r.executeCommand('show access-lists');
    // IOS rend les deux sous la forme canonique `host`.
    const cent = vue.split('\n').filter(l => l.includes('permit ip host 192.168.30.10'));
    expect(cent.length).toBe(2);
  });

  it('`<reseau> <masque generique>` designe tout un reseau', async () => {
    const r = await routeur('access-list 10 permit 192.168.10.0 0.0.0.255');
    expect(await r.executeCommand('show access-lists 10'))
      .toContain('permit 192.168.10.0, wildcard bits 0.0.0.255');
    expect(await r.executeCommand('show running-config'))
      .toContain('access-list 10 permit 192.168.10.0 0.0.0.255');
  });

  it('`any` equivaut a `0.0.0.0 255.255.255.255`', async () => {
    const r = await routeur('access-list 100 permit ip any any',
      'access-list 101 permit ip 0.0.0.0 255.255.255.255 any');
    const vue = await r.executeCommand('show access-lists');
    expect(vue.split('\n').filter(l => /permit ip any any/.test(l)).length).toBe(2);
  });

  it('`object-group <nom>` designe un groupe nomme d adresses', async () => {
    const r = await routeur(
      'object-group network SERVEURS-WEB',
      'host 192.168.30.10',
      'host 192.168.30.11',
      'exit',
      'ip access-list extended AVEC-GROUPE',
      'permit tcp any object-group SERVEURS-WEB eq 80',
      'exit',
    );
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toContain('object-group network SERVEURS-WEB');
    expect(cfg).toContain('permit tcp any object-group SERVEURS-WEB eq 80');
  });

  it('`show object-group` relit le groupe declare', async () => {
    const r = await routeur(
      'object-group network SERVEURS-WEB', 'host 192.168.30.10', 'exit');
    const vue = await r.executeCommand('show object-group');
    expect(refuse(vue), vue).toBe(false);
    expect(vue).toContain('SERVEURS-WEB');
  });
});

// ─── 4. Les formes d'ecriture d'un port ───────────────────────────

const OPERATEURS_DE_PORT: ReadonlyArray<readonly [string, string]> = [
  ['eq 80', 'eq'],
  ['neq 22', 'neq'],
  ['lt 1024', 'lt'],
  ['gt 1023', 'gt'],
  ['range 20 21', 'range'],
];

describe('4. les cinq operateurs de port', () => {
  it.each(OPERATEURS_DE_PORT)('`%s` est accepte en TCP', async (forme) => {
    const r = await routeur();
    const sortie = await enConfig(r, `access-list 100 permit tcp any any ${forme}`);
    expect(refuse(sortie), sortie).toBe(false);
    expect(await r.executeCommand('show access-lists 100')).toContain(forme);
  });

  it.each(OPERATEURS_DE_PORT)('`%s` est accepte en UDP', async (forme) => {
    const r = await routeur();
    const sortie = await enConfig(r, `access-list 100 permit udp any any ${forme}`);
    expect(refuse(sortie), sortie).toBe(false);
  });

  it('une ACE SANS port couvre tous les ports', async () => {
    const r = await routeur('access-list 100 permit tcp any any');
    const vue = await r.executeCommand('show access-lists 100');
    expect(vue).toContain('permit tcp any any');
    expect(vue).not.toMatch(/\beq\b|\bneq\b|\blt\b|\bgt\b|\brange\b/);
  });

  it.each(['ip', 'icmp', 'gre', 'ospf'])(
    'un port n existe pas en `%s` — la forme est REFUSEE', async (proto) => {
      const r = await routeur();
      const sortie = await enConfig(r, `access-list 100 permit ${proto} any any eq 80`);
      expect(refuse(sortie), `${proto}: ${sortie}`).toBe(true);
    });

  it('LA POSITION COMPTE : le port suit l adresse a laquelle il se rattache', async () => {
    const r = await routeur(
      'ip access-list extended POSITION',
      'permit tcp any eq 179 host 10.0.0.1',
      'permit tcp any host 10.0.0.1 eq 179',
      'exit');
    const vue = await r.executeCommand('show access-lists POSITION');
    // Deux lignes DIFFERENTES : port source puis port destination.
    expect(vue).toContain('permit tcp any eq 179 host 10.0.0.1');
    expect(vue).toContain('permit tcp any host 10.0.0.1 eq 179');
  });

  it('les deux positions ne filtrent PAS la meme chose', async () => {
    const r = await routeur(
      'ip access-list extended SRC', 'permit tcp any eq 179 host 10.0.0.1', 'exit',
      'ip access-list extended DST', 'permit tcp any host 10.0.0.1 eq 179', 'exit');
    const src = await r.executeCommand('show access-lists SRC');
    const dst = await r.executeCommand('show access-lists DST');
    expect(src.replace(/^.*Extended.*$/m, '')).not.toBe(dst.replace(/^.*Extended.*$/m, ''));
  });

  it('un nom de service vaut un numero (`eq www` = `eq 80`)', async () => {
    const r = await routeur('access-list 100 permit tcp any any eq www');
    const vue = await r.executeCommand('show access-lists 100');
    expect(vue).toMatch(/eq (www|80)/);
  });
});

// ─── 5. Les formes d'ecriture du protocole ────────────────────────

const PROTOCOLES = [
  'ip', 'tcp', 'udp', 'icmp', 'gre', 'esp', 'ahp', 'ospf', 'eigrp', 'pim',
] as const;

describe('5. les mots-cles de protocole', () => {
  it.each(PROTOCOLES)('`permit %s any any` est accepte', async (proto) => {
    const r = await routeur();
    const sortie = await enConfig(r, `access-list 100 permit ${proto} any any`);
    expect(refuse(sortie), `${proto}: ${sortie}`).toBe(false);
    expect(await r.executeCommand('show access-lists 100')).toContain(`permit ${proto} any any`);
  });

  it.each(['0', '47', '89', '255'])(
    'le NUMERO de protocole brut `%s` est accepte', async (num) => {
      const r = await routeur();
      const sortie = await enConfig(r, `access-list 100 permit ${num} any any`);
      expect(refuse(sortie), `${num}: ${sortie}`).toBe(false);
    });

  it('un numero de protocole hors bornes est REFUSE', async () => {
    const r = await routeur();
    const sortie = await enConfig(r, 'access-list 100 permit 256 any any');
    expect(refuse(sortie), sortie).toBe(true);
  });

  it('un mot-cle de protocole inexistant est REFUSE', async () => {
    const r = await routeur();
    const sortie = await enConfig(r, 'access-list 100 permit zorglub any any');
    expect(refuse(sortie), sortie).toBe(true);
  });
});

// ─── 6. Le cas particulier d'ICMP ─────────────────────────────────

const MOTS_ICMP = ['echo', 'echo-reply', 'unreachable', 'time-exceeded'] as const;

describe('6. ICMP a des TYPES et des CODES, pas des ports', () => {
  it('`permit icmp any any` couvre tout l ICMP', async () => {
    const r = await routeur('access-list 100 permit icmp any any');
    expect(await r.executeCommand('show access-lists 100'))
      .toContain('permit icmp any any');
  });

  it.each(MOTS_ICMP)('`permit icmp any any %s` est accepte et relu', async (mot) => {
    const r = await routeur();
    const sortie = await enConfig(r, `access-list 100 permit icmp any any ${mot}`);
    expect(refuse(sortie), `${mot}: ${sortie}`).toBe(false);
    expect(await r.executeCommand('show access-lists 100')).toContain(mot);
  });

  it('`permit icmp any any 8 0` ecrit le meme filtre en type/code numeriques', async () => {
    const r = await routeur();
    const sortie = await enConfig(r, 'access-list 100 permit icmp any any 8 0');
    expect(refuse(sortie), sortie).toBe(false);
  });

  it('un mot-cle ICMP inexistant est REFUSE', async () => {
    const r = await routeur();
    const sortie = await enConfig(r, 'access-list 100 permit icmp any any zorglub');
    expect(refuse(sortie), sortie).toBe(true);
  });
});

// ─── 7. Les qualificatifs de fin, qui se CUMULENT ─────────────────

const QUALIFICATIFS: ReadonlyArray<readonly [string, string]> = [
  ['log', 'permit ip any any log'],
  ['log-input', 'permit ip any any log-input'],
  ['established', 'permit tcp any any established'],
  ['fragments', 'permit ip any any fragments'],
  ['time-range', 'permit ip any any time-range OUVERTURE'],
  ['reflect', 'permit tcp any any reflect RETOUR'],
  ['dscp', 'permit ip any any dscp ef'],
  ['precedence', 'permit ip any any precedence critical'],
  ['tos', 'permit ip any any tos 8'],
  ['ttl', 'permit ip any any ttl eq 255'],
];

describe('7. les qualificatifs de fin', () => {
  it.each(QUALIFICATIFS)('`%s` est accepte', async (_nom, ligne) => {
    const r = await routeur('time-range OUVERTURE', 'exit',
      'ip access-list extended QUALIF');
    const sortie = await enConfig(r, 'ip access-list extended QUALIF', ligne);
    expect(refuse(sortie), `${ligne}: ${sortie}`).toBe(false);
  });

  it.each(QUALIFICATIFS)('`%s` est RENDU dans la vue', async (nom, ligne) => {
    const r = await routeur('time-range OUVERTURE', 'exit',
      'ip access-list extended QUALIF');
    await enConfig(r, 'ip access-list extended QUALIF', ligne);
    const vue = await r.executeCommand('show access-lists QUALIF');
    expect(vue, `${ligne} -> ${vue}`).toContain(nom);
  });

  it('les qualificatifs se CUMULENT sur une meme ACE', async () => {
    const r = await routeur('time-range OUVERTURE', 'exit',
      'ip access-list extended CUMUL');
    const sortie = await enConfig(r, 'ip access-list extended CUMUL',
      'permit tcp any any established log time-range OUVERTURE');
    expect(refuse(sortie), sortie).toBe(false);
    const vue = await r.executeCommand('show access-lists CUMUL');
    expect(vue).toContain('established');
    expect(vue).toContain('log');
    expect(vue).toContain('time-range OUVERTURE');
  });

  it.each(['eq', 'neq', 'lt', 'gt'])(
    '`ttl %s <valeur>` est accepte', async (op) => {
      const r = await routeur();
      const sortie = await enConfig(r, `access-list 100 permit ip any any ttl ${op} 64`);
      expect(refuse(sortie), `ttl ${op}: ${sortie}`).toBe(false);
    });

  it('`ttl range <debut> <fin>` est accepte', async () => {
    const r = await routeur();
    const sortie = await enConfig(r, 'access-list 100 permit ip any any ttl range 1 64');
    expect(refuse(sortie), sortie).toBe(false);
  });

  it('un qualificatif inexistant est REFUSE, et rien n est enregistre', async () => {
    const r = await routeur();
    const sortie = await enConfig(r, 'access-list 100 permit tcp any any eq 80 estalbished');
    expect(refuse(sortie), sortie).toBe(true);
    expect(await r.executeCommand('show access-lists 100')).not.toContain('permit tcp');
  });
});

// ─── Le comportement, sur un vrai chemin de donnees ───────────────

/** R1 entre deux hotes : 192.168.10.10 ─ R1 ─ 192.168.30.10 */
async function laboratoire(): Promise<{
  r: CiscoRouter; gauche: LinuxPC; droite: LinuxPC; portGauche: string;
}> {
  const r = new CiscoRouter(`RL${serie++}`, 0, 0);
  const gauche = new LinuxPC('linux-pc', `G${serie}`, 0, 0);
  const droite = new LinuxPC('linux-pc', `D${serie}`, 0, 0);
  r.powerOn(); gauche.powerOn(); droite.powerOn();

  const ports = r.getPortNames();
  new Cable('cg').connect(r.getPorts()[0], gauche.getPort('eth0')!);
  new Cable('cd').connect(r.getPorts()[1], droite.getPort('eth0')!);

  gauche.configureInterface('eth0', new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));
  droite.configureInterface('eth0', new IPAddress('192.168.30.10'), new SubnetMask('255.255.255.0'));
  gauche.setDefaultGateway(new IPAddress('192.168.10.1'));
  droite.setDefaultGateway(new IPAddress('192.168.30.1'));

  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const l of [
    `interface ${ports[0]}`, 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    `interface ${ports[1]}`, 'ip address 192.168.30.1 255.255.255.0', 'no shutdown', 'exit',
  ]) await r.executeCommand(l);
  await r.executeCommand('end');

  return { r, gauche, droite, portGauche: ports[0] };
}

const perteTotale = (sortie: string): boolean => /100% packet loss/.test(sortie);

describe('le comportement sur un vrai chemin de donnees', () => {
  it('sans ACL, le ping traverse', async () => {
    const { gauche } = await laboratoire();
    const out = String(await gauche.executeCommand('ping -c 2 -W 1 192.168.30.10'));
    expect(perteTotale(out), out).toBe(false);
  });

  it('`deny` arrete le paquet, et l evaluation s arrete la', async () => {
    const lab = await laboratoire();
    await lab.r.executeCommand('configure terminal');
    for (const l of [
      'ip access-list extended BLOQUE', 'deny icmp any any', 'permit ip any any', 'exit',
      `interface ${lab.portGauche}`, 'ip access-group BLOQUE in', 'exit',
    ]) await lab.r.executeCommand(l);
    await lab.r.executeCommand('end');

    const out = String(await lab.gauche.executeCommand('ping -c 2 -W 1 192.168.30.10'));
    expect(perteTotale(out), out).toBe(true);
  });

  it('`permit` laisse passer meme si un `deny` suit', async () => {
    const lab = await laboratoire();
    await lab.r.executeCommand('configure terminal');
    for (const l of [
      'ip access-list extended PASSE', 'permit icmp any any', 'deny ip any any', 'exit',
      `interface ${lab.portGauche}`, 'ip access-group PASSE in', 'exit',
    ]) await lab.r.executeCommand(l);
    await lab.r.executeCommand('end');

    const out = String(await lab.gauche.executeCommand('ping -c 2 -W 1 192.168.30.10'));
    expect(perteTotale(out), out).toBe(false);
  });

  it('une `remark` ne bloque rien, meme placee en tete', async () => {
    const lab = await laboratoire();
    await lab.r.executeCommand('configure terminal');
    for (const l of [
      'ip access-list extended AVECREMARQUE',
      'remark cette ligne ne filtre rien',
      'permit ip any any', 'exit',
      `interface ${lab.portGauche}`, 'ip access-group AVECREMARQUE in', 'exit',
    ]) await lab.r.executeCommand(l);
    await lab.r.executeCommand('end');

    const out = String(await lab.gauche.executeCommand('ping -c 2 -W 1 192.168.30.10'));
    expect(perteTotale(out), out).toBe(false);
  });

  it('`permit icmp any any echo` laisse passer la DEMANDE de ping', async () => {
    const lab = await laboratoire();
    await lab.r.executeCommand('configure terminal');
    for (const l of [
      'ip access-list extended ECHO',
      'permit icmp any any echo', 'permit icmp any any echo-reply',
      'deny ip any any', 'exit',
      `interface ${lab.portGauche}`, 'ip access-group ECHO in', 'exit',
    ]) await lab.r.executeCommand(l);
    await lab.r.executeCommand('end');

    const out = String(await lab.gauche.executeCommand('ping -c 2 -W 1 192.168.30.10'));
    expect(perteTotale(out), out).toBe(false);
  });

  it('`permit icmp any any echo-reply` SEUL ne laisse pas partir la demande', async () => {
    const lab = await laboratoire();
    await lab.r.executeCommand('configure terminal');
    for (const l of [
      'ip access-list extended REPLYSEUL',
      'permit icmp any any echo-reply', 'deny ip any any', 'exit',
      `interface ${lab.portGauche}`, 'ip access-group REPLYSEUL in', 'exit',
    ]) await lab.r.executeCommand(l);
    await lab.r.executeCommand('end');

    const out = String(await lab.gauche.executeCommand('ping -c 2 -W 1 192.168.30.10'));
    expect(perteTotale(out), out).toBe(true);
  });

  it('le compteur de correspondances augmente quand une ACE matche', async () => {
    const lab = await laboratoire();
    await lab.r.executeCommand('configure terminal');
    for (const l of [
      'ip access-list extended COMPTE', 'permit ip any any', 'exit',
      `interface ${lab.portGauche}`, 'ip access-group COMPTE in', 'exit',
    ]) await lab.r.executeCommand(l);
    await lab.r.executeCommand('end');

    await lab.gauche.executeCommand('ping -c 2 -W 1 192.168.30.10');
    const vue = await lab.r.executeCommand('show access-lists COMPTE');
    expect(vue).toMatch(/\(\d+ match(es)?\)/);
  });

  it('`object-group` filtre pour de bon', async () => {
    const lab = await laboratoire();
    await lab.r.executeCommand('configure terminal');
    for (const l of [
      'object-group network CIBLES', 'host 192.168.30.10', 'exit',
      'ip access-list extended PARGROUPE',
      'deny icmp any object-group CIBLES', 'permit ip any any', 'exit',
      `interface ${lab.portGauche}`, 'ip access-group PARGROUPE in', 'exit',
    ]) await lab.r.executeCommand(l);
    await lab.r.executeCommand('end');

    const out = String(await lab.gauche.executeCommand('ping -c 2 -W 1 192.168.30.10'));
    expect(perteTotale(out), out).toBe(true);
  });

  it('`ttl` filtre pour de bon', async () => {
    const lab = await laboratoire();
    await lab.r.executeCommand('configure terminal');
    for (const l of [
      'ip access-list extended PARTTL',
      'deny icmp any any ttl lt 255', 'permit ip any any', 'exit',
      `interface ${lab.portGauche}`, 'ip access-group PARTTL in', 'exit',
    ]) await lab.r.executeCommand(l);
    await lab.r.executeCommand('end');

    const out = String(await lab.gauche.executeCommand('ping -c 2 -W 1 192.168.30.10'));
    expect(perteTotale(out), out).toBe(true);
  });
});
