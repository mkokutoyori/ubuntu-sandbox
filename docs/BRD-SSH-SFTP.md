# BRD — Implémentation SSH & Refonte SFTP (Simulateur)

**Version** : 1.0
**Date** : 2026-05-05
**Projet** : Ubuntu Sandbox — Module SSH/SFTP
**Auteur** : Claude Code

---

## Table des matières

1. [Introduction et Contexte](#1-introduction-et-contexte)
2. [Analyse de l'État Actuel — Défaillances SFTP](#2-analyse-de-létat-actuel--défaillances-sftp)
3. [Périmètre et Objectifs](#3-périmètre-et-objectifs)
4. [Requirements SSH](#4-requirements-ssh)
5. [Requirements SFTP — Refonte](#5-requirements-sftp--refonte)
6. [Plan d'Implémentation](#6-plan-dimplémentation)
7. [Contraintes Techniques et NFR](#7-contraintes-techniques-et-nfr)

---

## 1. Introduction et Contexte

### 1.1 Contexte du projet

Ubuntu Sandbox est un simulateur réseau en navigateur (React + TypeScript) dans lequel les utilisateurs connectent des équipements virtuels (routeurs, switchs, PCs Linux/Windows, serveurs) et interagissent via des émulateurs de terminaux reproduisant Cisco IOS, Huawei VRP, Linux bash et Windows cmd/PowerShell.

L'objectif du simulateur est le **réalisme comportemental** : un utilisateur formé sur le simulateur doit pouvoir opérer sur un vrai équipement sans surprise. Cela inclut les messages d'erreur, les séquences de commandes, les comportements aux limites, et les protocoles réseau simulés.

### 1.2 État actuel du module SFTP

Un module SFTP a été implémenté et couvre les opérations de base (connect, ls, cd, get, put, mkdir, rm, rmdir, rename). Il est fonctionnel pour les scénarios simples mais repose sur une **architecture fondamentalement incorrecte** : JSON brut sur TCP port 22, sans couche SSH, sans chiffrement, sans négociation de protocole.

Cette approche suffisait pour une première itération, mais elle crée des divergences comportementales visibles par l'utilisateur et bloque l'extension vers SSH interactif (remote shell, SCP, port forwarding).

### 1.3 Motivation de ce BRD

Ce document formalise :
- Les **défauts et limitations de l'implémentation SFTP actuelle** à corriger
- Les **requirements pour un protocole SSH simulé** réaliste
- La **refonte du protocole SFTP** pour qu'il tourne sur la couche SSH simulée
- Le **plan d'implémentation** en phases livrables

### 1.4 Références

| Référence | Description |
|---|---|
| RFC 4251 | SSH Protocol Architecture |
| RFC 4252 | SSH Authentication Protocol |
| RFC 4253 | SSH Transport Layer Protocol |
| RFC 4254 | SSH Connection Protocol |
| draft-ietf-secsh-filexfer-02 | SFTP version 3 (implémentation de référence OpenSSH) |
| draft-ietf-secsh-filexfer-13 | SFTP version 6 (extensions modernes) |
| `man sftp(1)` OpenSSH 9.x | Comportement de référence de la CLI sftp |
| `man sshd_config(5)` | Comportement de référence du serveur SSH |

---
