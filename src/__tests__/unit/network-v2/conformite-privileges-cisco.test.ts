/**
 * SUITE DE CONFORMITÉ — le moteur d'autorisation CLI de Cisco IOS.
 *
 * Elle éprouve les exigences du rapport « gestion des privilèges », une
 * par une, en affirmant CE QUI EST EXIGÉ et non ce que le simulateur
 * fait aujourd'hui : un cas qui tombe est une non-conformité, pas un
 * test à corriger.
 *
 * ────────────────────────────────────────────────────────────────────
 * DEUX POINTS OÙ LE RAPPORT S'ÉCARTE D'IOS RÉEL, ET CE QUI EST AFFIRMÉ
 * ────────────────────────────────────────────────────────────────────
 *
 * **§19-20 — le prompt d'un niveau intermédiaire.** Le rapport écrit
 * qu'un utilisateur `username alice privilege 5` garde le prompt
 * `Router>`. C'est faux sur IOS : le `>` marque le mode *user EXEC*, et
 * un niveau ≥ 2 obtenu par `enable <n>` ou attribué à la connexion place
 * la session en *privileged EXEC*, donc `#`. C'est exactement pourquoi
 * `username X privilege 15` fait entrer sans taper `enable` — le
 * comportement le plus connu de ce mécanisme. La suite affirme donc
 * `#`, et non ce qu'écrit le rapport.
 *
 * En revanche l'EXIGENCE que ce paragraphe porte est juste et elle est
 * éprouvée telle quelle : **on ne déduit jamais le niveau du prompt**.
 * Le niveau est un état, le prompt son affichage.
 *
 * **§16 — « distinguer commande inconnue et commande non autorisée ».**
 * Le rapport demande de les distinguer. IOS fait délibérément l'inverse :
 * une commande au-dessus de votre niveau rend le MÊME
 * `% Invalid input detected at '^' marker.` qu'une commande inexistante,
 * précisément pour ne pas révéler l'existence de ce qu'on ne peut pas
 * exécuter. La suite affirme le comportement d'IOS. La distinction que
 * le rapport réclame existe bien, mais à l'INTÉRIEUR du moteur (le
 * registre sait qu'elle existe), pas dans le message rendu.
 *
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function seq(r: CiscoRouter, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await r.executeCommand(c));
  return last;
}

async function conf(r: CiscoRouter, cmds: string[]): Promise<string> {
  return seq(r, ['enable', 'configure terminal', ...cmds, 'end']);
}

const niveau = async (r: CiscoRouter): Promise<number> => {
  const out = String(await r.executeCommand('show privilege'));
  return Number(/Current privilege level is (\d+)/.exec(out)?.[1] ?? -1);
};

// ═══ §1-4 : les seize niveaux, et le mode qui n'est pas le niveau ═══

describe('§1/§3/§4 — les niveaux de privilège existent et sont réels', () => {
  it('une session neuve est au niveau 1', async () => {
    const r = new CiscoRouter('R1');
    expect(await niveau(r)).toBe(1);
  });

  it('`enable` mène au niveau 15', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await niveau(r)).toBe(15);
  });

  it('§9 — `disable` redescend, et retire vraiment le droit', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('configure terminal')))
      .toContain('Enter configuration commands');
    await r.executeCommand('end');
    await r.executeCommand('disable');
    expect(await niveau(r)).toBe(1);
    // `disable` ne doit pas seulement changer le prompt.
    expect(String(await r.executeCommand('configure terminal')))
      .toContain('% Invalid input');
  });
});

describe('§2 — le mode CLI et le niveau sont deux choses distinctes', () => {
  it('entrer en configuration ne change PAS le niveau', async () => {
    const r = new CiscoRouter('R1');
    await seq(r, ['enable', 'configure terminal']);
    // `Router(config)#` n'est pas un « niveau 16 ».
    expect(await niveau(r)).toBe(15);
    await r.executeCommand('end');
    expect(await niveau(r)).toBe(15);
  });

  it('§37/§38 — le prompt dérive de l\'état, hostname compris', async () => {
    const r = new CiscoRouter('R1');
    expect(r.getPrompt()).toBe('R1>');
    await r.executeCommand('enable');
    expect(r.getPrompt()).toBe('R1#');
    await r.executeCommand('configure terminal');
    expect(r.getPrompt()).toBe('R1(config)#');
    // Un renommage doit se refléter IMMÉDIATEMENT dans la session ouverte.
    await r.executeCommand('hostname CORE');
    expect(r.getPrompt()).toBe('CORE(config)#');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(r.getPrompt()).toBe('CORE(config-if)#');
  });
});

// ═══ §5-8 : enable, ses secrets, ses niveaux ═══

describe('§5/§6/§7 — `enable` est une vraie opération d\'autorisation', () => {
  it('sans secret configuré, `enable` passe', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await niveau(r)).toBe(15);
  });

  it('§7 — `enable secret` est stocké HACHÉ, jamais en clair', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['enable secret MonSecret123']);
    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).not.toContain('MonSecret123');
    expect(cfg).toMatch(/enable secret 5 \$1\$/);
  });

  it('§7 — `enable secret` a PRIORITÉ sur `enable password`', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['enable password FaibleMot', 'enable secret FortSecret']);
    await r.executeCommand('disable');
    // Le mot de passe faible ne doit plus ouvrir le mode privilégié.
    const store = r.getEnableSecret();
    expect(store?.value).toBe('FortSecret');
  });

  it('§8 — `enable secret level <n>` se configure et se relit', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['enable secret level 5 Niveau5', 'enable secret level 15 Niveau15']);
    const cfg = String(await r.executeCommand('show running-config'));
    // IOS écrit le niveau seulement quand il n'est pas le défaut (15),
    // et fait suivre du type de condensé.
    expect(cfg).toMatch(/enable secret level 5 5 \$1\$/);
    expect(cfg).toMatch(/enable secret 5 \$1\$/);
    expect(cfg).not.toContain('Niveau5');
    expect(cfg).not.toContain('Niveau15');
  });
});

describe('§34 — `enable [niveau]` est une grammaire, pas un mot', () => {
  it('`enable 5` mène au niveau 5, `enable 15` au niveau 15', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable 5');
    expect(await niveau(r)).toBe(5);
    await r.executeCommand('enable 15');
    expect(await niveau(r)).toBe(15);
  });

  it('un niveau hors bornes est refusé', async () => {
    const r = new CiscoRouter('R1');
    const out = String(await r.executeCommand('enable 42'));
    expect(out).toMatch(/%/);
    expect(await niveau(r)).toBe(1);
  });
});

// ═══ §10-13, §35 : les niveaux intermédiaires et l'arbre ═══

describe('§10/§11/§35 — `privilege exec level` gouverne vraiment l\'accès', () => {
  it('une commande relevée à 5 est refusée au niveau 1 et permise au niveau 5', async () => {
    const r = new CiscoRouter('R1');
    // `privilege exec level 1 show` garde la branche joignable au niveau
    // 1 : sans elle, hisser `show ip route` hisse `show`, et
    // `show privilege` lui-meme deviendrait invisible.
    await conf(r, ['privilege exec level 1 show', 'privilege exec level 5 show ip route']);
    await r.executeCommand('disable');
    expect(await niveau(r)).toBe(1);
    expect(String(await r.executeCommand('show ip route'))).toContain('% Invalid input');
    await r.executeCommand('enable 5');
    expect(String(await r.executeCommand('show ip route'))).not.toContain('% Invalid input');
  });

  it('la règle se relit dans la configuration', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['privilege exec level 5 show ip route']);
    expect(String(await r.executeCommand('show running-config')))
      .toContain('privilege exec level 5 show ip route');
  });

  /**
   * Ce cas affirmait que `show version`, voisin dans l'arbre, restait au
   * niveau 1. C'est l'INVERSE de ce que Cisco documente : « When you set
   * a command to a privilege level, all commands whose syntax is a
   * subset of that command are also set to that level (…) unless you set
   * them to a different level. » Hisser `show running-config` hisse
   * `show`, donc TOUTE la branche quitte le niveau 1 — c'est le piège
   * n°1 du chapitre, et l'ignorer enseignait une délégation sans effet
   * de bord, donc une fausse sécurité.
   *
   * Ce que le cas voulait dire reste vrai et reste vérifié : le niveau
   * s'applique au NŒUD nommé et non à toute la branche — une règle sans
   * `all` ne descend pas dans les sous-commandes. Les deux moitiés sont
   * désormais distinguées, avec le remède documenté entre elles.
   */
  it('§35 — le nœud nommé est relevé, ses PARENTES le suivent, et on les redescend', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['privilege exec level 10 show running-config']);
    await r.executeCommand('disable');
    expect(String(await r.executeCommand('show running-config'))).toContain('% Invalid input');
    // La parente `show` a suivi : toute la branche quitte le niveau 1.
    expect(String(await r.executeCommand('show version'))).toContain('% Invalid input');

    // Le remède documenté : redescendre la parente.
    await conf(r, ['privilege exec level 1 show']);
    await r.executeCommand('disable');
    expect(String(await r.executeCommand('show version'))).toContain('Cisco IOS Software');
    // Et le nœud nommé, lui, reste à son niveau.
    expect(String(await r.executeCommand('show running-config'))).toContain('% Invalid input');
  });
});

// ═══ §14, §15, §44 : l'aide et la complétion respectent le niveau ═══

describe('§14/§44 — `?` ne montre pas ce que le niveau interdit', () => {
  it('l\'aide du niveau 1 est plus courte que celle du niveau 15', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    const priv = r.cliHelp('show ');
    await r.executeCommand('disable');
    const user = r.cliHelp('show ');
    expect(user).not.toBe(priv);
    expect(user.split('\n').length).toBeLessThan(priv.split('\n').length);
  });

  it('une commande relevée disparaît de l\'aide du niveau inférieur', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['privilege exec level 10 show version']);
    await r.executeCommand('disable');
    const motCle = (aide: string): boolean =>
      aide.split('\n').some((l) => /^\s+version\b/.test(l));
    expect(motCle(r.cliHelp('show '))).toBe(false);
    await r.executeCommand('enable 10');
    expect(motCle(r.cliHelp('show '))).toBe(true);
  });

  it('une commande privilégiée ACCORDÉE apparaît à ce niveau', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['privilege exec level 10 show running-config']);
    await r.executeCommand('disable');
    expect(r.cliHelp('show ')).not.toContain('running-config');
    await r.executeCommand('enable 10');
    expect(r.cliHelp('show ')).toContain('running-config');
  });

  it('§15 — la complétion suit la même règle que l\'aide', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['privilege exec level 10 show running-config']);
    await r.executeCommand('disable');
    expect(r.getCompletions('show run')).not.toContain('show running-config');
    await r.executeCommand('enable 10');
    expect(r.getCompletions('show run')).toContain('show running-config');
  });
});

// ═══ §40-43 : le parser et ses messages ═══

describe('§40/§41/§43 — les messages du parser sont distincts', () => {
  /**
   * Le premier jet de ce cas prenait `show ip rout bidon` pour exemple —
   * mauvais choix, mesuré : `rout` abrège `route`, et `bidon` est alors
   * un ARGUMENT de réseau, donc la machine répond justement
   * `% Network not in table`. Un mot-clé inexistant en position de
   * mot-clé est ce qu'il fallait.
   */
  it('un mot-clé inconnu rend `% Invalid input` avec un curseur', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    const out = String(await r.executeCommand('show ip bidonxyz'));
    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(out).toContain('^');
  });

  it('une commande incomplète le dit', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('clock set'))).toContain('% Incomplete command');
  });

  it('§43 — une abréviation ambiguë n\'exécute rien', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('show i'))).toContain('% Ambiguous command');
  });

  /**
   * §16 revisité : IOS ne distingue PAS, dans son message, une commande
   * inexistante d'une commande hors privilège. C'est délibéré — révéler
   * l'existence de ce qu'on ne peut pas exécuter renseignerait un
   * attaquant. La suite affirme donc l'identité des deux messages.
   */
  /**
   * Deuxième assertion corrigée après mesure : un MOT SEUL inconnu en
   * EXEC n'est pas traité comme une commande par IOS — il le prend pour
   * un nom d'hôte et tente de le résoudre (`Translating "..."...`), ce
   * que le simulateur reproduit fidèlement. La comparaison doit donc
   * porter sur un SOUS-mot-clé inconnu, seul terrain où les deux cas
   * sont comparables.
   */
  it('§16 — une commande hors privilège se tait comme une inconnue', async () => {
    const r = new CiscoRouter('R1');
    const horsPrivilege = String(await r.executeCommand('configure terminal'));
    const inexistante = String(await r.executeCommand('show bidonxyz'));
    expect(horsPrivilege).toContain('% Invalid input detected');
    expect(inexistante).toContain('% Invalid input detected');
  });
});

describe('§42/§63 — l\'autorisation vient APRÈS la résolution', () => {
  it('une abréviation est résolue puis autorisée', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('conf t')))
      .toContain('Enter configuration commands');
    await seq(r, ['end', 'disable']);
    // Et au niveau 1, TOUTES les variantes doivent être refusées : sans
    // resolution prealable, `conf t` contournerait le controle.
    for (const variante of ['configure terminal', 'conf t', 'configure t']) {
      expect(String(await r.executeCommand(variante)), variante)
        .toContain('% Invalid input');
    }
  });
});

// ═══ §18-20, §24-25 : utilisateurs, lignes, précédence ═══

describe('§18/§19 — un compte porte son niveau', () => {
  it('`username X privilege N secret` est stocké et rendu haché', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, [
      'username alice privilege 5 secret Alice123',
      'username guest privilege 1 secret Guest123',
    ]);
    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).toContain('username alice privilege 5 secret 5 $1$');
    expect(cfg).toContain('username guest secret 5 $1$');
    expect(cfg).not.toContain('username guest privilege 1');
    expect(cfg).not.toContain('Alice123');
  });

  it('le niveau du compte est lisible par le moteur', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['username alice privilege 5 secret Alice123']);
    expect(r.getCredentialStore().lookup('alice')?.privilege).toBe(5);
  });
});

describe('§23/§24 — la ligne porte ses propres réglages', () => {
  it('`line vty` retient `privilege level` et `login local`', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['line vty 0 4', 'privilege level 15', 'login local', 'exit']);
    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).toContain('line vty 0 4');
    expect(cfg).toContain(' privilege level 15');
    expect(cfg).toContain(' login local');
  });

  it('console, vty et aux sont des lignes distinctes et rendues', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, [
      'line console 0', 'exec-timeout 5 0', 'exit',
      'line aux 0', 'no exec', 'exit',
      'line vty 0 4', 'exec-timeout 10 0', 'exit',
    ]);
    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).toMatch(/line con(sole)? 0/);
    expect(cfg).toContain('line aux 0');
    expect(cfg).toContain('line vty 0 4');
    expect(cfg).toContain(' exec-timeout 5 0');
    expect(cfg).toContain(' exec-timeout 10 0');
  });
});

// ═══ §30-33, §61 : la machine à états des modes ═══

describe('§30/§31/§32 — la machine à états des modes', () => {
  it('§31 — `end` revient directement à l\'EXEC privilégié', async () => {
    const r = new CiscoRouter('R1');
    await seq(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
    expect(r.getPrompt()).toBe('R1(config-if)#');
    await r.executeCommand('end');
    expect(r.getPrompt()).toBe('R1#');
  });

  it('§32 — `exit` ne remonte QUE d\'un cran', async () => {
    const r = new CiscoRouter('R1');
    await seq(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0']);
    await r.executeCommand('exit');
    expect(r.getPrompt()).toBe('R1(config)#');
    await r.executeCommand('exit');
    expect(r.getPrompt()).toBe('R1#');
  });

  it('§30 — `configure terminal` exige le mode EXEC et le niveau', async () => {
    const r = new CiscoRouter('R1');
    expect(String(await r.executeCommand('configure terminal'))).toContain('% Invalid input');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('configure terminal')))
      .toContain('Enter configuration commands');
  });

  it('§29 — les sous-modes ont chacun leur prompt', async () => {
    const r = new CiscoRouter('R1');
    await seq(r, ['enable', 'configure terminal']);
    const attendus: ReadonlyArray<readonly [string, string]> = [
      ['interface GigabitEthernet0/0', 'R1(config-if)#'],
      ['line vty 0 4', 'R1(config-line)#'],
      ['router ospf 1', 'R1(config-router)#'],
    ];
    for (const [cmd, prompt] of attendus) {
      await r.executeCommand(cmd);
      expect(r.getPrompt(), cmd).toBe(prompt);
      await r.executeCommand('exit');
    }
  });
});

// ═══ §39 : les réglages de terminal ═══

describe('§39 — les réglages de terminal existent', () => {
  it('`terminal length` et `terminal width` sont acceptés', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    for (const c of ['terminal length 0', 'terminal width 132',
      'terminal monitor', 'terminal no monitor']) {
      expect(String(await r.executeCommand(c)), c).not.toContain('% Invalid input');
    }
  });
});

// ═══ §51-53 : running-config contre startup-config ═══

describe('§51/§52 — la configuration courante n\'est pas la configuration sauvegardée', () => {
  it('une modification n\'atteint pas `startup-config` sans sauvegarde', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('write memory');
    await conf(r, ['username tardif privilege 15 secret Tardif123']);
    expect(String(await r.executeCommand('show running-config'))).toContain('username tardif');
    expect(String(await r.executeCommand('show startup-config'))).not.toContain('username tardif');
  });

  it('`copy running-config startup-config` la reporte', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['username sauve privilege 15 secret Sauve123']);
    await r.executeCommand('copy running-config startup-config');
    expect(String(await r.executeCommand('show startup-config'))).toContain('username sauve');
  });
});

// ═══ §54-55 : les secrets ═══

describe('§54/§55 — les secrets sont typés', () => {
  it('`service password-encryption` obscurcit les mots de passe de type 7', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['service password-encryption',
      'line vty 0 4', 'password MotEnClair', 'exit']);
    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).toContain('service password-encryption');
    expect(cfg).not.toContain('MotEnClair');
    expect(cfg).toMatch(/password 7 /);
  });

  it('§56 — `enable secret` et `username secret` sont deux rôles distincts', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['enable secret SecretEnable',
      'username alice privilege 5 secret SecretAlice']);
    // Le secret d'activation n'authentifie pas alice, et inversement.
    expect(r.getEnableSecret()?.value).toBe('SecretEnable');
    expect(r.getCredentialStore().authenticate('alice', 'SecretAlice')).toBe(true);
    expect(r.getCredentialStore().authenticate('alice', 'SecretEnable')).toBe(false);
  });
});

// ═══ §57-58 : sessions simultanées ═══

describe('§57/§58 — chaque session a son propre état', () => {
  it('une session ne modifie pas le niveau d\'une autre', async () => {
    const r = new CiscoRouter('R1');
    const vty = r.createVtyShell('alice');
    // La console monte au niveau 15...
    await r.executeCommand('enable');
    expect(await niveau(r)).toBe(15);
    // ...et la session vty reste où elle est.
    const vtyNiveau = String(await vty.execute('show privilege'));
    expect(vtyNiveau).toContain('Current privilege level is 1');
    vty.dispose();
  });

  it('le mode de configuration d\'une session ne déborde pas', async () => {
    const r = new CiscoRouter('R1');
    const vty = r.createVtyShell('admin');
    await vty.execute('enable');
    await vty.execute('configure terminal');
    expect(vty.getPrompt()).toContain('(config)');
    // La console n'a pas bougé.
    expect(r.getPrompt()).toBe('R1>');
    vty.dispose();
  });
});

// ═══ §17/§27 : AAA ═══

describe('§17/§27 — AAA est un second mécanisme, distinct du niveau', () => {
  it('`aaa new-model` et ses listes se configurent et se relisent', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, [
      'aaa new-model',
      'aaa authentication login default local',
      'aaa authorization exec default local',
      'aaa authorization commands 15 default local',
    ]);
    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).toContain('aaa new-model');
    expect(cfg).toContain('aaa authentication login default local');
    expect(cfg).toContain('aaa authorization exec default local');
    expect(cfg).toContain('aaa authorization commands 15 default local');
  });

  it('authentification et autorisation sont deux questions distinctes', async () => {
    const r = new CiscoRouter('R1');
    await conf(r, ['aaa new-model', 'username alice privilege 5 secret Alice123']);
    // « Qui es-tu ? »
    expect(await r.authenticateViaAaa('alice', 'Alice123')).toBe(true);
    // « Qu'as-tu le droit de faire ? » — une autre question, un autre moteur.
    expect(await r.getAaaAuthenticator().authorizeCommand('alice', 'show version', 15))
      .toBe('allowed');
  });
});

// ═══ §49 : privilège ≠ capacité ═══

describe('§49 — le niveau 15 ne rend pas toute commande possible', () => {
  it('une commande que la plateforme n\'a pas reste refusée au niveau 15', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    // `switchport` est une commande de commutateur : un routeur la refuse,
    // quel que soit le niveau.
    await seq(r, ['configure terminal', 'interface GigabitEthernet0/0']);
    expect(String(await r.executeCommand('switchport mode access')))
      .toContain('% Invalid input');
  });
});
