/**
 * La fidelite du dialogue : ou tombe le curseur, ce que la machine
 * refuse, et dans quel ORDRE elle rend sa configuration.
 *
 * Ces six points (audit §5, F1 a F8) ne changent aucun droit — ils
 * changent ce que l'operateur LIT. C'est precisement ce qui les rend
 * couteux : un curseur pose sous le mauvais mot envoie corriger un mot
 * juste, une commande inexistante acceptee en silence produit une regle
 * qui n'autorisera jamais rien, et une ligne d'en-tete rendue au milieu
 * des interfaces fait d'un fichier de configuration un fichier qu'IOS
 * n'a jamais pu produire.
 *
 * F1 — `privilege badmode level 5 show` : le mot fautif est `badmode`,
 * le curseur se posait ailleurs. IOS pointe le PREMIER mot qu'il n'a pas
 * su lire, et c'est ce mot que l'operateur doit corriger.
 *
 * F2 — `privilege exec badkeyword 5 show` repondait `% Incomplete
 * command.`, c'est-a-dire « il en manque » pour une ligne a qui il ne
 * manque rien : elle porte un mot de trop, mal ecrit. Les deux
 * diagnostics d'IOS ne sont pas interchangeables — l'un dit « continue »,
 * l'autre « efface ».
 *
 * F3 — `! Last configuration change at ...` est une ligne d'EN-TETE ;
 * elle sortait apres les interfaces parce qu'elle traversait le tri des
 * blocs, ou elle tombait au rang des non-classees. Ce n'est pas de
 * l'affichage : cette configuration est rejouee a l'import d'une
 * topologie, et aucun IOS n'ecrit sa provenance au milieu du fichier.
 *
 * F5 — `show parser view all` : l'en-tete d'IOS est `Views/SuperViews
 * Present in System:`, une vue par ligne, une SUPERVUE marquee `*`, et
 * une legende qui dit ce que l'etoile veut dire. Sans l'etoile ni la
 * legende, la seule information que cette vue apporte par rapport a la
 * configuration — laquelle est une supervue — est perdue.
 *
 * F7 — `privilege exec level 5 shwo verison` etait ACCEPTE. La regle
 * naissait pour une commande qui n'existe pas, elle paraissait dans la
 * configuration, et elle n'accordait rien : exactement la faute de
 * frappe silencieuse que `commands exec include` refuse deja depuis
 * l'etape des vues.
 *
 * F8 — creer une vue exige la vue RACINE, que Cisco definit comme les
 * privileges du niveau 15. Une session au-dessous ne doit pas pouvoir
 * declarer un role, sans quoi le mecanisme d'autorisation se
 * reconfigure depuis l'interieur de ce qu'il restreint.
 *
 * F6 — non-regression mesuree : le niveau 0 d'IOS (disable, enable,
 * exit, help, logout) est deja juste et doit le rester.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { formatInvalidInput } from '@/network/devices/shells/CommandTrie';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Machine = CiscoRouter | CiscoSwitch;

async function jouer(m: Machine, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await m.executeCommand(c);
  return derniere;
}

function routeur(): CiscoRouter {
  return new CiscoRouter('R1', MACAddress.generate());
}

/**
 * La colonne du curseur DANS LA LIGNE TAPEE, ou -1 s'il n'y en a pas.
 *
 * IOS aligne le `^` sous la ligne telle qu'elle est affichee, invite
 * comprise ; c'est la largeur de l'invite qu'on retire ici pour
 * exprimer la position en mots de la commande.
 */
function colonneDuCurseur(sortie: string): number {
  const premiere = sortie.split('\n')[0];
  if (!premiere.includes('^')) return -1;
  // La largeur d'invite en vigueur, lue au meme endroit que le rendu
  // la lit : la deduire du nom de la machine se tromperait des qu'une
  // plateforme ne la declare pas.
  const invite = formatInvalidInput(0).indexOf('^');
  return premiere.indexOf('^') - invite;
}

const PLATEFORMES: Array<[string, () => Machine]> = [
  ['routeur', () => new CiscoRouter('R1', MACAddress.generate())],
  ['commutateur', () => new CiscoSwitch('SW1', MACAddress.generate())],
];

describe.each(PLATEFORMES)('F1/F2 — le curseur pointe le mot fautif — %s', (_n, fabrique) => {
  it('F1 : un MODE inconnu est pointe, pas le mot qui le suit', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    const out = await m.executeCommand('privilege badmode level 5 show');
    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(colonneDuCurseur(out)).toBe('privilege '.length);
  });

  it('F2 : un mot-cle inconnu a la place de `level` est INVALIDE, pas incomplet', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    const out = await m.executeCommand('privilege exec badkeyword 5 show');
    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(out).not.toContain('Incomplete');
    expect(colonneDuCurseur(out)).toBe('privilege exec '.length);
  });

  it('un niveau hors de 0-15 est pointe sur le NOMBRE', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    const out = await m.executeCommand('privilege exec level 42 show');
    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(colonneDuCurseur(out)).toBe('privilege exec level '.length);
  });

  it('une ligne a qui il manque vraiment un mot reste `% Incomplete command.`', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    expect(await m.executeCommand('privilege exec level 5')).toBe('% Incomplete command.');
    expect(await m.executeCommand('privilege exec level')).toBe('% Incomplete command.');
    expect(await m.executeCommand('privilege exec')).toBe('% Incomplete command.');
  });

  it('non-regression : la forme correcte est toujours acceptee', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    expect(await m.executeCommand('privilege exec level 5 show version')).toBe('');
    expect(await m.executeCommand('privilege exec all level 5 show ip')).toBe('');
    expect(await m.executeCommand('privilege exec reset show version')).toBe('');
  });
});

describe.each(PLATEFORMES)('F7 — une regle ne nait pas pour une commande inexistante — %s', (_n, fabrique) => {
  it('une faute de frappe est refusee, pointee sur le mot', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    const out = await m.executeCommand('privilege exec level 5 shwo verison');
    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(colonneDuCurseur(out)).toBe('privilege exec level 5 '.length);
  });

  it('et la regle refusee ne parait pas dans la configuration', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    await m.executeCommand('privilege exec level 5 shwo verison');
    await m.executeCommand('end');
    expect(await m.executeCommand('show running-config')).not.toContain('shwo');
  });

  it('une commande connue d un AUTRE mode est refusee dans celui-ci', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    // `ip address` est une commande d'interface, pas une commande EXEC.
    expect(await m.executeCommand('privilege exec level 5 ip address'))
      .toContain("% Invalid input detected at '^' marker.");
    // Et elle est acceptee dans le mode qui la connait.
    expect(await m.executeCommand('privilege interface level 5 ip address')).toBe('');
  });

  it('`reset` refuse aussi une commande inexistante', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    expect(await m.executeCommand('privilege exec reset shwo verison'))
      .toContain("% Invalid input detected at '^' marker.");
  });

  it('non-regression : une commande abregee reste acceptee', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    expect(await m.executeCommand('privilege exec level 5 sh ver')).toBe('');
  });
});

describe('F3 — la provenance est un EN-TETE', () => {
  it('`! Last configuration change` sort avant toute commande', async () => {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'exit',
      'end',
    ]);
    const cfg = await r.executeCommand('show running-config');
    const lignes = cfg.split('\n');
    const provenance = lignes.findIndex((l) => l.startsWith('! Last configuration change'));
    expect(provenance).toBeGreaterThan(-1);
    const premiereCommande = lignes.findIndex((l) => /^[a-z]/.test(l));
    expect(provenance).toBeLessThan(premiereCommande);
  });

  it('elle vient juste apres le premier separateur', async () => {
    const r = routeur();
    await jouer(r, ['enable', 'configure terminal', 'hostname CORE', 'end']);
    const lignes = (await r.executeCommand('show running-config')).split('\n');
    expect(lignes[3]).toBe('!');
    expect(lignes[4]).toMatch(/^! Last configuration change at /);
  });

  it('la taille annoncee reste celle du corps rendu', async () => {
    const r = routeur();
    await jouer(r, ['enable', 'configure terminal', 'hostname CORE', 'end']);
    const cfg = await r.executeCommand('show running-config');
    const lignes = cfg.split('\n');
    const annonce = /Current configuration : (\d+) bytes/.exec(lignes[2]);
    expect(annonce).not.toBeNull();
    const corps = lignes.slice(4).join('\n');
    expect(Number(annonce![1])).toBe(new TextEncoder().encode(corps).length + 1);
  });
});

describe('F5 — `show parser view all` dit lesquelles sont des supervues', () => {
  async function avecVues(): Promise<CiscoRouter> {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view LECTURE', 'secret Vue@2026',
      'commands exec include show version', 'exit',
      'parser view RESEAU', 'secret Vue@2026',
      'commands exec include show ip route', 'exit',
      'parser view TOUT superview', 'secret Vue@2026',
      'view LECTURE', 'view RESEAU', 'exit',
      'end',
    ]);
    return r;
  }

  it('l en-tete est celui d IOS', async () => {
    const r = await avecVues();
    expect((await r.executeCommand('show parser view all')).split('\n')[0])
      .toBe('Views/SuperViews Present in System:');
  });

  it('une vue par ligne, la supervue marquee d une etoile', async () => {
    const r = await avecVues();
    const lignes = (await r.executeCommand('show parser view all')).split('\n');
    expect(lignes).toContain('LECTURE');
    expect(lignes).toContain('RESEAU');
    expect(lignes).toContain('TOUT *');
  });

  it('la legende explique l etoile', async () => {
    const r = await avecVues();
    const lignes = (await r.executeCommand('show parser view all')).split('\n');
    expect(lignes[lignes.length - 1]).toBe('-------(*) represent superview-------');
  });

  it('sans vue declaree, la reponse ne change pas', async () => {
    const r = routeur();
    expect(await jouer(r, ['enable', 'show parser view all'])).toBe('No views are configured');
  });
});

describe('F8 — declarer une vue exige la vue racine', () => {
  /**
   * Un niveau 5 a qui l'on a DELEGUE `parser view` : sans le controle,
   * la session s'ecrit un role sur mesure, c'est-a-dire qu'elle
   * reconfigure le mecanisme d'autorisation depuis l'interieur de ce
   * qu'il restreint. Sans la delegation, le refus viendrait du filtre
   * de niveau et ne prouverait rien de la vue racine.
   */
  async function niveau5AvecParserView(): Promise<CiscoRouter> {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'enable secret level 5 Cinq@2026',
      'privilege exec level 5 configure',
      'privilege exec level 5 configure terminal',
      'privilege configure level 5 parser view',
      'end', 'disable',
    ]);
    await r.executeCommand('enable 5', { passwordInput: 'Cinq@2026' });
    await r.executeCommand('configure terminal');
    return r;
  }

  it('une session au-dessous du niveau 15 ne peut pas creer de vue', async () => {
    const r = await niveau5AvecParserView();
    const out = await r.executeCommand('parser view PIRATE');
    expect(out).toMatch(/root view/i);
  });

  it('et la vue n existe pas apres le refus', async () => {
    const r = await niveau5AvecParserView();
    await r.executeCommand('parser view PIRATE');
    await r.executeCommand('end');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show parser view all')).toBe('No views are configured');
  });

  it('non-regression : au niveau 15 la declaration fonctionne', async () => {
    const r = routeur();
    expect(await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model', 'parser view NOC',
    ])).toBe('');
  });
});

describe('F6 — non-regression : le niveau 0 d IOS', () => {
  async function auNiveau0(): Promise<CiscoRouter> {
    const r = routeur();
    await jouer(r, [
      'enable', 'configure terminal',
      'enable secret level 0 Zero@2026',
      'end', 'disable',
    ]);
    await r.executeCommand('enable 0', { passwordInput: 'Zero@2026' });
    return r;
  }

  it('les cinq commandes du niveau 0 repondent', async () => {
    const r = await auNiveau0();
    expect(await r.executeCommand('help')).toContain('Help may be requested');
    expect(await r.executeCommand('enable')).not.toContain('Invalid input');
  });

  it('et `show` n en fait pas partie', async () => {
    const r = await auNiveau0();
    await r.executeCommand('disable');
    await r.executeCommand('enable 0', { passwordInput: 'Zero@2026' });
    expect(await r.executeCommand('show version')).toContain('Invalid input');
  });
});

/**
 * `no privilege` est la commande qui RETIRE une delegation, et elle
 * portait encore, intacte, la famille de defauts que F1/F2/F7 viennent
 * de refermer sur la forme positive : un mot-cle mal ecrit rendu
 * `% Incomplete command.` — donc « continue de taper » a qui doit
 * effacer —, un curseur pose ailleurs que sur le mot fautif, une
 * commande inexistante acceptee, et le mot-cle `all` refuse alors que la
 * forme positive l'accepte.
 *
 * Corriger une moitie et pas l'autre, c'est laisser deux reponses
 * possibles a la meme question. Les deux formes lisent desormais UNE
 * analyse.
 */
describe.each(PLATEFORMES)('`no privilege` lit la meme analyse — %s', (_n, fabrique) => {
  it('un MODE inconnu est pointe', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    const out = await m.executeCommand('no privilege badmode level 5 show');
    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(colonneDuCurseur(out)).toBe('no privilege '.length);
  });

  it('un mot-cle inconnu est INVALIDE, pas incomplet', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    const out = await m.executeCommand('no privilege exec badkeyword 5 show');
    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(out).not.toContain('Incomplete');
    expect(colonneDuCurseur(out)).toBe('no privilege exec '.length);
  });

  it('une commande inexistante est refusee', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    expect(await m.executeCommand('no privilege exec level 5 shwo verison'))
      .toContain("% Invalid input detected at '^' marker.");
  });

  it('`all` est accepte, comme sur la forme positive', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    await m.executeCommand('privilege exec all level 5 show ip');
    expect(await m.executeCommand('no privilege exec all level 5 show ip')).toBe('');
  });

  it('et elle retire vraiment la regle', async () => {
    const m = fabrique();
    await jouer(m, [
      'enable', 'configure terminal', 'privilege exec level 5 show version',
    ]);
    await m.executeCommand('end');
    expect(await m.executeCommand('show running-config'))
      .toContain('privilege exec level 5 show version');
    await jouer(m, ['configure terminal', 'no privilege exec level 5 show version', 'end']);
    expect(await m.executeCommand('show running-config'))
      .not.toContain('privilege exec level 5 show version');
  });

  it('une ligne a qui il manque un mot reste `% Incomplete command.`', async () => {
    const m = fabrique();
    await jouer(m, ['enable', 'configure terminal']);
    expect(await m.executeCommand('no privilege exec level')).toBe('% Incomplete command.');
    expect(await m.executeCommand('no privilege exec level 5')).toBe('% Incomplete command.');
  });
});
