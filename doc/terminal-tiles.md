# Terminal Tiles — Guide d'utilisation

Le simulateur dispose d'un systeme de tuiles (tiling) pour afficher plusieurs terminaux
simultanement. Ce document explique comment manipuler les tuiles via les raccourcis clavier
et les boutons de la barre de titre.

## Ouverture d'un terminal

- **Double-clic** sur un equipement dans le canvas reseau
- **Bouton terminal** dans la barre d'action rapide (quand un equipement est selectionne)

Chaque nouveau terminal s'ouvre dans une tuile. Si des terminaux sont deja ouverts,
le nouveau terminal partage l'espace en creant automatiquement un split horizontal.

## Raccourcis clavier

| Raccourci                  | Action                                    |
|----------------------------|-------------------------------------------|
| `Ctrl+Shift+H`            | Diviser la tuile active horizontalement    |
| `Ctrl+Shift+V`            | Diviser la tuile active verticalement      |
| `Ctrl+Shift+W`            | Fermer la tuile active                     |
| `Ctrl+Shift+F`            | Basculer en plein ecran / restaurer        |
| `Ctrl+Shift+M`            | Minimiser toutes les tuiles (retour canvas)|
| `Ctrl+Shift+Fleche gauche` | Deplacer le focus vers la tuile de gauche |
| `Ctrl+Shift+Fleche droite` | Deplacer le focus vers la tuile de droite |
| `Ctrl+Shift+Fleche haut`   | Deplacer le focus vers la tuile du haut   |
| `Ctrl+Shift+Fleche bas`    | Deplacer le focus vers la tuile du bas    |

## Boutons de la barre de titre

Chaque tuile possede une barre de titre avec les boutons suivants (de gauche a droite) :

| Icone               | Action                                          |
|----------------------|-------------------------------------------------|
| Colonnes (deux)      | Split horizontal — divise la tuile en deux cote a cote |
| Lignes (deux)        | Split vertical — divise la tuile en deux empilees      |
| Tiret (—)            | Minimiser toutes les tuiles                            |
| Carre / Restaurer    | Plein ecran / Restaurer la taille d'origine            |
| Croix (X)            | Fermer cette tuile                                     |

## Manipulation des tuiles

### Redimensionner
Faites glisser la **barre de separation** entre deux tuiles pour ajuster la repartition
de l'espace. La barre s'illumine en bleu quand elle est survolee ou en cours de deplacement.

### Diviser une tuile (split)
1. Cliquez sur la tuile pour lui donner le focus (bordure bleue)
2. Utilisez `Ctrl+Shift+H` (horizontal) ou `Ctrl+Shift+V` (vertical)
3. Une tuile vide apparait — selectionnez un equipement dans la liste proposee

### Naviguer entre les tuiles
Utilisez `Ctrl+Shift+Fleches` pour deplacer le focus circulairement entre les tuiles.
La tuile active est indiquee par un liseré bleu.

### Fermer une tuile
`Ctrl+Shift+W` ferme la tuile active. Si c'est la derniere tuile, le systeme retourne
au canvas reseau. Quand une tuile est fermee, la tuile voisine recupere l'espace libere.

### Minimiser / Restaurer
`Ctrl+Shift+M` minimise **toutes** les tuiles et retourne au canvas reseau.
Les terminaux minimises apparaissent dans la **barre des taches** en bas de l'ecran.
Cliquez sur un terminal dans la barre pour restaurer toutes les tuiles.

**Important** : Le contenu des terminaux (historique des commandes, sortie, etat de la
session) est **preserve** lors de toutes les manipulations : split, fermeture de tuiles
voisines, redimensionnement, minimisation et restauration.

### Plein ecran
`Ctrl+Shift+F` bascule la tuile active en plein ecran. Tous les boutons de la barre de
titre restent disponibles. Appuyez a nouveau sur `Ctrl+Shift+F` pour revenir au mode tuile.

## Tuile vide

Quand vous creez un split, la nouvelle tuile est vide et affiche la liste des equipements
disponibles. Cliquez sur un equipement pour y ouvrir un terminal.

## Architecture technique

Le systeme de tuiles utilise un arbre binaire ou chaque noeud interne represente un split
(horizontal ou vertical avec un ratio ajustable) et chaque feuille represente un terminal.
Les composants terminaux sont rendus dans un conteneur stable et projetes via
`ReactDOM.createPortal` dans les emplacements des tuiles. Cette architecture garantit que
l'etat React des terminaux n'est jamais perdu, quelle que soit la manipulation effectuee.
