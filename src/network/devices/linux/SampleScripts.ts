/**
 * Sample bash scripts pre-loaded in /home/scripts/ for user practice.
 *
 * Each script is a [filename, content, permissions] tuple.
 * All files are owned by root:root. Users can copy them, modify them, etc.
 */

export interface SampleScript {
  name: string;
  content: string;
  perms: number;
}

export const SAMPLE_SCRIPTS: SampleScript[] = [

  // ─── 01. Basics ───────────────────────────────────────────────

  {
    name: '01_hello.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Premier script : Hello World
# Usage: ./01_hello.sh [nom]

echo "=== Mon premier script bash ==="
echo "Hello, World!"
echo ""

# Variables
NOM=\${1:-"Utilisateur"}
echo "Bonjour, $NOM !"
echo "Nous sommes le $(date)"
echo "Vous etes connecte en tant que: $(whoami)"
echo "Repertoire courant: $(pwd)"
`,
  },

  {
    name: '02_variables.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Variables et types de substitution
# Usage: ./02_variables.sh arg1 arg2 arg3

echo "=== Variables et Substitutions ==="

# Variables simples
PRENOM="Jean"
NOM="Dupont"
AGE=25
echo "Nom complet: $PRENOM $NOM, age: $AGE"

# Variables speciales
echo ""
echo "--- Variables speciales ---"
echo "Nom du script: $0"
echo "Nombre d'arguments: $#"
echo "Tous les arguments: $@"
echo "Premier argument: \${1:-aucun}"
echo "Deuxieme argument: \${2:-aucun}"
echo "PID du script: $$"
echo "Code retour precedent: $?"

# Substitution de commandes
echo ""
echo "--- Substitution de commandes ---"
FICHIERS=$(ls /)
echo "Contenu de /: $FICHIERS"

# Arithmetique
echo ""
echo "--- Arithmetique ---"
A=10
B=3
echo "$A + $B = $((A + B))"
echo "$A - $B = $((A - B))"
echo "$A * $B = $((A * B))"
echo "$A / $B = $((A / B))"
echo "$A % $B = $((A % B))"

# Expansion de parametres
echo ""
echo "--- Expansion de parametres ---"
VAR=""
echo "VAR vide, defaut: \${VAR:-valeur_defaut}"
echo "\${VAR:-valeur_defaut} = \${VAR:-valeur_defaut}"
unset VAR
echo "VAR non definie, assigner: \${VAR:=nouvelle_valeur}"
echo "\${VAR:=nouvelle_valeur} -> VAR=$VAR"
TEXTE="Hello World"
echo "Longueur de TEXTE: \${#TEXTE} = \${#TEXTE}"
`,
  },

  // ─── 02. Conditions ───────────────────────────────────────────

  {
    name: '03_conditions.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Structures conditionnelles
# Usage: ./03_conditions.sh <nombre>

echo "=== Structures Conditionnelles ==="

NOMBRE=\${1:-0}

# if / elif / else
echo ""
echo "--- if / elif / else ---"
if [ $NOMBRE -gt 0 ]; then
  echo "$NOMBRE est positif"
elif [ $NOMBRE -lt 0 ]; then
  echo "$NOMBRE est negatif"
else
  echo "$NOMBRE est zero"
fi

# Comparaisons de chaines
echo ""
echo "--- Comparaisons de chaines ---"
CHAINE="hello"
if [ "$CHAINE" = "hello" ]; then
  echo "'$CHAINE' est egal a 'hello'"
fi

if [ -n "$CHAINE" ]; then
  echo "'$CHAINE' n'est pas vide"
fi

VIDE=""
if [ -z "$VIDE" ]; then
  echo "La variable VIDE est vide"
fi

# Tests sur les fichiers
echo ""
echo "--- Tests sur les fichiers ---"
if [ -f "/etc/hostname" ]; then
  echo "/etc/hostname existe (fichier regulier)"
fi

if [ -d "/tmp" ]; then
  echo "/tmp existe (repertoire)"
fi

if [ ! -f "/fichier_inexistant" ]; then
  echo "/fichier_inexistant n'existe pas"
fi

# Operateurs logiques
echo ""
echo "--- Operateurs logiques ---"
A=5
B=10
if [ $A -lt $B ] && [ $B -lt 20 ]; then
  echo "$A < $B ET $B < 20"
fi

if [ $A -gt 100 ] || [ $B -gt 5 ]; then
  echo "$A > 100 OU $B > 5 (au moins une condition vraie)"
fi
`,
  },

  {
    name: '04_case.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Instruction case/esac
# Usage: ./04_case.sh <commande>

echo "=== Instruction case ==="

COMMANDE=\${1:-help}

case $COMMANDE in
  start)
    echo "Demarrage du service..."
    echo "Service demarre avec succes"
    ;;
  stop)
    echo "Arret du service..."
    echo "Service arrete"
    ;;
  restart)
    echo "Redemarrage du service..."
    echo "Service redemarre"
    ;;
  status)
    echo "Service: actif (running)"
    echo "PID: $$"
    ;;
  help|--help|-h)
    echo "Usage: $0 {start|stop|restart|status|help}"
    echo ""
    echo "Commandes disponibles:"
    echo "  start    - Demarrer le service"
    echo "  stop     - Arreter le service"
    echo "  restart  - Redemarrer le service"
    echo "  status   - Afficher le statut"
    echo "  help     - Afficher cette aide"
    ;;
  *)
    echo "Erreur: commande '$COMMANDE' inconnue"
    echo "Tapez '$0 help' pour l'aide"
    exit 1
    ;;
esac
`,
  },

  // ─���─ 03. Boucles ──────────────────────────────────────────────

  {
    name: '05_boucles.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Boucles for, while, until
# Usage: ./05_boucles.sh

echo "=== Boucles ==="

# for avec liste
echo "--- for avec liste ---"
for fruit in pomme banane orange kiwi; do
  echo "Fruit: $fruit"
done

# for avec sequence
echo ""
echo "--- for avec sequence ---"
for i in 1 2 3 4 5; do
  echo -n "$i "
done
echo ""

# for sur les fichiers
echo ""
echo "--- for sur les fichiers de /etc ---"
COUNT=0
for f in /etc/hostname /etc/shells /etc/sudoers; do
  if [ -f "$f" ]; then
    echo "  Fichier trouve: $f"
    COUNT=$((COUNT + 1))
  fi
done
echo "Total: $COUNT fichiers trouves"

# while
echo ""
echo "--- while ---"
COMPTEUR=1
while [ $COMPTEUR -le 5 ]; do
  echo "Compteur: $COMPTEUR"
  COMPTEUR=$((COMPTEUR + 1))
done

# until
echo ""
echo "--- until ---"
N=10
until [ $N -le 0 ]; do
  echo -n "$N "
  N=$((N - 2))
done
echo "Decollage!"

# break et continue
echo ""
echo "--- break et continue ---"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [ $i -eq 3 ]; then
    echo "  (skip $i)"
    continue
  fi
  if [ $i -eq 7 ]; then
    echo "  (stop a $i)"
    break
  fi
  echo "  Iteration: $i"
done
`,
  },

  // ─── 04. Fonctions ────────────────────────────────────────────

  {
    name: '06_fonctions.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Fonctions
# Usage: ./06_fonctions.sh

echo "=== Fonctions ==="

# Fonction simple
saluer() {
  echo "Bonjour, $1 !"
}

# Fonction avec return
est_pair() {
  if [ $(($1 % 2)) -eq 0 ]; then
    return 0
  else
    return 1
  fi
}

# Fonction avec sortie capturee
calculer() {
  local A=$1
  local OP=$2
  local B=$3
  case $OP in
    +) echo $((A + B)) ;;
    -) echo $((A - B)) ;;
    x) echo $((A * B)) ;;
    /) echo $((A / B)) ;;
    *) echo "Erreur: operateur inconnu" ;;
  esac
}

# Fonction recursive (factorielle)
factorielle() {
  local N=$1
  if [ $N -le 1 ]; then
    echo 1
  else
    local SOUS=$(factorielle $((N - 1)))
    echo $((N * SOUS))
  fi
}

# Utilisation
echo "--- Appels de fonctions ---"
saluer "Alice"
saluer "Bob"

echo ""
echo "--- Return et code de sortie ---"
for NUM in 2 3 4 5; do
  if est_pair $NUM; then
    echo "$NUM est pair"
  else
    echo "$NUM est impair"
  fi
done

echo ""
echo "--- Capture de sortie ---"
RESULTAT=$(calculer 15 + 27)
echo "15 + 27 = $RESULTAT"
RESULTAT=$(calculer 100 - 37)
echo "100 - 37 = $RESULTAT"
RESULTAT=$(calculer 6 x 7)
echo "6 x 7 = $RESULTAT"

echo ""
echo "--- Recursion ---"
for N in 1 2 3 4 5 6; do
  F=$(factorielle $N)
  echo "$N! = $F"
done
`,
  },

  // ─── 05. Traitement de texte ──────────────────────────────────

  {
    name: '07_texte.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Traitement de texte avec commandes Unix
# Usage: ./07_texte.sh

echo "=== Traitement de texte ==="

# Creer un fichier de donnees
cat > /tmp/employes.txt << 'HEREDOC'
Jean:Dupont:Ingenieur:45000
Marie:Martin:Manager:55000
Pierre:Durand:Developpeur:42000
Sophie:Bernard:Ingenieur:47000
Luc:Petit:Manager:58000
Anne:Robert:Developpeur:44000
Paul:Richard:Ingenieur:46000
HEREDOC

echo "Fichier cree: /tmp/employes.txt"
echo ""

# Afficher le fichier
echo "--- Contenu du fichier ---"
cat /tmp/employes.txt

# Compter les lignes
echo ""
echo "--- Statistiques ---"
LIGNES=$(wc -l /tmp/employes.txt)
echo "Nombre de lignes: $LIGNES"

# Filtrer avec grep
echo ""
echo "--- Ingenieurs (grep) ---"
grep "Ingenieur" /tmp/employes.txt

# Trier
echo ""
echo "--- Tri par nom (sort) ---"
sort /tmp/employes.txt

# Extraire des colonnes avec cut
echo ""
echo "--- Prenoms (cut) ---"
cut -d: -f1 /tmp/employes.txt

# Compter les occurrences
echo ""
echo "--- Postes (sort | uniq -c) ---"
cut -d: -f3 /tmp/employes.txt | sort | uniq

# Nettoyage
rm /tmp/employes.txt
echo ""
echo "Fichier temporaire supprime."
`,
  },

  // ─── 06. Gestion d'erreurs ────────────────────────────────────

  {
    name: '08_erreurs.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Gestion d'erreurs et codes de retour
# Usage: ./08_erreurs.sh

echo "=== Gestion d'erreurs ==="

# Verifier le code de retour
echo "--- Codes de retour ---"
ls /etc/hostname > /dev/null
echo "ls /etc/hostname -> code: $?"

ls /fichier_inexistant 2> /dev/null
echo "ls /fichier_inexistant -> code: $?"

# Operateur && (si succes)
echo ""
echo "--- Operateur && ---"
echo "Test reussi" && echo "Commande suivante executee"
false && echo "Ceci ne s'affiche pas"
echo "(la ligne precedente n'a pas ete affichee)"

# Operateur || (si echec)
echo ""
echo "--- Operateur || ---"
false || echo "Fallback: la premiere commande a echoue"
true || echo "Ceci ne s'affiche pas"

# Combinaison && et ||
echo ""
echo "--- Combinaison && || ---"
test -f /etc/hostname && echo "/etc/hostname existe" || echo "/etc/hostname n'existe pas"
test -f /inexistant && echo "/inexistant existe" || echo "/inexistant n'existe pas"

# Fonction avec gestion d'erreur
verifier_fichier() {
  local FICHIER=$1
  if [ -f "$FICHIER" ]; then
    echo "OK: $FICHIER existe"
    return 0
  else
    echo "ERREUR: $FICHIER non trouve"
    return 1
  fi
}

echo ""
echo "--- Fonction de verification ---"
verifier_fichier "/etc/hostname"
verifier_fichier "/etc/shells"
verifier_fichier "/opt/inexistant.conf"
`,
  },

  // ─── 07. Script systeme ───────────────────────────────────────

  {
    name: '09_sysinfo.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Script d'information systeme
# Usage: ./09_sysinfo.sh

echo "============================================"
echo "       RAPPORT SYSTEME"
echo "============================================"
echo ""

# Informations utilisateur
echo "--- Utilisateur ---"
echo "Utilisateur: $(whoami)"
echo "UID: $UID"
echo "Home: $HOME"
echo "Shell: $SHELL"
echo ""

# Systeme de fichiers
echo "--- Systeme de fichiers ---"
echo "Repertoire courant: $(pwd)"
echo ""
echo "Repertoires principaux:"
for DIR in /etc /home /tmp /var /root; do
  if [ -d "$DIR" ]; then
    echo "  $DIR [existe]"
  else
    echo "  $DIR [absent]"
  fi
done
echo ""

# Reseau
echo "--- Reseau ---"
echo "Hostname: $(cat /etc/hostname)"
echo ""

# Fichiers de config
echo "--- Configuration ---"
echo "Shells disponibles:"
cat /etc/shells
echo ""

echo "============================================"
echo "      Fin du rapport"
echo "============================================"
`,
  },

  // ─── 08. Script avance ────────────────────────────────────────

  {
    name: '10_menu.sh',
    perms: 0o755,
    content: `#!/bin/bash
# Menu interactif simule
# Usage: ./10_menu.sh <choix>

echo "==============================="
echo "    MENU PRINCIPAL"
echo "==============================="
echo "  1. Informations systeme"
echo "  2. Lister les fichiers"
echo "  3. Afficher la date"
echo "  4. Creer un fichier"
echo "  5. Quitter"
echo "==============================="

CHOIX=\${1:-5}
echo "Choix: $CHOIX"
echo ""

case $CHOIX in
  1)
    echo "--- Informations systeme ---"
    echo "Utilisateur: $(whoami)"
    echo "Repertoire: $(pwd)"
    echo "PID: $$"
    ;;
  2)
    echo "--- Fichiers dans / ---"
    ls /
    ;;
  3)
    echo "--- Date et heure ---"
    echo "Nous sommes le $(date)"
    ;;
  4)
    echo "--- Creation de fichier ---"
    echo "Fichier de test cree le $(date)" > /tmp/menu_test.txt
    echo "Fichier /tmp/menu_test.txt cree"
    cat /tmp/menu_test.txt
    ;;
  5)
    echo "Au revoir !"
    exit 0
    ;;
  *)
    echo "Erreur: choix invalide '$CHOIX'"
    echo "Veuillez choisir entre 1 et 5"
    exit 1
    ;;
esac
`,
  },

  // ─── README ───────────────────────────────────────────────────

  {
    name: 'README.txt',
    perms: 0o644,
    content: `===================================
  Scripts Bash - Exercices
===================================

Liste des scripts disponibles:

01_hello.sh       - Premier script, variables de base
02_variables.sh   - Variables, substitutions, arithmetique
03_conditions.sh  - if/elif/else, tests, operateurs logiques
04_case.sh        - Instruction case/esac
05_boucles.sh     - Boucles for, while, until, break, continue
06_fonctions.sh   - Fonctions, return, recursion
07_texte.sh       - Traitement de texte (grep, sort, cut, uniq)
08_erreurs.sh     - Gestion d'erreurs, codes de retour, && ||
09_sysinfo.sh     - Script systeme complet
10_menu.sh        - Menu interactif avec case

Comment utiliser:
  cd /home/scripts
  ls                    # lister les scripts
  cat 01_hello.sh       # lire le code source
  ./01_hello.sh         # executer le script
  ./01_hello.sh Alice   # avec un argument

Conseils:
  - Lisez le code source AVANT d'executer
  - Modifiez les scripts pour experimenter
  - Combinez les techniques entre elles
`,
  },
];
