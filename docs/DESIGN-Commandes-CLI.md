# Une commande, une déclaration

Refonte du système de commandes des équipements réseau.
**Diagramme et plan lisibles ici :** https://claude.ai/code/artifact/e8e01711-9d83-4122-af33-8c61e25f1cc1

## Le constat, mesuré

Le signalement était `service password-encryption` : acceptée par le commutateur,
absente de `?` et de Tab. L'audit a montré que ce n'est pas un oubli isolé mais la
forme normale d'un défaut que la structure rend possible.

- **533** appels d'enregistrement de commande, sur trois shells
  (`CiscoShellBase` 244, `CiscoSwitchShell` 255, `CiscoIOSShell` 34).
- **328** d'entre eux sont GLOUTONS : ils avalent leurs arguments sans les déclarer.
- **5** sources indépendantes alimentent les suggestions d'un même nœud.
- **3** endroits séparés décrivent une commande : action, aide, sérialisation.

### Le triangle qui se défait

Une commande existe à trois endroits sans lien entre eux — le **gestionnaire** qui
l'exécute, la **description d'arguments** qui la rend découvrable, le **sérialiseur**
qui la réécrit dans la configuration. Rien n'oblige les trois à exister ensemble, donc
chaque combinaison manquante est un défaut déjà rencontré :

| Ce qui manque | Cas réel |
|---|---|
| aide + sérialisation | `service password-encryption` avalée par le glouton `service <mot>` : marchait, introuvable |
| sérialisation | `login authentication CONSOLE_LOCALE` : acceptée, honorée, perdue au rechargement |
| une source unique | `aaa authentication ?` proposait `login`, Tab complétait `local` (mot grappillé dans le source) |
| la seconde plateforme | `describeCiscoArguments` posée sur le seul shell du routeur |

Chacun a été corrigé au cas par cas. **Aucun de ces correctifs n'empêche le suivant.**

## Les trois causes structurelles

1. **La déclaration est éclatée** — trois fichiers à penser, en oublier un ne casse
   rien de visible et ne fait échouer aucun test.
2. **Le glouton est le chemin le plus court** — `registerGreedy` accepte tout de
   suite ; déclarer les arguments est un travail que rien ne réclame.
3. **Les suggestions sont dérivées, pas déclarées** — faute de déclaration, l'arbre
   lit le TEXTE SOURCE du gestionnaire pour en extraire des mots-clés. C'est ce qui a
   produit `aaa authentication local`.

## Le modèle

Un seul objet décrit une commande ; l'exécution, l'aide, la complétion et la
sérialisation en sont DÉRIVÉES. Ce que le modèle interdit compte autant que ce qu'il
permet : on ne peut plus enregistrer une action sans dire ce qui la suit.

| Pattern | Où | Le défaut qu'il rend impossible |
|---|---|---|
| Command Object | `CommandSpec` | action, aide et sérialisation dans le même objet |
| Composite | `CommandNode` | un nœud intermédiaire porte sa description au lieu d'être nu |
| Strategy | `SuggestionSource` | `?` et Tab lisent LA liste, pas chacun la sienne |
| Specification | `PlatformGate` | « un Catalyst n'a pas de registre » se déclare sur la commande |
| Builder | `CommandRegistry.declare` | une déclaration incomplète est un refus à la construction |

**Le point qui décide de tout** : `SuggestionSource` est la seule porte. Aujourd'hui
l'aide et la complétion assemblent chacune leurs candidats — enfants, indices curatés,
mots extraits du source, valeurs d'énumération, résolveur dynamique — et c'est de cet
assemblage en double que naissent leurs désaccords. Une liste ordonnée de sources, lue
par les deux, rend le désaccord inexprimable.

## Migration — cinq phases, chacune livrable seule

Aucune ne demande de réécrire les 533 enregistrements : le registre accepte les deux
formes pendant toute la migration.

- **P1 — le garde-fou d'abord. LIVRÉ** (`probe-cli-help-parity-ratchet.test.ts`, 19 cas).
  Le parcours couvre les deux plateformes dans les deux modes et compte trois écarts :
  une commande exécutable que `?` ne propose pas, un mot que `?` propose et que Tab ne
  complète pas, une continuation que Tab accepte et que `?` tait. Il a d'abord chiffré
  la dette — 54 mots-clés muets, 11 mots non complétables, et une table d'arguments qui
  INVENTAIT des commandes sur le commutateur — puis les trois causes ont été corrigées,
  si bien que les budgets sont à 0. Ce sont des budgets, pas des constantes : ils
  peuvent remonter, et la neutralisation des correctifs fait tomber 7 des 19 cas.
- **P2 — unifier les sources. LIVRÉ** (`cli/SuggestionSources.ts`,
  `probe-cli-suggestion-sources.test.ts`). Les cinq sont nommées et ORDONNÉES en un
  seul endroit (`child`, `param`, `hint`, `auto`, `dynamic`) ; le trie les implémente
  en cinq collecteurs et les deux portes parcourent cette table au lieu de la
  ré-énumérer chacune. Chaque porte garde sa POLITIQUE — l'aide continue de filtrer sur
  les arguments consommés et d'écarter un mot grappillé qu'elle ne sait pas décrire, Tab
  continue de ne laisser passer les valeurs vivantes que si aucun mot-clé ne convient —
  parce que ce sont des différences voulues entre une liste qu'on lit et un mot qu'on
  complète. L'extraction depuis le texte source est explicitement la dernière des
  sources statiques et se coupe (`setAutoExtractionEnabled`). Aucune sortie ne change ;
  le cliquet de P1 reste à zéro.
- **P3 — introduire `CommandSpec`, sans migrer. LIVRÉ** (`cli/CommandSpec.ts`,
  `probe-cli-command-spec.test.ts`, 16 cas). `declare(spec)` construit exactement le
  nœud que `register()` construit, donc les deux formes coexistent pendant toute la
  migration. Ce que le constructeur REFUSE est le fond du sujet : pas de description ;
  un gestionnaire qui LIT ses arguments sans en déclarer aucun (contrôle mécanique — la
  signature de `run` prend des arguments, donc `args`, `continuations` ou
  `freeform: true` est exigé) ; un argument sans description ; une énumération vide.
  `platforms` rend la Specification réelle : une commande déclarée pour le routeur n'est
  pas enregistrée du tout sur l'arbre d'un commutateur. `serialize` existe et
  `declaredConfigLines` le collecte ; rien d'écrit à la main n'y migre encore, c'est P5.
  Pilote pour que ce soit un chemin et pas un type sans appelant : `show startup-config`
  et `show configuration` du commutateur sont déclarés.
- **P4 — migrer par famille**, en s'arrêtant à chaque fois que le compteur du
  garde-fou descend. L'ordre suit le risque : d'abord ce que les tutoriels traversent.
- **P5 — rapatrier la sérialisation.** `serialize()` sur la spécification retire les
  rendus de `running-config` écrits à la main, d'où viennent les « acceptée mais perdue
  au rechargement ». La plus payante et la plus intrusive : elle vient en dernier.

## Ce qui ne change pas

- **Le refus reste une fonctionnalité.** `config-register` sur un Catalyst,
  `aaa accounting … local`, la forme à mots-clés de `test aaa group` : `PlatformGate`
  sert à refuser fidèlement, pas à élargir.
- **Les gloutons légitimes survivent.** Une bannière capture du texte libre. Ce qui
  devient obligatoire est de DÉCLARER que l'argument est libre, pas de faire semblant
  qu'il est fermé.
- **Aucune migration de masse** : réécrire 533 enregistrements d'un coup ne serait
  vérifiable par personne.
