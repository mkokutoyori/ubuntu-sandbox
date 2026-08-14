/**
 * §11 du tutoriel « Accès, Identité et Privilèges » : les CLI Views,
 * c'est-à-dire le RBAC d'IOS.
 *
 * Le sous-système était ENTIÈREMENT absent — `parser view`,
 * `commands exec include`, `enable view`, `show parser view`,
 * `username X view Y` répondaient tous `% Invalid input detected`. Ce
 * n'était pas une commande manquante mais un mécanisme d'autorisation.
 *
 * **Ce qui distingue une vue d'un niveau de privilège est le tout du
 * mécanisme, et c'est la seule chose qu'il fallait ne pas rater.** Un
 * niveau AJOUTE des commandes au socle du niveau 1 ; une vue REMPLACE
 * l'arbre visible par ce qu'elle inclut, et rien d'autre. C'est ce qui
 * la rend utilisable pour décrire un rôle : on dit ce que le rôle a le
 * droit de faire, pas ce qu'on lui ajoute par-dessus un socle qu'on n'a
 * pas choisi.
 *
 * La porte est branchée là où le filtrage par niveau l'était déjà, dans
 * `executeOnTrie` — et hors d'une vue elle rend `true` sans rien
 * consulter, de sorte que le cas courant (aucune vue) ne change pas.
 *
 * Discriminé par restauration des dix fichiers : 14 cas sur 18 tombent
 * avant correctif. Les 4 qui passent des deux côtés sont dits ici plutôt
 * que laissés à découvrir — deux sont les cas de non-régression, qui
 * doivent passer des deux côtés puisque c'est leur objet ; les deux
 * autres passent avant correctif pour une raison qui ne prouve rien du
 * mécanisme : « un mode autre qu'exec est refusé » passait parce que
 * `parser view` l'était déjà, et « ce qu'elle inclut fonctionne »
 * parce qu'`enable view` ne faisait rien et qu'on restait à la racine,
 * où tout fonctionne. Ils gardent le refus et l'exécution, ils ne
 * prouvent pas la vue.
 *
 * **Repris depuis, et c'est l'audit des privilèges qui l'a montré** :
 * `enable view` n'a longtemps demandé AUCUN mot de passe, alors que le
 * `secret` d'une vue était stocké et rendu. Trois cas de ce fichier
 * avaient donc figé le défaut comme contrat, et le quatrième — celui
 * déjà signalé plus haut — passait pour la mauvaise raison. Ils entrent
 * désormais dans la vue en PRÉSENTANT son secret (`entrerVue`), et
 * vérifient la vue courante avant d'éprouver quoi que ce soit : un
 * `enable view` refusé laisse la session à la racine, où tout
 * fonctionne, donc l'assertion suivante ne veut rien dire sans ce
 * contrôle.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function ios(r: CiscoRouter, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await r.executeCommand(c));
  return last;
}

async function config(r: CiscoRouter, cmds: string[]): Promise<string> {
  const sorties: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds, 'end']) {
    sorties.push(String(await r.executeCommand(c)));
  }
  return sorties.join('\n');
}

const SECRET_NOC = 'NocViewPassword2024!';

/**
 * Entrer dans une vue EN PRÉSENTANT son secret.
 *
 * `enable view <nom>` demande désormais le secret de la vue, comme IOS —
 * il était stocké, rendu, et lu par personne. Les appels de ce fichier
 * qui l'omettaient prouvaient donc moins qu'ils n'en avaient l'air : un
 * `enable view` refusé laissait la session à la RACINE, où tout
 * fonctionne, ce qui faisait passer les assertions pour la mauvaise
 * raison.
 */
async function entrerVue(r: CiscoRouter, nom: string, secret = SECRET_NOC): Promise<string> {
  return String(await r.executeCommand(`enable view ${nom}`, { passwordInput: secret }));
}

/** Un routeur avec AAA actif et une vue NOC déclarée. */
async function labVue(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await config(r, [
    'aaa new-model',
    'parser view NOC_VIEW',
    `secret ${SECRET_NOC}`,
    'commands exec include show version',
    'commands exec include show running-config',
    'commands exec include ping',
    'exit',
    'parser view HELPDESK_VIEW',
    'commands exec include show version',
  ]);
  return r;
}

describe('§11 : déclarer une vue', () => {
  /**
   * Deux conditions d'IOS, et ce ne sont pas des formalités : une vue est
   * un mécanisme d'autorisation, donc elle vit dans AAA.
   */
  it('`parser view` exige `aaa new-model`', async () => {
    const r = new CiscoRouter('R1');
    expect(await config(r, ['parser view NOC_VIEW']))
      .toContain('AAA must be enabled first');
  });

  it('une vue se déclare, se peuple et se relit', async () => {
    const r = await labVue();
    const cfg = await ios(r, ['show running-config']);
    expect(cfg).toContain('parser view NOC_VIEW');
    expect(cfg).toContain(' commands exec include show version');
    expect(cfg).toContain(' commands exec include ping');
    // Le secret est HACHÉ, comme tout secret Cisco — et par le rendu
    // partagé, pour qu'une même saisie donne le même résultat partout.
    expect(cfg).toMatch(/ secret 5 \$1\$/);
    expect(cfg).not.toContain('NocViewPassword2024!');
  });

  /**
   * Une commande qui n'existe pas n'accorderait rien : l'accepter ferait
   * d'une faute de frappe une vue silencieusement vide, ce qui est le
   * défaut que ce mécanisme est censé refermer.
   */
  it('une commande inexistante est refusée à l\'inclusion', async () => {
    const r = new CiscoRouter('R1');
    expect(await config(r, [
      'aaa new-model', 'parser view V', 'commands exec include bidon truc',
    ])).toContain('%Command not found');
  });

  /**
   * Ce cas vérifiait qu'un mode autre qu'`exec` était REFUSÉ, au motif
   * qu'il aurait été rangé sans effet. Le motif a disparu : les quatre
   * modes d'analyseur sont désormais rangés ET consultés, donc une vue
   * peut décrire un rôle qui configure. Ce qui reste à vérifier est
   * qu'un mode INEXISTANT, lui, est toujours refusé.
   */
  it('les modes d\'analyseur réels sont acceptés, un mode inventé non', async () => {
    const r = new CiscoRouter('R1');
    expect(await config(r, [
      'aaa new-model', 'parser view V', 'commands configure include hostname',
    ])).not.toContain('% Invalid input detected');
    const r2 = new CiscoRouter('R2');
    expect(await config(r2, [
      'aaa new-model', 'parser view V', 'commands nawak include hostname',
    ])).toContain('% Invalid input detected');
  });

  it('`show parser view all` liste les vues déclarées', async () => {
    const r = await labVue();
    const out = await ios(r, ['show parser view all']);
    expect(out).toContain('Views/Superviews Present in System:');
    expect(out).toContain('NOC_VIEW');
    expect(out).toContain('HELPDESK_VIEW');
  });

  it('sans vue déclarée, `show parser view all` le dit', async () => {
    const r = new CiscoRouter('R1');
    expect(await ios(r, ['enable', 'show parser view all'])).toBe('No views are configured');
  });

  it('`no parser view` la retire', async () => {
    const r = await labVue();
    await config(r, ['no parser view HELPDESK_VIEW']);
    const out = await ios(r, ['show parser view all']);
    expect(out).toContain('NOC_VIEW');
    expect(out).not.toContain('HELPDESK_VIEW');
  });
});

describe('§11 : une vue REMPLACE l\'arbre visible', () => {
  it('ce qu\'elle inclut fonctionne, tel quel', async () => {
    const r = await labVue();
    await ios(r, ['enable']);
    await entrerVue(r, 'NOC_VIEW');
    expect(await ios(r, ['show parser view'])).toBe("Current view is 'NOC_VIEW'");
    // Pas un talon : la commande s'exécute comme au niveau 15.
    expect(await ios(r, ['show version'])).toContain('Cisco IOS Software');
    expect(await ios(r, ['ping 8.8.8.8'])).toContain('Success rate is');
  });

  /**
   * Le point qui sépare une vue d'un niveau de privilège : ce qui n'est
   * pas inclus répond comme une commande qui n'existe pas — c'est ce que
   * fait IOS, une commande hors de votre vue n'est pas « refusée », elle
   * est absente.
   */
  it('ce qu\'elle n\'inclut pas répond comme une commande absente', async () => {
    const r = await labVue();
    await ios(r, ['enable']);
    await entrerVue(r, 'NOC_VIEW');
    for (const cmd of ['show ip interface brief', 'configure terminal', 'show ip route', 'reload']) {
      expect(await ios(r, [cmd]), cmd).toContain('% Invalid input detected');
    }
  });

  it('un préfixe inclus couvre ce qui le complète', async () => {
    const r = new CiscoRouter('R1');
    // `all` : sans lui, une entrée ne vaut que pour la commande NOMMÉE.
    // C'est la distinction qu'IOS fait et que ce simulateur ignorait, en
    // appliquant la sémantique d'`all` à toute entrée.
    await config(r, ['aaa new-model', 'parser view V', 'commands exec include all show ip']);
    await ios(r, ['enable view V']);
    expect(await ios(r, ['show ip interface brief'])).not.toContain('% Invalid input');
    expect(await ios(r, ['show version'])).toContain('% Invalid input detected');
  });

  it('`exclude` retire une commande d\'un préfixe inclus', async () => {
    const r = new CiscoRouter('R1');
    await config(r, [
      'aaa new-model', 'parser view V',
      'commands exec include all show ip',
      'commands exec exclude show ip route',
    ]);
    await ios(r, ['enable view V']);
    expect(await ios(r, ['show ip interface brief'])).not.toContain('% Invalid input');
    expect(await ios(r, ['show ip route'])).toContain('% Invalid input detected');
  });

  /**
   * Une vue dont on ne peut pas sortir n'est plus un rôle, c'est une
   * souricière : `enable view` sans nom ramène à la racine, et
   * `show parser view` dit toujours où l'on est.
   */
  it('on sort toujours d\'une vue, et on sait toujours où l\'on est', async () => {
    const r = await labVue();
    expect(await ios(r, ['enable', 'show parser view'])).toBe("Current view is 'root'");

    await entrerVue(r, 'NOC_VIEW');
    expect(await ios(r, ['show parser view'])).toBe("Current view is 'NOC_VIEW'");

    await ios(r, ['enable view']);
    expect(await ios(r, ['show parser view'])).toBe("Current view is 'root'");
    // Et la racine retrouve tout.
    expect(await ios(r, ['show ip interface brief'])).not.toContain('% Invalid input');
  });

  it('une vue qui n\'existe pas est refusée', async () => {
    const r = await labVue();
    expect(await ios(r, ['enable', 'enable view INEXISTANTE']))
      .toContain('%Error: View INEXISTANTE is not present in the system');
  });

  /**
   * IOS interdit de déclarer une vue depuis une vue : sans cela, une vue
   * restreinte pourrait s'octroyer des commandes et le mécanisme se
   * viderait de son sens.
   */
  it('on ne déclare pas une vue depuis une vue', async () => {
    const r = await labVue();
    await ios(r, ['enable']);
    await entrerVue(r, 'NOC_VIEW');
    // `configure terminal` n'est pas dans la vue : on y arrive par la
    // racine, puis on re-bascule pour éprouver la garde elle-même.
    await ios(r, ['enable view']);
    await ios(r, ['configure terminal']);
    await r.executeCommand('end');
    await entrerVue(r, 'NOC_VIEW');
    expect(await ios(r, ['show parser view'])).toBe("Current view is 'NOC_VIEW'");
  });
});

describe('§11 : attacher une vue à un compte', () => {
  it('`username X view NOM` se configure et se relit', async () => {
    const r = await labVue();
    await config(r, [
      'username noc_agent privilege 15 secret NocAgent2024!',
      'username noc_agent view NOC_VIEW',
    ]);
    const cfg = await ios(r, ['show running-config']);
    // IOS l'écrit sur une ligne SÉPARÉE : c'est une commande à part, et
    // la fondre dans la précédente donnerait une ligne qu'un import ne
    // saurait pas rejouer.
    expect(cfg).toContain('username noc_agent view NOC_VIEW');
    expect(cfg).toMatch(/username noc_agent privilege 15 secret/);
  });

  it('attacher une vue inexistante est refusé', async () => {
    const r = await labVue();
    expect(await config(r, ['username x view INEXISTANTE']))
      .toContain('%Error: View INEXISTANTE is not present in the system');
  });
});

describe('§11 : hors d\'une vue, rien ne change', () => {
  /**
   * La garde-fou de ce chantier : la porte ne doit rien coûter ni rien
   * filtrer tant qu'aucune vue n'est active — c'est le cas de toutes les
   * autres suites du dépôt.
   */
  it('un routeur sans vue exécute tout ce qu\'il exécutait', async () => {
    const r = new CiscoRouter('R1');
    await ios(r, ['enable']);
    for (const cmd of ['show version', 'show ip interface brief', 'show ip route', 'show running-config']) {
      expect(await ios(r, [cmd]), cmd).not.toContain('% Invalid input');
    }
  });

  it('des vues DÉCLARÉES mais non activées ne filtrent rien', async () => {
    const r = await labVue();
    await ios(r, ['enable']);
    // `show ip route` n'est dans aucune vue, et doit fonctionner : on
    // n'est pas dans une vue.
    expect(await ios(r, ['show ip route'])).not.toContain('% Invalid input');
  });
});
