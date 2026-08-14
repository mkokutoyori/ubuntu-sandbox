# Carnet de bord — Module Pare-feu

> Suivi d'avancement de l'implémentation de `docs/BRD-Firewall.md`.
> Une entrée par mini-livraison. Ce carnet enregistre **ce qui a été
> mesuré**, pas ce qui était prévu — quand la mesure contredit le BRD,
> c'est la mesure qui est écrite, et le BRD est corrigé.

| | |
|---|---|
| **Branche** | `mandeng` |
| **BRD** | `docs/BRD-Firewall.md` |
| **Répertoire** | `src/network/devices/firewall/` |
| **Tests** | `src/__tests__/unit/network-v2/firewall/` |
| **Démarche** | TDD — rouge, vert, propre, push |
| **Portée de non-régression** | Le répertoire `firewall/` seul, sauf mention contraire |

---

## Tableau de bord

| Phase | Mini-livraison | Cas | État |
|---|---|---|---|
| — | Révision BRD : composition plutôt qu'héritage | — | ✅ |
| 1 | `FlowKey` | 30 | ✅ |
| 1 | `ZoneTable` | 32 | ✅ |
| 1 | `AddressObject` | 25 | ✅ |
| 1 | `ServiceObject` | 24 | ✅ |
| 1 | `ObjectStore` (groupes, Composite) | — | ⏳ |
| 1 | `TcpStateMachine` | — | ⏳ |
| 1 | `SessionTable` | — | ⏳ |
| 1 | `SecurityRule` + `PolicyEvaluator` | — | ⏳ |
| 1 | `PolicyStore` | — | ⏳ |
| 1 | `PacketContext` + `FirewallPipeline` | — | ⏳ |
| 1 | Étapes de pipeline | — | ⏳ |
| 1 | Services L3 (`l3/`) | — | ⏳ |
| 1 | Façade `Firewall` | — | ⏳ |
| 1 | Sonde de phase 1 (topologie réelle) | — | ⏳ |

**Total actuel : 111 cas, verts.**

---

## Entrées

### E0 — Révision du BRD : `Firewall extends Equipment`

**Décision renversée.** Le BRD retenait `Firewall extends Router` « pipeline
substitué » (option C). Il retient désormais l'option B : `extends Equipment`,
capacités L3 par composition.

**Ce qui a emporté la décision**, au-delà de « un pare-feu n'est pas un
routeur » : la dette héritée n'est pas neutre, elle est **active**. Un
développeur ultérieur trouverait CDP, EIGRP, HSRP et les ACL liées aux
interfaces sur le pare-feu, les croirait disponibles, et les câblerait. Le
dépôt a le précédent exact de `GenericSwitch` — ~53 sites d'appel et une
erreur nommée pour refermer ce que l'héritage avait ouvert.

**Ce que la mesure a corrigé dans mon propre raisonnement** : le
contre-argument de l'option B (« réimplémenter des milliers de lignes ») ne
tient pas. `core/ip.ts` (14 fonctions), `core/interfaces.ts`
(`IIPv4Route`, `INeighborResolver`), `core/IcmpErrors.ts`,
`core/packetBuilders.ts`, `core/Ipv4Fragmentation.ts` et `core/FilterChain.ts`
sont **déjà autonomes**. Ce qui est coûteux dans `Router.ts` — protocoles de
routage, shells vendeur, redondances FHRP — est précisément ce dont un
pare-feu n'a pas besoin. Estimation : ~700 lignes contre 5615 héritées dont
~90 % inutiles.

Ajouté §7.3.4 : les dix patrons employés, chacun rattaché à **une contrainte
nommée du document**. Un patron qui ne sert aucune contrainte n'a pas sa
place.

Risque R5 (« la dette inerte ») supprimé — il n'y a plus d'héritage.
Remplacé par R5b : la divergence éventuelle des services L3 avec ceux de
`Router`, mitigée par une règle de sens de convergence (§36.3.1).

---

### E1 — `FlowKey`

`src/network/devices/firewall/session/FlowKey.ts` — 30 cas.

**Ce que ce module décide** : la table de sessions est indexée par flux
directionnel (BRD §10.2), et un flux **n'est pas toujours symétrique par
échange des ports**.

TCP et UDP le sont. **ICMP ne l'est pas** : une réponse d'écho porte le
*même* identifiant que la demande, et ce qui s'inverse est le **type**
(8 → 0). Traiter ICMP comme TCP produirait une clé de retour que la réponse
ne porte jamais — donc un `ping` qui ne se referme pas, et l'inspection à
états qui s'effondre sur le protocole le plus utilisé en diagnostic.

L'identifiant est rangé dans l'emplacement de port source et le type
numérique dans celui de destination : c'est le choix de netfilter, et il
garde la clé en quintuplet purement numérique.

`reverse(reverse(k)) === k` est vérifié sur cinq familles (TCP, UDP, ICMP
écho, ICMP erreur, GRE) — c'est l'invariant qui garantit qu'aucun sens ne
se perd.

**Correction à consigner** : mon premier « rouge TDD » n'en était pas un.
`npm install` n'avait jamais tourné dans ce conteneur, donc le test ne
s'exécutait pas du tout — c'est `vite` qui manquait, pas le module. Après
installation, j'ai retiré l'implémentation pour vérifier l'échec **pour la
bonne raison**. Depuis, chaque brique suit le cycle rouge → vert réel.

**Second défaut, dans le TEST et non le produit** : j'avais écrit `'a'` et
`'b'` comme adresses, qu'`IPAddress` rejette à juste titre. Deux cas
corrigés côté test.

---

### E2 — `ZoneTable`

`src/network/devices/firewall/model/ZoneTable.ts` + `SecurityZone.ts` — 32 cas.

Les six invariants I-Z1 à I-Z6 sont chacun un cas. Deux sont des **pièges
pédagogiques** et non des détails :

- **I-Z4** — une zone vide est **légale** et ne correspond à **rien**. Un
  apprenant qui crée une zone, l'utilise dans une règle et oublie d'y mettre
  une interface doit voir sa règle ne jamais correspondre, jamais
  correspondre à tout. L'inverse serait une faille enseignée.
- **I-Z2** — une interface appartient à zéro ou une zone, jamais deux, et le
  refus **nomme la zone actuelle**, sans quoi le diagnostic est impossible.
  Réaffecter une interface à sa propre zone reste accepté : ce n'est pas un
  conflit.

**Injection de dépendance, première application.** `referenceChecker`
(I-Z5) et `interfaceModeOf` (I-Z6) sont injectés ; le magasin ne connaît ni
la politique ni la table d'interfaces. Absentes, elles n'imposent aucune
contrainte — position honnête tant que l'`InterfaceTable` n'existe pas,
plutôt qu'une validation qui ferait semblant.

**Erreurs typées, première application de P3.** `ZoneTable` rend
`{ kind: 'interface-already-in-zone', zone: 'trust' }`. Le socle porte le
**fait**, la couche vendeur portera le **mot**.

---

### E3 — `AddressObject`

`src/network/devices/firewall/model/AddressObject.ts` — 25 cas.

**Décision de conception** : `subnet` et `wildcard` ne sont **pas** deux
mécanismes. Les deux répondent « ce bit doit-il correspondre ? », et la
seule différence est la contiguïté du masque. L'implémentation les ramène à
un unique **masque de bits significatifs** normalisé à la construction —
sans quoi deux chemins de correspondance coexisteraient, et ce dépôt sait
ce que coûtent deux chemins qui peuvent se contredire.

**Conséquence** : la convention d'écriture devient une affaire de
*constructeur* et non de moteur. Cisco écrit un masque générique où le bit à
1 signifie « peu importe » ; `addressFromCiscoWildcard` inverse à l'entrée.
Un cas vérifie que les deux formes décrivent le **même ensemble** sur quatre
candidats — seule façon de prouver que la conversion est juste plutôt que
plausible.

**`fqdn` sans résolveur ne correspond à rien**, délibérément : un objet FQDN
figé à la création serait un littéral déguisé. Un cas vérifie qu'il **suit**
un changement de résolution, ce qui est tout l'intérêt de ce type d'objet.

---

### E4 — `ServiceObject`

`src/network/devices/firewall/model/ServiceObject.ts` — 24 cas.

**`entries` est un tableau** (BRD §8.4.1). `DNS` couvre TCP/53 **et** UDP/53,
`service-http` de PAN-OS couvre 80 et 8080. Un service mono-protocole
obligerait à créer des *groupes* là où le constructeur crée un *service* —
donc à ne pas reproduire sa configuration.

**Le port source existe** (§8.4.2). Presque tous les cours l'ignorent,
presque tous les constructeurs le proposent. Une entrée qui n'en déclare pas
ne le contraint pas.

**ICMP** se compare par type et code, mais le code n'est vérifié que si
l'entrée en déclare un : `ALL_ICMP` ne doit pas cesser de correspondre parce
qu'un message porte un code inhabituel.

---

## Décisions prises en cours de route

| # | Décision | Motif |
|---|---|---|
| D1 | `Firewall extends Equipment` | E0 |
| D2 | ICMP indexé par (id, type) et non par ports | E1 |
| D3 | `subnet` et `wildcard` unifiés sur un masque de bits significatifs | E3 |
| D4 | Erreurs typées discriminées, jamais des chaînes | E2 |
| D5 | Dépendances externes injectées, défauts permissifs et déclarés | E2 |
| D6 | Vues gelées en profondeur | E2, E3, E4 |

## Défauts trouvés dans mon propre travail

| # | Défaut | Où | Correction |
|---|---|---|---|
| B1 | « Rouge TDD » qui n'en était pas un (`vite` absent) | E1 | Installation puis remesure |
| B2 | Adresses `'a'`/`'b'` invalides dans un test | E1 | Adresses réelles |

## Prochaines étapes

1. `ObjectStore` — groupes, Composite, refus de récursion, références calculées.
2. `TcpStateMachine` — la machine à états qui distingue l'inspection à
   états d'un simple suivi de tuples.
3. `SessionTable` — le cœur du module.
4. `PolicyEvaluator` puis `PolicyStore`.
5. `PacketContext` + `FirewallPipeline`.
