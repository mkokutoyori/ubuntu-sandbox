# PRD — la mise à jour dynamique DNS (RFC 2136, RFC 8945, `nsupdate`)

## 1. Pourquoi ce document

Un annuaire DNS qu'on ne peut modifier qu'à la main n'est pas celui des
réseaux d'aujourd'hui : un poste qui prend un bail DHCP apparaît dans la
zone, un serveur qui change d'adresse s'y met à jour, et un administrateur
compose la modification depuis sa machine. Les trois passent par la même
chose — un message DNS de code d'opération UPDATE.

> **État : implémenté.** Le message, son évaluation, sa signature TSIG, le
> client DHCP qui s'en sert et la commande `nsupdate` (scriptée et
> interactive) sont livrés. Le §6 dit ce qui reste ouvert et pourquoi.

## 2. L'état des lieux, mesuré

*(Cette section décrit l'état AVANT implémentation ; elle est conservée
parce que c'est elle qui justifie les phases.)*

- `PrimaryZoneAgent.applyUpdate` existait, correcte : elle retire, ajoute,
  avance le numéro de série, journalise et notifie les secondaires.
- **Rien ne l'atteignait par le réseau.** `start()` acheminait toute
  demande vers `AuthoritativeServer.answer`, qui répond NOTIMP à tout code
  d'opération autre que QUERY.
- Trois endroits du dépôt l'avaient constaté et l'avaient écrit dans leurs
  commentaires plutôt que de le fermer — dont l'en-tête de
  `WindowsDnsServerRole`, qui déclarait « a wire-level RFC 2136 UPDATE
  handler, which the underlying engine doesn't implement at any layer yet ».
- Le client DHCP posait S=1 dans l'option 81 sur TOUTES les machines, non
  par choix mais faute de moyen : la branche S=0 du serveur, écrite et
  correcte, n'était atteignable que par un client fabriqué par une sonde.

## 3. Ce qui est écrit

### 3.1 Le message (`src/network/dns/update/DnsUpdate.ts`)

Section de zone (une entrée, type SOA), les **cinq** formes de prérequis
du §2.4 et les **quatre** formes de mise à jour du §2.5, codées et
relues. L'encodage est attesté contre `miekg/dns` (`update.go`), une
implémentation déployée : `rfc-editor.org`, `datatracker.ietf.org`,
`hjp.at` et `rfc-annotations.research.icann.org` sont EGRESS_BLOCKED
depuis ce réseau, et les résumés de recherche consultés mélangeaient les
quatre formes du §2.5 — ils annonçaient CLASS ANY pour l'AJOUT, ce qui
est faux et aurait produit un codeur plausible et inutilisable.

La seule chose qui manquait au socle était un **enregistrement sans
RDATA** : c'est ainsi que la RFC dit « cette famille-là, quelle que soit
sa valeur ». `EmptyRecordData` porte `type: RRType.ANY` — un littéral,
pour que l'union discriminée de `ResourceRecordData` continue de
discriminer — et le TYPE réellement posé sur le fil dans `wireType`. Le
décodeur rend cette forme dès que RDLENGTH vaut zéro, ce qui est
exactement le signal de la RFC.

### 3.2 L'évaluation (`update/UpdateResponder.ts`)

Prérequis d'abord, puis développement des suppressions contre la zone
réelle, et le code de retour de la RFC : YXDOMAIN 6, YXRRSET 7,
NXRRSET 8, NOTAUTH 9, NOTZONE 10. Deux garde-fous que la RFC impose : le
SOA et les NS du sommet de zone ne peuvent pas être supprimés, et un nom
hors de la zone est refusé par NOTZONE.

**Les deux serveurs passent par ce même module** — `PrimaryZoneAgent` et
le rôle DNS de Windows —, jamais par deux implémentations.

### 3.3 La signature (`src/network/dns/tsig/Tsig.ts`)

Le condensat porte sur les octets RÉELLEMENT ÉMIS : le message privé de
son propre enregistrement TSIG, son compte d'additionnels décrémenté, son
identifiant d'origine remis en place, suivis des « variables TSIG ». Pour
une RÉPONSE, le condensat de la DEMANDE est préfixé, ce qui lie les deux.
Disposition attestée contre `miekg/dns` (`tsig.go`).

`hmac()` de `src/crypto/mac/hmac.ts` est le vrai HMAC de la RFC 2104 :
rien de la cryptographie n'est réinventé ici.

**Signer et encoder ne peuvent pas diverger** : `tsigRecordFor` rend
l'ENREGISTREMENT, `signedDnsMessage` le pose en fin de section
additionnelle, et le transport encode comme il encode tout le reste. Une
première version signait des octets puis laissait le transport
ré-encoder — deux encodages pour un seul fait.

### 3.4 Les portes

- **Le client DHCP Windows** pose S=0 et enregistre son A lui-même ; le
  client Linux garde S=1 et laisse faire le serveur. Le drapeau est
  DÉRIVÉ de ce que la machine sait faire, de sorte qu'un client ne peut
  pas annoncer qu'il s'en charge sans s'en charger. Il RETIRE son
  enregistrement en libérant le bail — avant de perdre son adresse, sans
  quoi le message ne partirait pas.
- **`nsupdate`**, scripté (entrée standard ou fichier, `-y` pour la clé)
  et interactif (l'invite `>`, `show`, `answer`, `send`). Les deux lisent
  UN seul analyseur, `update/NsupdateScript.ts`.
- **PowerShell** : `Set-DnsServerPrimaryZone -DynamicUpdate`,
  `Add-/Get-/Remove-DnsServerTsigKey`, et `Get-DnsServerZone` qui lit
  enfin le mode réel au lieu d'annoncer `None` en dur.

## 4. Ce que la mesure a appris

- **La durée de vie distingue les deux auteurs** : le client pose 1200 s
  comme un vrai Windows, le serveur 3600. Sans elle, « le nom est dans la
  zone » ne dit pas QUI l'y a mis, et trois cas de sonde passaient des
  deux côtés pour cette seule raison.
- **`DynamicUpdates Never` ne peut rien contre un client qui s'enregistre
  lui-même** : ce réglage gouverne le SERVEUR. Deux cas de tests
  encodaient la prémisse inverse.
- **Un TSIG dont les champs ne tiennent pas dans sa RDATA doit être
  refusé** : sans ce contrôle, retourner le dernier octet du message le
  faisait accepter, la longueur des données annexes n'étant lue par rien.

## 5. Les limites assumées

- Le défaut de zone est `NonsecureAndSecure` et non `Secure` : une zone
  intégrée à l'annuaire d'un vrai Windows est en `Secure`, mais GSS-TSIG
  n'est pas modélisé, donc y placer le défaut rendrait toute mise à jour
  impossible sans une clé qu'aucune machine ne sait négocier.
- `Add-DnsServerTsigKey` n'existe pas sur un vrai Windows : c'est la
  forme BIND du même besoin, parce que la distribution de clé Windows EST
  Kerberos.

## 6. Ce qui reste ouvert (voir `TODO.md`)

- **GSS-TSIG** (Kerberos, TKEY) : la signature est réelle, sa
  distribution de clé ne l'est pas.
- Les mises à jour DNS déclenchées par autre chose qu'un bail DHCP ou
  `nsupdate` — la jonction de domaine Windows, par exemple — passent
  toujours par un appel de méthode interne.
