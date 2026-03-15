# Raccourcis clavier - Gestion des tuiles de terminaux

Ce document decrit les raccourcis clavier permettant de manipuler les tuiles de terminaux dans le Network Designer.

## Modes de disposition (layouts)

Le systeme de tuiles propose 5 modes de disposition, chacun accessible via un raccourci clavier :

| Raccourci | Mode | Description |
|-----------|------|-------------|
| `Alt + G` | **Grid** (grille) | Disposition automatique en grille. 1 colonne pour 1 terminal, 2 colonnes pour 2 a 4 terminaux, 3 colonnes au-dela. Mode par defaut. |
| `Alt + S` | **Stack** (pile) | Un seul terminal visible a la fois. Naviguer entre les terminaux avec Alt+J / Alt+K. |
| `Alt + H` | **Split Horizontal** | Tous les terminaux sont disposes cote a cote horizontalement. |
| `Alt + V` | **Split Vertical** | Tous les terminaux sont empiles verticalement. |
| `Alt + M` | **Master + Stack** | Un terminal principal occupe 60% de l'espace a gauche, les autres sont empiles a droite (40%). |

## Navigation entre terminaux

Ces raccourcis permettent de naviguer entre les terminaux dans les modes **Stack** et **Master+Stack** :

| Raccourci | Action |
|-----------|--------|
| `Alt + J` | Passer au terminal suivant |
| `Alt + K` | Passer au terminal precedent |

En mode **Master+Stack**, le terminal selectionne via Alt+J/K devient le terminal principal (panneau gauche, 60%).

## Raccourcis internes au terminal (Linux)

| Raccourci | Action |
|-----------|--------|
| `Tab` | Auto-completion des commandes et chemins |
| `Entree` | Executer la commande |
| `Fleche Haut` | Commande precedente dans l'historique |
| `Fleche Bas` | Commande suivante dans l'historique |
| `Ctrl + C` | Interrompre / annuler la saisie |
| `Ctrl + L` | Effacer l'ecran du terminal |
| `Ctrl + A` | Deplacer le curseur au debut de la ligne |
| `Ctrl + E` | Deplacer le curseur a la fin de la ligne |
| `Ctrl + U` | Effacer du debut de la ligne jusqu'au curseur |

## Boutons de controle de fenetre

Chaque tuile de terminal dispose de boutons dans sa barre de titre :

- **Minimiser** (icone `-`) : Reduit le terminal dans la barre des taches en bas de l'ecran. Cliquer sur l'entree dans la barre des taches pour le restaurer.
- **Fermer** (icone `X`) : Ferme definitivement le terminal et reinitialise la session.

## Barre des taches (taskbar)

La barre des taches en bas de l'ecran affiche tous les terminaux ouverts. Elle permet de :

- Cliquer sur un terminal minimise pour le restaurer
- Cliquer sur un terminal visible pour le minimiser
- Fermer un terminal via le bouton `X`
- Changer de mode de disposition via les boutons de layout

## Notes

- Les raccourcis de disposition (`Alt + G/S/H/V/M`) ne sont actifs que lorsqu'au moins un terminal est visible.
- Le contenu des terminaux (historique des commandes et sorties) est preserve lors des changements de disposition et des operations de minimisation/restauration.
- Fermer un terminal reinitialise son etat (repertoire courant, session su, etc.).
