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
- Les directives `ssl_*` de nginx et `SSL*` d'Apache sont évaluées ; seules `ssl_ocsp*` (nginx) restent refusées en le disant.

## 3. Limites restantes

Les anciennes limites 1 à 5, 7 à 11 sont fermées (voir les sondes). Sources lues : OpenSSL 3.0.13, nginx 1.24.0, Apache httpd 2.4.58, curl 8.5.0 (clonés, pas de documentation secondaire).

- **Messages de poignée de main** : binaires comme sur le fil (RFC 8446 §4, RFC 5246 §7.4), certificats DER X.509, vol serveur chiffré AEAD. Interop réelle, dans les deux sens, avec openssl 3.0.13 par une vraie prise TCP (`tls-real-openssl-interop-probe`) : TLS 1.3 et 1.2, certificats RSA et ECDSA P-256, ALPN, HelloRetryRequest, authentification mutuelle. Clés privées (PKCS#1, SEC1, PKCS#8, PBES2 AES/3DES, forme Proc-Type/DEK-Info), demandes PKCS#10, CRL (crlNumber, raisons), paramètres DH, OCSP (CertID haché, BasicOCSPResponse, agrafe TLS) sont du DER réel lu et écrit par openssl 3.0.13, fichiers `-inform/-outform DER` compris (`key-der-`, `csr-der-`, `crl-der-`, `dhparam-der-`, `ocsp-der-openssl-oracle`, `der-files-`). La reprise TLS 1.3 par PSK est réelle (binder HMAC, âge obfusqué, vol sans Certificate ; `tls-resumption-real-openssl-probe`). Les suites Camellia et ARIA sont négociées (`tls-camellia-aria-real-openssl-probe`) et nginx/Apache simulés répondent à curl et s_client réels par un relais TCP (`web-servers-real-clients-probe`). Le KeyUpdate est scellé et traverse le plan de données (`tls-key-update-real-openssl-probe`), le 0-RTT chiffre les données précoces sous le client_early_traffic_secret avec EndOfEarlyData et contrôle de l'âge du ticket (`tls-early-data-real-openssl-probe`), la reprise PSK survit au HelloRetryRequest (`tls-hrr-psk-real-openssl-probe`), le DHE de 3072 et 4096 bits interopère (`tls-dhe-large-groups-real-openssl-probe`). `openssl s_client` envoie son entrée et reste interactif (Q, k, K), son rapport suit le format d'openssl 3.0 (`openssl-s-client-report-real-probe`, `openssl-s-client-interactive`), et `openssl s_server` ouvre une vraie écoute TLS, en mode `-www/-WWW/-HTTP` (`openssl-s-server-probe`, authentification du client comprise) comme en mode interactif sans `-www` (`openssl-s-server-interactive` : données affichées au fil de l'eau, Q, q, r, R, k, K). `HttpsClientSession` suit un HelloRequest du serveur et `HttpsServerSession` peut exiger un certificat client par chemin par renégociation (`https-renegotiation`). La renégociation sécurisée de TLS ≤ 1.2 (RFC 5746) est réelle dans les deux sens et à l'initiative de chacun : ClientHello scellé sous les clés courantes, renegotiation_info vérifié, ChangeCipherSpec protégé (RFC 5246 §6.1), HelloRequest, alerte no_renegotiation (`tls-renegotiation-real-openssl-probe`). Restent hors de cette interop : renégociation dans une session reprise (la reprise est désactivée pendant une renégociation) commande `B` de s_client (heartbeat, absent d'openssl 3 par défaut), commandes `P` et `S` de s_server, renvoi automatique des données précoces refusées par le serveur, ordre CCM8/CCM dans `openssl ciphers`.
- **IIS/Schannel** : les clés de registre `Protocols\TLS 1.x` et `Ciphers` ne sont pas évaluées. Schannel est fermé et sa documentation Microsoft n'est pas atteignable ici ; faute de source, rien n'est deviné. Fournir les pages de documentation Microsoft (Schannel, TLS registry settings) permettrait de les implémenter.
- **Renégociation** (SSLVerifyClient dans `<Directory>`, `no_renegotiation`) : refusée en le disant, non exécutée.
- **OCSP** : `openssl ocsp` (requête, répondeur `-port` sur le fil, client `-url`, nonce), l'agrafage par fichier ET dynamique (nginx `ssl_stapling` sans fichier, Apache `SSLUseStapling` + `SSLStaplingCache`), `ssl_ocsp` et `SSLOCSPEnable` pour les certificats clients, `curl --cert-status` (codes 91 de curl 8.5) et `openssl s_client -status` sont réels : le serveur web interroge lui-même le répondeur par TCP. Acceptés et mémorisés sans effet (RTT nul, pas de proxy) : `SSLOCSPResponderTimeout`, `SSLOCSPProxyURL`, `SSLStaplingStandardCacheTimeout`/`ReturnResponderErrors`/`FakeTryLater`/`ErrorCacheTimeout`, `ssl_ocsp_cache` ; `openssl ocsp -url https://` non géré.
- QUIC et EAP-TLS restent figés sur 1.3 (RFC 9001 §4.2, RFC 9190).

## 4. Sondes

`tls-legacy-primitives`, `tls-legacy-handshake-probe`, `tls-consumers-policy-probe`, `tls-rfc7301-8446-edges-probe`, `tls-chain-validation-probe`, `tls13-certverify-context-probe`, `tls-rfc6125-identity-probe`, `tls-ssl-conf-curl-openssl-probe`, `tls-chain-revocation-probe`, `nginx-ssl-directives`, `apache-ssl-directives`, `web-ocsp-probe`, `tls-hrr-message-hash-probe`, `x509-der-openssl-oracle`, `x509-der-lab-interop`, `tls-real-openssl-interop-probe` (sous `src/__tests__/unit/network-v2/`). L'en-tête de chacune dit combien de cas tombent avant le correctif et nomme ceux qui passent dans les deux états.
