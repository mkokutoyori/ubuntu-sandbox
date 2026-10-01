# SSL/TLS — état de conformité aux RFC

Référentiel : `docs/rfc/ssl/` (RFC 2246, 4346, 5246, 6066, 6125, 7301, 7465, 7525, 8446, 8701, 8996). Le moteur est unique : `src/network/tls/` ; HTTPS, FTPS, SMTP/STARTTLS, LDAPS, RDP, DoT, DoQ, EAP-TLS, l'inspection SSL des pare-feu et les trois serveurs web (nginx, Apache, IIS) passent par lui.

Conventions de lecture : **réel** = calculé et vérifié contre un oracle ou des vecteurs ; **évalué** = la valeur configurée décide du comportement ; **limite** = écrit ici, jamais silencieux.

## 1. Ce qui est réel

| Exigence | Source | État |
|---|---|---|
| Négociation de version (supported_versions, repli sur legacy_version) | RFC 8446 §4.2.1, RFC 5246 App. E | réel — défaut serveur et client `1.3, 1.2` |
| TLS 1.0 / 1.1 / 1.2 : poignée de main complète, PRF, Finished, ChangeCipherSpec | RFC 2246, 4346, 5246 | réel — PRF MD5⊕SHA1 (1.0/1.1) et P_hash SHA-256/384 (1.2) vérifiés contre `node:crypto` |
| Enregistrements AES-GCM, AES-CBC (IV explicite 1.1/1.2, chaîné 1.0), 3DES-CBC, MAC-puis-chiffrement | RFC 5246 §6.2.3 | réel — oracle `node:crypto` |
| Échanges ECDHE (x25519, secp256r1), DHE (groupes RFC 3526), RSA (RSAES-PKCS1-v1_5) | RFC 5246 §7.4.3, §7.4.7 | réel |
| Signature du ServerKeyExchange (RSA SHA-256 en 1.2, MD5‖SHA-1 en ≤ 1.1, ECDSA P-256) | RFC 5246 §7.4.3, RFC 4346 | réel |
| Authentification mutuelle en ≤ 1.2 | RFC 5246 §7.4.4 | réel |
| Sentinelle de rétrogradation `DOWNGRD` | RFC 8446 §4.1.3 | réel — un client 1.3 abandonne (`illegal_parameter`) |
| 1.0 et 1.1 refusés par défaut (`protocol_version`) | RFC 8996 | évalué |
| RC4 jamais offert, même demandé | RFC 7465 | évalué |
| DH ≥ 2048 bits côté client par défaut (`insufficient_security`) ; suites RSA non éphémères hors défaut avantagées par l'ordre serveur | RFC 7525 §4.2–4.3 | évalué, seuil configurable |
| Vérification du nom du serveur (SAN DNS/IP, jokers d'une étiquette entière, repli CN sans SAN) | RFC 6125 | réel |
| Alertes sur le fil (niveau + code), `peerAlert` côté récepteur | RFC 8446 §6 | réel |
| `no_application_protocol` quand aucun ALPN n'est commun | RFC 7301 §3.2 | réel |
| `record_overflow` (fragment > 2^14 + 2048) | RFC 8446 §5.2, RFC 5246 §6.2.3 | réel |
| Ticket de reprise ≤ 7 jours | RFC 8446 §4.6.1 | réel |
| Contexte de CertificateVerify (64 espaces + chaîne + 0x00) | RFC 8446 §4.4.3 | réel |
| Secrets applicatifs / de reprise aux points de transcription du §7.1 | RFC 8446 §7.1 | réel |
| Validation de chemin : intermédiaires, `basicConstraints`, `pathLenConstraint`, `keyUsage`, `extKeyUsage`, taille de clé RSA minimale | RFC 5280 §6 (utilisée par RFC 8446 §4.4.2, RFC 5246 §7.4.2) | réel — le serveur envoie sa chaîne (`serverChain`, ou `fullchain.pem` pour nginx/Apache) |

## 2. Ce que les outils de l'auditeur évaluent maintenant

- **nginx** : `ssl_protocols`, `ssl_ciphers`, `ssl_prefer_server_ciphers` (défauts de nginx 1.24 : `TLSv1.2 TLSv1.3`, `HIGH:!aNULL:!MD5`, préférence serveur désactivée). Valeur inconnue : `invalid value "TLSv9"` ; liste sans correspondance : `no cipher match`.
- **curl** : `--tlsv1.0` … `--tlsv1.3`, `--tls-max`, `--ciphers` (erreur 59 sur liste vide) ; `-v` affiche la version et la suite réellement négociées ; un refus du serveur est restitué avec le texte d'OpenSSL (`tlsv1 alert protocol version`, `sslv3 alert handshake failure`).
- **openssl** : `s_client -tls1 | -tls1_1 | -tls1_2 | -tls1_3 | -no_tls1_3 | -cipher` ; `ciphers [-v] [liste]` énumère les suites ≤ 1.2 réelles ; `verify -untrusted`.
- Les directives nginx connues mais non évaluées (`ssl_stapling`, `ssl_verify_client`, `ssl_client_certificate`, `ssl_ecdh_curve`, `ssl_session_tickets`, `ssl_session_cache`, `ssl_dhparam`, …) sont refusées en le disant (`not supported by this simulator`), jamais confondues avec une faute de frappe.

## 3. Limites connues

1. **Signature RSA de CertificateVerify en 1.3 : PKCS#1 v1.5, pas RSA-PSS** (RFC 8446 §4.2.3 l'interdit). RSASSA-PSS/SHA-256 exige un module de 528 bits au moins ; les clés de laboratoire font 512 bits par choix de performance (460 ms pour 2048 bits). Rouvrir la question suppose de changer ce défaut.
2. **Pas de reprise de session ≤ 1.2** (identifiant de session, tickets RFC 5077) ; la reprise PSK de 1.3 existe.
3. **Pas d'`extended_master_secret`** (RFC 7627, hors du référentiel) ni de `renegotiation_info` (RFC 5746).
4. **ECDHE_ECDSA avec CBC-SHA seulement en 1.2** : la signature ECDSA en ≤ 1.1 se fait sur SHA-1, que le module ECDSA du dépôt ne produit pas.
5. **ChaCha20-Poly1305 et AES-256-GCM en 1.3 ne sont pas implémentés** : la suite négociée 1.3 reste `TLS_AES_128_GCM_SHA256` pour le chiffrement réel ; les autres noms sont négociables mais la protection d'enregistrement est celle d'AES-128-GCM. (RFC 8439 hors référentiel.)
6. **Les messages de poignée de main sont des objets JSON**, pas du TLS binaire : aucun client ou serveur réel ne peut s'y connecter, et l'inverse. Les enregistrements, eux, ont le cadrage de la norme (type, version, longueur).
7. **Extensions RFC 6066 non évaluées** : `status_request` (agrafage OCSP), `max_fragment_length`, `truncated_hmac`. Le SNI est émis et vérifié (nom du certificat), mais un serveur ne choisit pas encore son certificat d'après lui.
8. **RFC 8701 (GREASE)** : ni émis ni toléré explicitement ; aucun client réel n'existe sur ce moteur pour en envoyer.
9. **Grammaire des listes OpenSSL** — la documentation (`docs.openssl.org`) n'est pas atteignable depuis cet environnement. Sont implémentés les opérateurs (`:` `,` espace, `!` `-` `+`, `@STRENGTH`, intersection `A+B`) et les mots-clés dont le sens se lit sur les attributs de la suite (`kRSA`, `aRSA`, `aECDSA`, `ECDHE`, `DHE`, `AESGCM`, `AES128`, `AES256`, `AES`, `3DES`, `RC4`, `SHA1`, `SHA256`, `SHA384`, `TLSv1.2`). `HIGH`, `ALL` et `DEFAULT` excluent 3DES faute de classement sourcé ; `MEDIUM` et `LOW` ne contiennent rien ; `@SECLEVEL=n` est refusé plutôt que deviné. Les textes d'erreur OpenSSL (`0A00042E`, `0A000410`, `0A000475`) viennent de transcriptions connues, non d'une source consultable ici.
10. **`openssl verify -untrusted` n'a pas de sonde de bout en bout** : aucune commande `openssl` n'émet encore une AC subordonnée (la validation de chemin, elle, est sondée sur l'API).
11. **Pas de révocation sur les intermédiaires** : CRL/OCSP ne s'appliquent qu'à la feuille.
12. QUIC et EAP-TLS restent figés sur 1.3 (RFC 9001 §4.2, RFC 9190).

## 4. Sondes

`tls-legacy-primitives`, `tls-legacy-handshake-probe`, `tls-consumers-policy-probe`, `tls-rfc7301-8446-edges-probe`, `tls-chain-validation-probe`, `tls13-certverify-context-probe`, `tls-rfc6125-identity-probe` (sous `src/__tests__/unit/network-v2/`). L'en-tête de chacune dit combien de cas tombent avant le correctif et nomme ceux qui passent dans les deux états.
