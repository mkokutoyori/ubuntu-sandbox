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

## Reste ouvert

- **Le libellé n'est pas du vrai IOS.** `%CDP-7-DEBUGGING: Neighbor X on
  Y refreshed` est construit à partir du nom de la sévérité. Un vrai IOS
  écrit `CDP-PA: Packet received from X on interface Y`, sans préfixe
  `%…-7-…`. La porte corrige *quand* la ligne sort ; sa forme reste à
  reprendre, protocole par protocole. Non fait ici : c'est un travail de
  fidélité de texte, indépendant du défaut remonté, et qui touche des
  tests qui épinglent le libellé actuel.
- **`runSshCommandSync`** (le `ssh hôte "commande"` non interactif)
  répond encore `Current privilege level is 15` en dur.
- **Tâche #53** : `debug` et `terminal monitor` ne produisent aucune
  sortie sur une session SSH *interactive* (le cas non interactif est
  corrigé).
- `cdp.neighbor.discovered` (première découverte) ne passe pas par la
  sévérité 7 et n'a donc pas de ligne de debug ; seul le rafraîchissement
  en produit une.
