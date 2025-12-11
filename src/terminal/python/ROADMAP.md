# Python Simulator - Roadmap

## Overview
Simulateur Python intégré au terminal Ubuntu. Permet d'exécuter du code Python directement dans le navigateur.

---

## Phase 1: Core Infrastructure

### 1.1 Lexer/Tokenizer
- [ ] Tokenisation des mots-clés Python
- [ ] Reconnaissance des littéraux (nombres, strings, booleans)
- [ ] Gestion des opérateurs
- [ ] Gestion des délimiteurs (parenthèses, crochets, accolades)
- [ ] Gestion de l'indentation
- [ ] Commentaires (#)

### 1.2 Parser (AST)
- [ ] Expressions arithmétiques
- [ ] Expressions de comparaison
- [ ] Expressions logiques
- [ ] Assignations
- [ ] Appels de fonctions
- [ ] Structures de contrôle
- [ ] Définitions de fonctions/classes

### 1.3 Interpreter
- [ ] Évaluation des expressions
- [ ] Gestion des variables (scope)
- [ ] Exécution des statements
- [ ] Gestion des erreurs Python

---

## Phase 2: Types de Données

### 2.1 Types Primitifs
- [ ] `int` - Entiers
- [ ] `float` - Nombres décimaux
- [ ] `str` - Chaînes de caractères
- [ ] `bool` - True/False
- [ ] `None` - Valeur nulle

### 2.2 Collections
- [ ] `list` - Listes mutables
- [ ] `tuple` - Tuples immutables
- [ ] `dict` - Dictionnaires
- [ ] `set` - Ensembles

### 2.3 Opérations sur les Types
- [ ] Slicing `[start:end:step]`
- [ ] Indexation `[index]`
- [ ] Membership `in`, `not in`
- [ ] Concaténation `+`
- [ ] Répétition `*`

---

## Phase 3: Opérateurs

### 3.1 Opérateurs Arithmétiques
- [ ] Addition `+`
- [ ] Soustraction `-`
- [ ] Multiplication `*`
- [ ] Division `/`
- [ ] Division entière `//`
- [ ] Modulo `%`
- [ ] Puissance `**`
- [ ] Négation unaire `-x`

### 3.2 Opérateurs de Comparaison
- [ ] Égalité `==`
- [ ] Inégalité `!=`
- [ ] Inférieur `<`
- [ ] Supérieur `>`
- [ ] Inférieur ou égal `<=`
- [ ] Supérieur ou égal `>=`

### 3.3 Opérateurs Logiques
- [ ] Et logique `and`
- [ ] Ou logique `or`
- [ ] Négation `not`

### 3.4 Opérateurs d'Assignation
- [ ] Assignation `=`
- [ ] Assignation augmentée `+=`, `-=`, `*=`, `/=`, etc.
- [ ] Assignation multiple `a, b = 1, 2`

---

## Phase 4: Structures de Contrôle

### 4.1 Conditions
- [ ] `if` statement
- [ ] `elif` clause
- [ ] `else` clause
- [ ] Opérateur ternaire `x if condition else y`

### 4.2 Boucles
- [ ] `for` loop
- [ ] `while` loop
- [ ] `break` statement
- [ ] `continue` statement
- [ ] `else` clause sur boucles

### 4.3 Compréhensions
- [ ] List comprehension `[x for x in ...]`
- [ ] Dict comprehension `{k: v for k, v in ...}`
- [ ] Set comprehension `{x for x in ...}`
- [ ] Generator expression `(x for x in ...)`

---

## Phase 5: Fonctions

### 5.1 Définition et Appel
- [ ] `def` keyword
- [ ] Paramètres positionnels
- [ ] Paramètres par défaut
- [ ] `*args` et `**kwargs`
- [ ] `return` statement
- [ ] Fonctions récursives

### 5.2 Fonctions Lambda
- [ ] `lambda` expressions

### 5.3 Scope
- [ ] Variables locales
- [ ] Variables globales (`global`)
- [ ] Variables nonlocal (`nonlocal`)
- [ ] Closures

---

## Phase 6: Fonctions Built-in

### 6.1 I/O
- [ ] `print()` - Affichage
- [ ] `input()` - Entrée utilisateur

### 6.2 Type Conversion
- [ ] `int()`, `float()`, `str()`, `bool()`
- [ ] `list()`, `tuple()`, `dict()`, `set()`

### 6.3 Séquences
- [ ] `len()` - Longueur
- [ ] `range()` - Génération de séquences
- [ ] `enumerate()` - Énumération
- [ ] `zip()` - Combinaison
- [ ] `sorted()` - Tri
- [ ] `reversed()` - Inversion
- [ ] `min()`, `max()`, `sum()`

### 6.4 Autres
- [ ] `type()` - Type d'un objet
- [ ] `isinstance()` - Vérification de type
- [ ] `abs()` - Valeur absolue
- [ ] `round()` - Arrondi
- [ ] `pow()` - Puissance
- [ ] `help()` - Aide
- [ ] `dir()` - Attributs
- [ ] `id()` - Identifiant
- [ ] `hash()` - Hash
- [ ] `callable()` - Vérification callable
- [ ] `map()`, `filter()`, `reduce()`
- [ ] `any()`, `all()`
- [ ] `ord()`, `chr()`
- [ ] `hex()`, `bin()`, `oct()`
- [ ] `format()`
- [ ] `open()` - Fichiers (simulé)

---

## Phase 7: Méthodes des Types

### 7.1 String Methods
- [ ] `.upper()`, `.lower()`, `.capitalize()`, `.title()`
- [ ] `.strip()`, `.lstrip()`, `.rstrip()`
- [ ] `.split()`, `.join()`
- [ ] `.replace()`, `.find()`, `.index()`
- [ ] `.startswith()`, `.endswith()`
- [ ] `.isdigit()`, `.isalpha()`, `.isalnum()`
- [ ] `.format()`, f-strings
- [ ] `.count()`, `.center()`, `.zfill()`

### 7.2 List Methods
- [ ] `.append()`, `.extend()`, `.insert()`
- [ ] `.remove()`, `.pop()`, `.clear()`
- [ ] `.index()`, `.count()`
- [ ] `.sort()`, `.reverse()`
- [ ] `.copy()`

### 7.3 Dict Methods
- [ ] `.keys()`, `.values()`, `.items()`
- [ ] `.get()`, `.setdefault()`
- [ ] `.update()`, `.pop()`, `.clear()`
- [ ] `.copy()`

### 7.4 Set Methods
- [ ] `.add()`, `.remove()`, `.discard()`
- [ ] `.union()`, `.intersection()`, `.difference()`
- [ ] `.issubset()`, `.issuperset()`

---

## Phase 8: Classes et OOP

### 8.1 Définition de Classes
- [ ] `class` keyword
- [ ] `__init__` constructor
- [ ] `self` reference
- [ ] Attributs d'instance
- [ ] Attributs de classe

### 8.2 Méthodes
- [ ] Méthodes d'instance
- [ ] `@staticmethod`
- [ ] `@classmethod`
- [ ] `@property`

### 8.3 Héritage
- [ ] Héritage simple
- [ ] `super()` function
- [ ] Method overriding

### 8.4 Méthodes Spéciales
- [ ] `__str__`, `__repr__`
- [ ] `__len__`, `__getitem__`, `__setitem__`
- [ ] `__add__`, `__sub__`, `__mul__`, etc.
- [ ] `__eq__`, `__lt__`, `__gt__`, etc.
- [ ] `__iter__`, `__next__`

---

## Phase 9: Gestion des Erreurs

### 9.1 Exceptions
- [ ] `try` / `except`
- [ ] `else` clause
- [ ] `finally` clause
- [ ] `raise` statement

### 9.2 Types d'Exceptions
- [ ] `SyntaxError`
- [ ] `NameError`
- [ ] `TypeError`
- [ ] `ValueError`
- [ ] `IndexError`
- [ ] `KeyError`
- [ ] `ZeroDivisionError`
- [ ] `AttributeError`
- [ ] `ImportError`

---

## Phase 10: Modules et Imports

### 10.1 Import Syntax
- [ ] `import module`
- [ ] `from module import name`
- [ ] `import module as alias`
- [ ] `from module import *`

### 10.2 Modules Simulés
- [ ] `math` - Fonctions mathématiques
- [ ] `random` - Génération aléatoire
- [ ] `datetime` - Date et heure
- [ ] `json` - JSON parsing
- [ ] `re` - Expressions régulières (basique)
- [ ] `os` - Opérations système (simulé)
- [ ] `sys` - Informations système
- [ ] `collections` - Types de collections
- [ ] `itertools` - Outils d'itération
- [ ] `functools` - Outils fonctionnels
- [ ] `string` - Constantes de chaînes

---

## Phase 11: Fonctionnalités Avancées

### 11.1 Décorateurs
- [ ] Syntaxe `@decorator`
- [ ] Décorateurs avec arguments
- [ ] Décorateurs multiples

### 11.2 Générateurs
- [ ] `yield` keyword
- [ ] Generator functions
- [ ] `yield from`

### 11.3 Context Managers
- [ ] `with` statement
- [ ] `__enter__`, `__exit__`

### 11.4 Autres
- [ ] `assert` statement
- [ ] `pass` statement
- [ ] `del` statement
- [ ] Unpacking `*` et `**`
- [ ] Walrus operator `:=`

---

## Phase 12: REPL et Intégration

### 12.1 Mode Interactif
- [ ] Prompt `>>>` et `...`
- [ ] Historique des commandes
- [ ] Multi-line input
- [ ] Auto-completion

### 12.2 Exécution de Fichiers
- [ ] `python script.py`
- [ ] `python -c "code"`
- [ ] `python -m module`

### 12.3 Intégration Terminal
- [ ] Commande `python` / `python3`
- [ ] Exit avec `exit()` ou `quit()`
- [ ] Ctrl+D pour sortir
- [ ] Affichage des résultats

---

## Structure des Fichiers

```
src/terminal/python/
├── ROADMAP.md           # Ce fichier
├── index.ts             # Point d'entrée
├── lexer.ts             # Tokenizer
├── parser.ts            # AST Parser
├── interpreter.ts       # Évaluateur
├── types.ts             # Types Python
├── scope.ts             # Gestion des scopes
├── errors.ts            # Erreurs Python
├── builtins/
│   ├── index.ts         # Export des builtins
│   ├── functions.ts     # Fonctions built-in
│   ├── types.ts         # Types built-in
│   └── methods.ts       # Méthodes des types
└── modules/
    ├── index.ts         # Registry des modules
    ├── math.ts          # Module math
    ├── random.ts        # Module random
    ├── datetime.ts      # Module datetime
    └── ...
```

---

## Priorités d'Implémentation

1. **P0 - MVP** : Lexer, Parser, Interpreter basique, types primitifs, opérateurs, print()
2. **P1 - Core** : Variables, if/else, for/while, fonctions, listes
3. **P2 - Extended** : Classes, exceptions, modules math/random
4. **P3 - Complete** : Toutes les autres fonctionnalités
