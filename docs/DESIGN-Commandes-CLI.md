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

- **P1 — le garde-fou d'abord.** Étendre `probe-switch-help-parite` à tout l'arbre :
  chaque nœud exécutable est-il proposé par `?` ET par Tab, avec le même ensemble ? Il
  tombera, et c'est son rôle : il chiffre la dette avant qu'on la paie.
- **P2 — unifier les sources.** Extraire les cinq derrière `SuggestionSource` sans
  rien changer d'autre. L'extraction depuis le texte source devient une source comme
  les autres, explicitement DERNIÈRE et désactivable. Purement interne.
- **P3 — introduire `CommandSpec`, sans migrer.** `declare(spec)` à côté de
  `register()`, construisant le même nœud. Toute nouvelle commande passe par là.
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
