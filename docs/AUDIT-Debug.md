# Audit — la fonction `debug`

État au 28 juillet 2026, après correction du défaut remonté depuis l'UI
(`%CDP-7-DEBUGGING` non sollicité, insensible à `no debug all`).

## Le défaut remonté

```
Router1#show cdp neighbors
...
%CDP-7-DEBUGGING: Neighbor ? on GigabitEthernet0/0 refreshed
Router1#no debug all
All possible debugging has been turned off
%CDP-7-DEBUGGING: Neighbor ? on GigabitEthernet0/0 refreshed   <-- ça continue
```

Trois défauts distincts dans trois lignes :

1. de la sortie de debug sans qu'aucun `debug` n'ait été tapé ;
2. `no debug all` annonce le succès et ne coupe rien ;
3. le voisin s'appelle `?` au lieu de `Switch1`.

## Cause

Il existait **cinq** chemins produisant de la sortie de debug. Quatre
sont passés par un registre (`RouterDebugService`, `SwitchDebugService`)
qui porte les drapeaux, répond à `show debugging` et se vide sur
`undebug all`. Le cinquième — les abonnements bus de `LoggingConfig` —
n'avait aucune porte.

`LoggingConfig` écrit huit familles de lignes en sévérité `debugging`
(7) : `cdp`, `lldp`, `nat`, `arp`, `dhcp`, `pim`, `vxlan`,
`port_security`. Sur un vrai IOS, la sévérité 7 **est** la sortie de
`debug` — elle n'existe que pendant que la commande correspondante est
active. Ici elle était produite inconditionnellement.

Tant que rien ne lisait ce flux, le défaut restait latent. Le commit
`0751a4e3` (rapport QA, défaut 009) a branché la console — IOS a
`logging console debugging` d'origine, ce qui est correct — et le
problème est devenu visible : le tampon se déversait sur le terminal.

`no debug all` était donc impuissant par construction : il vide le
registre, or ces lignes n'y étaient jamais entrées.

Le `?` était indépendant et plus simple : `cdp.neighbor.refreshed`
publie `remoteHost`, le lecteur lisait `remoteDeviceId`. Même erreur
côté LLDP (`remoteSystem` publié, `remoteSystemName` lu).

## Correction

Une seule porte, au seul endroit qui les voit toutes :
`LoggingConfig.append()` refuse toute ligne de sévérité `debugging` que
le registre de l'équipement ne reconnaît pas comme active
(`setDebugGate`). La ligne est abandonnée entièrement — ni console, ni
moniteur, ni tampon, ni republication — donc `show logging` ne la fait
pas ressortir par la bande.

La porte est posée là où le tampon rejoint le bus (`attachLoggingBus`,
côté routeur et côté switch), pas au premier accès au registre : sinon
un équipement dont personne n'ouvre le debug n'aurait jamais de porte,
ce qui est précisément le cas qui spammait.

Un équipement sans registre garde le comportement non gardé. C'est
volontaire : la forme de l'arbre ne change que là où un registre existe.

### Rien n'est devenu injoignable

Les huit familles doivent rester activables. Cinq avaient déjà une
catégorie (`cdp.packets`, `lldp.packets`, `ip.nat`, `ip.arp`,
`ip.dhcp.server`) — dont deux, `cdp.packets` et `lldp.packets`, étaient
des catégories **mortes** : le verbe `debug cdp` existait, le drapeau se
posait, et aucun émetteur ne le lisait. La porte les rend vivantes sans
écrire un émetteur : la ligne que `LoggingConfig` produisait déjà
devient la sortie de debug qu'elle aurait dû être depuis le début.

Trois n'avaient aucune catégorie et ont reçu la leur, plus le verbe :
`debug ip pim`, `debug vxlan`, `debug port-security`.

Côté switch, `SwitchDebugCategory` a gagné `cdp`, `lldp`,
`port-security`, `dhcp`, `vxlan`.

### Console du switch

En le vérifiant, un trou adjacent : `Switch` n'exposait pas
`getLoggingConfig()`. La console d'un switch ne recevait donc **rien** —
ni `%LINK`/`%LINEPROTO`, ni aucun debug — alors que le tampon se
remplissait correctement (`show logging` le montrait). Ajouté, en miroir
du routeur.

## État des chemins de debug

| Chemin | Registre | `show debugging` | `undebug all` |
| --- | --- | --- | --- |
| `RouterDebugService` (OSPF, ARP, IP, ICMP, NAT, DHCP, IPSec…) | oui | oui | oui |
| `SwitchDebugService` (STP, MAC, ARP, lien) | oui | oui | oui |
| `LoggingConfig` sévérité 7 | **oui, désormais** | oui | oui |
| `LoggingConfig` sévérités 0-6 | sans objet — ce sont de vrais messages syslog, pas du debug | — | — |
| `DebugBroadcast` | transport uniquement, pas un registre | — | — |

## Deuxième passe — la forme des lignes

La porte réglait *quand* une ligne sort, pas sa forme. Deux corrections
ont suivi.

### Le préfixe

`%CDP-7-DEBUGGING:` était fabriqué à partir du nom de la sévérité :
`%${TAG}-${severityNum}-${mnemonic ?? severity}`. IOS n'imprime jamais
cela pour du debug — la sortie de `debug` n'est pas du syslog, elle porte
le préfixe du sous-système et aucune sévérité.

Les huit familles ont donc quitté `LoggingConfig` pour les registres de
debug, qui émettent déjà des lignes brutes (`OSPF:`, `IP ARP:`, `NAT:`).
Il ne reste **aucun** `append('debugging', …)` : le cinquième chemin a
disparu au lieu d'être seulement gardé. La porte reste en place comme
garde-fou pour toute sévérité 7 qui réapparaîtrait.

Formes retenues : `CDP-PA: Packet received from X on interface Y`,
`LLDP: Received packet from X on Y`, `PIM(0): Update (S, G), incoming
interface I`, `NVE: Learned M in VNI N from peer P`, `IP ARP INSPECTION:
Learned IP MAC on P`, `PORT_SECURITY: Aged out M on P`, `DHCP: I state
A -> B`. Honnêtement : `CDP-PA`, `PIM(0)` et `DHCP:` sont des formes
Cisco établies ; `NVE:`, `IP ARP INSPECTION:` et `PORT_SECURITY:` sont
plausibles mais pas vérifiées contre une capture réelle.

La ligne NAT a été supprimée plutôt que déplacée : `NATEngine` émet déjà
`NAT: s=… -> …` sur le canal de debug, l'abonnement de `LoggingConfig`
en était un doublon syslog.

### Le `?` était systémique

Le voisin anonyme n'était pas un cas isolé. `LoggingConfig` lit chaque
payload à travers un `as unknown as { … }` qui **désactive le contrôle de
types** : un nom de champ inexistant compile et rend `undefined`, que les
`?? '?'` transforment en `?`.

Un contrôle croisé de tous les abonnements contre les payloads
réellement publiés a trouvé **57 abonnements sur 98** dans ce cas — plus
de la moitié. Corrigés en trois catégories : renommages simples (37,
`portName`→`port`, `group`→`groupAddress`, `neighbor`→`neighborIp`, …),
reformulations là où le champ attendu n'existe pas du tout (20, par
exemple `stp.root.changed` qui n'a jamais porté de VLAN), et payloads
imbriqués lus à plat (AAA et sessions SSH : la valeur est sous
`account.name` / `session.user`, pas à la racine).

`syslog-payload-fields.test.ts` re-dérive la comparaison depuis les
sources et échoue sur tout nouvel écart, donc le cast ne peut plus
pourrir en silence. La garde a été vérifiée par mutation.

## Reste ouvert
- **`runSshCommandSync`** (le `ssh hôte "commande"` non interactif)
  répond encore `Current privilege level is 15` en dur.
- **Tâche #53** : `debug` et `terminal monitor` ne produisent aucune
  sortie sur une session SSH *interactive* (le cas non interactif est
  corrigé).
- `cdp.neighbor.discovered` (première découverte) ne passe pas par la
  sévérité 7 et n'a donc pas de ligne de debug ; seul le rafraîchissement
  en produit une.
