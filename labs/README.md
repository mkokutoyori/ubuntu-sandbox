# Labs

Ce répertoire est le **hub des laboratoires** du simulateur. Chaque sous-répertoire est un scénario complet :

- `topology.json` : la topologie exportée, à **importer** dans l'interface (bouton *Importer* de la barre d'outils) ;
- `README.md` : le scénario, le plan d'adressage, les comptes et les exercices pas à pas, avec la sortie attendue de chaque commande.

| Lab | Thème | Équipements | Dossier |
|-----|-------|-------------|---------|
| DNS — Agence bancaire (Banque Horizon) | DNS multi-éditeurs (Windows Server + BIND9) : arbre racine → `com` → domaine de la banque, récursion, redirection, transfert de zone, DHCP + mise à jour dynamique, site web nginx en HTTPS | 15 | [`dns-agence-bancaire/`](dns-agence-bancaire/README.md) |

## Importer un lab

1. Lancer l'application : `npm run dev`, puis ouvrir <http://localhost:8080>.
2. Barre d'outils → **Importer** → choisir le `topology.json` du lab.
3. Double-cliquer sur un équipement pour ouvrir son terminal (PowerShell ou cmd sur Windows, bash sur Linux, CLI IOS sur les équipements Cisco).

Un fichier de topologie est une machine qui tournait et qui redémarre : les adresses, les services démarrés, les baux DHCP, les zones DNS, les fichiers de configuration et les liens symboliques sont rétablis. Ce qui ne se sauvegarde pas : les caches (DNS, ARP, NAT) et les sessions ouvertes.

## Comment un lab est fabriqué

Chaque lab a trois pièces, qui se tiennent entre elles :

| Pièce | Où | Rôle |
|-------|----|------|
| Le constructeur | `src/labs/<lab>/` | Pose les équipements, les câbles, puis configure chacun **en tapant les mêmes commandes qu'un utilisateur** (shell, PowerShell, CLI IOS). Rien n'est injecté dans les moteurs. |
| Les vérifications | `src/labs/<lab>/checks.ts` | La liste des commandes qui prouvent que le lab fonctionne, avec ce qu'elles doivent afficher et ce qu'elles enseignent. |
| Le test | `src/__tests__/unit/labs/<lab>.test.ts` | Construit le lab, l'exporte, **le réimporte dans un canevas vierge** et exige que les mêmes vérifications passent sur le lab neuf **et** sur le lab réimporté. |

Régénérer un `topology.json` après une modification du constructeur :

```bash
UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/<lab>.test.ts
```

Ajouter un lab : copier cette structure, déclarer le plan d'adressage dans `plan.ts`, écrire le constructeur, les vérifications et le test, puis ajouter une ligne au tableau ci-dessus.
