# DNS — état de conformité aux RFC (docs/rfc/dns)

Bilan mesuré, RFC par RFC, du moteur unique `src/network/dns/` et des serveurs
qui l'utilisent. Chaque correctif porte une sonde discriminée avec `git stash`
(l'en-tête de la sonde donne combien de cas tombaient avant et nomme les
témoins). Les fichiers de sonde sont listés dans la dernière colonne.

## Synthèse par RFC

| RFC | Sujet | État | Sonde |
|---|---|---|---|
| 1034, 1035 | Noms, zones, messages, UDP/TCP | Génériques (RFC 4592), nœuds non terminaux vides en NODATA, QR=1 ignoré, noms > 255 octets rejetés au décodage. Limite : la troncature UDP reste enregistrement par enregistrement dans la section réponse (le test `dns-edns` l'exige ; la pratique de named n'est pas attestée d'ici). | `dns-rfc-conformance-probe`, `dns-wire-edns-probe` |
| 2136 | Mise à jour dynamique | Prérequis sur le RRset entier, classes étrangères et types méta en FORMERR, règles CNAME/SOA (série RFC 1982), dernier NS du sommet conservé, appliqué sur une copie puis delta. Limite : pas de SIG(0). | `dns-update-rfc2136-probe`, `bind9-dynamic-update-probe`, `named-update-policy` |
| 2308 | Cache négatif | SOA négatif à min(TTL, MINIMUM) ; NXDOMAIN retenu pour le nom, NODATA par type. Cache de SERVFAIL (§7, plafond 5 min), `servfail-ttl` de named (défaut 1 s, max 30 s). | `dns-rfc-conformance-probe`, `dns-resolver-hardening-probe` |
| 2845 | TSIG | Réponses d'erreur TSIG (BADKEY/BADSIG non signés, BADTIME signé avec l'heure serveur), ordre clé → temps → MAC, temps signé qui recule rejeté. Limites : RFC 8945 (qui remplace la 2845) injoignable d'ici, l'ordre suit la 2845 fournie ; TSIG sur transfert multi-messages réalisé (§4.4). | `dns-tsig-error-returns-probe`, `dns-axfr-tsig-stream-probe` |
| 4033, 4034, 4035 | DNSSEC | **Cryptographie réelle** : forme canonique RFC 4034 §6 (NSEC/RRSIG non passés en minuscules, RFC 6840 §5.1), étiquette de clé annexe B, DS SHA-1/SHA-256, RSASHA1, RSASHA256, ECDSAP256SHA256 ; octets DNSKEY/RRSIG/DS bruts sur le fil ; NS de délégation et colle non signés (§2.2), chaîne NSEC sans colle (§2.3). Preuve : les 13 signatures RSASHA1 et les étiquettes 38519/9465 de l'annexe A de la RFC 4035 se vérifient. NXDOMAIN signé : NSEC du nom et NSEC du générique du plus proche ancêtre, exigés par le validateur (§3.1.3.2, §5.4). Validateur (§5) : le jeu DNSKEY doit être signé par une clé ancrée ou portée par un DS vérifié ; une réponse sans RRSIG sous une zone sécurisée, un DS retiré sans NSEC signé d'absence, des NSEC retirés sont bogus (plus de rétrogradation) ; tous les RRSIG sont essayés, un algorithme inconnu seul donne insecure, le signataire doit être un ancêtre. Limites : pas de NSEC3, pas de renouvellement de clé automatisé. TTL plafonnés par l'original et la validité restante de la signature (§5.3.3), verdict conservé dans le cache. | `dns-dnssec-rfc4035-vectors`, `dns-dnssec-real-keys-probe`, `dns-dnssec-nxdomain-wildcard-proof`, `dns-dnssec-validator-rfc4035-probe` |
| 6891 | EDNS(0) | Options lues et écrites, FORMERR sur OPT multiple ou non racine, BADVERS, taille négociée. Limite : aucune option n'est interprétée (NSID, cookies, padding absents de l'ensemble). | `dns-wire-edns-probe` |
| 6895 | Registres IANA DNS | Plages de types méta (128–255) exploitées par la mise à jour ; non mesuré ailleurs. | — |
| 7766 | DNS sur TCP | Préfixe de longueur, connexion persistante, plusieurs requêtes par connexion, réassemblage, fermeture après 10 s d'inactivité ; octets bruts transmis au gestionnaire (TSIG sur TCP). Limites : le client ouvre une connexion par requête, pas de réponses dans le désordre, pas d'option edns-tcp-keepalive. | `dns-tcp-framing-rfc7766` |
| 7858 | DNS sur TLS | Préfixe de longueur dans le flux TLS. Limite : pas de bourrage (RFC 7830). | `dns-tcp-framing-rfc7766`, `dns-encrypted-transports` |
| 8484 | DNS sur HTTPS | GET `?dns=` et POST, 405, 415, 400, `Cache-Control: max-age`, identifiant DNS 0 côté client. Limite : un gestionnaire asynchrone répond 500 (le moteur HTTP est synchrone). | `dns-doh-rfc8484-probe` |

## Résolveur (RFC 1034 §5, RFC 2308)

Durcissement face à un serveur hostile : seuls les enregistrements du nom
demandé et de sa chaîne CNAME entrent dans le résultat et le cache
(`dns-resolver-hardening-probe`), une délégation doit être strictement sous la
zone interrogée et contenir le nom demandé, un glue doit appartenir à la zone du
serveur interrogé, le client UDP exige l'écho de la question et l'adresse et le
port source du serveur. Les bits AD (RFC 6840 §5.7) et CD (RFC 4035 §3.2.2) sont
gérés par une seule fonction, `RecursiveResponse`, partagée par named et Windows.

## Par plateforme

| Plateforme | Mise à jour dynamique | TSIG | Validation DNSSEC | Notes |
|---|---|---|---|---|
| BIND (`named`) | `allow-update`, `update-policy` (grant/deny, name, subdomain, wildcard, self, selfsub, selfwild, zonesub), élément d'ACL `key` ; `rndc freeze/thaw/sync`, reload refusé sur zone dynamique | clés `key {}` en base64 ; `allow-transfer { key … }` et `primaries { ip key … }` : AXFR signé en chaîne | `trust-anchors` (static-ds, initial-ds, static-key, initial-key), AD, CD, SERVFAIL sur bogus, `rndc secroots` | Les types de nom Kerberos de `update-policy` ne décident rien (un `deny` indécidable reste fermé). Le libellé d'erreur « allow-update and update-policy cannot both be set » n'est pas attesté mot pour mot. |
| Windows DNS Server | Moteur commun (propriété des enregistrements, vieillissement conservés) | `Add-DnsServerTsigKey -Secret` en base64 | `Add/Get/Remove-DnsServerTrustAnchor` (signature relevée dans la documentation Microsoft), AD, CD | Pas de cmdlets de signature de zone. |
| FortiGate | Transfert de zone secondaire (AXFR multi-messages), `ddns-key` en base64 | TSIG du DDNS DHCP | Aucune | Troncature UDP selon la taille négociée. |
| Cisco / Huawei (table d'hôtes) | — | — | Aucune | Réponses par le moteur commun (NODATA, SOA négatif, NOTIMP, OPT, troncature). |
| dnsmasq / stub systemd-resolved | — | — | Stub : validation par `resolved` | Écouteur UDP commun. |

## Secrets TSIG

Un secret s'écrit en base64 à toutes les frontières (`key {}` de named,
`nsupdate -y`, `Add-DnsServerTsigKey`, `ddns-key` FortiGate) et est décodé une
seule fois en matière de clé (`tsigKeyFromBase64`).

## Non réalisé, et pourquoi

- NSEC3 (RFC 5155) et SIG(0) (RFC 2931) : les textes ne sont pas dans `docs/rfc/dns`
  et sont injoignables depuis l'environnement ; sans source, rien n'est implémenté.
- Validation DNSSEC sur FortiGate (serveur DNS `config system dns-server`), Cisco et
  Huawei : aucune commande ni documentation de validation n'a été trouvée pour ces
  plateformes (la recherche ne remonte qu'un paramètre `dnssec-validate-status` de
  FortiADC, autre produit).
- Troncature UDP par RRset entier dans la section réponse : la pratique de named
  n'est pas attestée d'ici.
- DNAME, autres types hors de la liste du codec.
