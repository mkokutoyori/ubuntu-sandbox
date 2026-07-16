#!/usr/bin/env python3
"""
generate_command.py — Générateur de commandes pour le socle command-kernel.

Objectif
--------
Accélérer la migration décrite dans `.claude/skills/command-kernel-migration/`
et `migration_framework.md` : au lieu d'écrire à la main le boilerplate d'une
nouvelle commande (descripteur, imports, accès MachineApi, enregistrement
dans le bootstrap, stub de test), on décrit la commande en ligne de commande
(ou via un fichier JSON) et le script génère :

  1. Le fichier TypeScript de la commande, au bon endroit, avec le bon
     `CommandDescriptor` (args/options typés, privilèges, catégorie), les
     bons imports (alias `@/command-kernel/...` pour le socle, chemin
     relatif calculé pour la MachineApi de la cible).
  2. (optionnel, --register) La ligne d'enregistrement + l'import de la
     classe dans le fichier bootstrap de la cible (ex: createSqlPlusKernel.ts,
     createCiscoRouterHostShell.ts…), insérée après une ancre identifiée.
  3. (optionnel, --with-test) Un stub `it(...)` ajouté dans le fichier de
     test de fondation de la cible, avec un TODO à compléter.

Le script ne remplace JAMAIS le jugement humain (ou de Claude) sur le
contenu métier de `execute()` — il pose les fondations strictement
conformes à l'architecture (BaseCommand, PrivilegePolicy embarquée,
ctx.machine comme seule source, pas de fallback legacy) et laisse un
squelette à compléter, marqué de commentaires `// TODO`.

Usage rapide
------------
    python3 scripts/generate_command.py list-targets
    python3 scripts/generate_command.py new --target oracle-sqlplus --name COLUMN \\
        --summary "Définit un format de colonne" --usage "COLUMN <col> [FORMAT fmt]" \\
        --arg "name=col|type=string|required=true|description=Nom de colonne" \\
        --arg "name=rest|type=string|variadic=true|description=options FORMAT/HEADING…" \\
        --register --with-test
    python3 scripts/generate_command.py new --help
    python3 scripts/generate_command.py batch specs.json

Voir `list-targets` pour la liste des cibles connues et leurs conventions,
et la section « Étendre le registre de cibles » plus bas pour en ajouter une
nouvelle sans casser l'existant (le tout est conçu pour être enrichi, jamais
réécrit — même philosophie que le socle command-kernel lui-même).
"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent

# ===========================================================================
# 1. Constantes du socle (miroir de src/command-kernel/args/types.ts et
#    session/types.ts — à tenir synchronisé si le socle évolue)
# ===========================================================================

ARG_TYPES = {"string", "int", "float", "boolean", "path"}
PRIVILEGE_LEVELS = {"ANY", "AUTHENTICATED", "OPERATOR", "ROOT"}
KINDS = {"leaf", "composite", "push-mode", "pop-mode", "end-mode", "streaming"}

# Convention observée dans le dépôt : const ANY/AUTH/OP/ROOT = new
# DefaultPrivilegePolicy(PrivilegeLevel.X). Garder ces noms courts.
PRIVILEGE_CONST_NAMES = {
    "ANY": "ANY",
    "AUTHENTICATED": "AUTH",
    "OPERATOR": "OP",
    "ROOT": "ROOT",
}

TS_RUNTIME_TYPE = {
    "string": "string",
    "int": "number",
    "float": "number",
    "boolean": "boolean",
    "path": "string",
}


# ===========================================================================
# 2. Registre des cibles connues
# ===========================================================================
#
# Étendre le registre de cibles
# ------------------------------
# Une cible = une famille de shell/vendeur déjà branchée sur le socle
# command-kernel (voir CLAUDE.md § Network simulation layer). Pour migrer un
# NOUVEAU shell qui n'a pas encore de socle du tout, suit d'abord
# `command-kernel-migration` (étapes 1-3) pour construire la MachineApi et le
# bootstrap — CE script sert à partir de l'étape 4 (générer les commandes),
# une fois qu'une entrée peut être ajoutée ici. Ajouter une entrée est un
# simple ajout de dictionnaire, jamais une modification des entrées
# existantes.
#
# uses_modes       : True pour un CLI vendeur à modes hiérarchiques (Cisco
#                    IOS, Huawei VRP) — active --kind push-mode/pop-mode/
#                    end-mode/composite (subRegistry) et --allowed-modes.
#                    False pour un shell POSIX/plat (Interpreter simple) où
#                    seul --kind leaf/streaming a un sens (pas de subRegistry
#                    ni de modes : Executor ne sait pas les dispatcher).
# access_style     : comment une commande lit ctx.machine :
#                       "cast"       -> `const machine = ctx.machine as
#                                        <machine_api_type>;` puis
#                                        `machine.<capability_field>.…`
#                       "capability" -> `ctx.machine.<capability_field>!.…`
#                                        (capacité optionnelle dédiée sur le
#                                        MachineApi commun : oracle, sftp…)
#                       "direct"     -> capacités universelles déjà typées
#                                        sur MachineApi (fs/proc/net/users/
#                                        groups/power) — pas de cast requis,
#                                        mais le TODO généré rappelle les
#                                        capacités disponibles.
# auto_register_supported : False force --register à toujours se limiter à
#                    l'affichage d'instructions (jamais d'écriture auto) —
#                    utilisé pour les cibles à registres multiples (une
#                    cible CLI vendeur a un registre par mode + des
#                    sous-registres de composites ; deviner LEQUEL sans
#                    --insert-after explicite serait dangereux). Passer
#                    --insert-after à la commande `new` réactive l'insertion
#                    automatique même si ce champ est False (ancre fournie
#                    explicitement par l'appelant = plus de risque de
#                    deviner faux).


@dataclass(frozen=True)
class TargetConfig:
    key: str
    label: str
    commands_root: str
    class_prefix: str
    default_category: str
    uses_modes: bool
    access_style: str  # "cast" | "capability" | "direct"
    machine_api_module: Optional[str] = None  # chemin repo-relatif SANS extension
    machine_api_type: Optional[str] = None
    capability_field: Optional[str] = None
    bootstrap_file: Optional[str] = None
    auto_register_supported: bool = False
    foundation_test_file: Optional[str] = None
    default_privilege: str = "ANY"
    notes: str = ""


TARGETS: dict[str, TargetConfig] = {
    "oracle-sqlplus": TargetConfig(
        key="oracle-sqlplus",
        label="Oracle SQL*Plus (méta-commandes SET/SHOW/HELP/…)",
        commands_root="src/database/oracle/command-kernel/commands",
        class_prefix="SqlPlus",
        default_category="sqlplus",
        uses_modes=False,
        access_style="capability",
        capability_field="oracle",
        machine_api_type="OracleSqlPlusApi",
        bootstrap_file="src/database/oracle/command-kernel/createSqlPlusKernel.ts",
        auto_register_supported=True,
        foundation_test_file="src/__tests__/unit/command-kernel/sqlplus-cli-foundation.test.ts",
        notes=(
            "Grammaire à plat (pas de modes). Verbes reconnus un par un dans "
            "recognizeSqlPlusKernelVerb (createSqlPlusKernel.ts) — penser à y "
            "ajouter le nouveau verbe si ce n'est pas déjà fait."
        ),
    ),
    "sftp": TargetConfig(
        key="sftp",
        label="Sous-shell SFTP interactif",
        commands_root="src/network/protocols/ssh/sftp/command-kernel/commands",
        class_prefix="Sftp",
        default_category="sftp",
        uses_modes=False,
        access_style="capability",
        capability_field="sftp",
        machine_api_type="SftpChannelApi",
        bootstrap_file="src/network/protocols/ssh/sftp/command-kernel/createSftpShell.ts",
        auto_register_supported=True,
        notes="Grammaire à plat. ctx.machine.fs est le VFS LOCAL du client (le canal réel est ctx.machine.sftp!).",
    ),
    "linux": TargetConfig(
        key="linux",
        label="Linux (bash-like, Interpreter générique)",
        commands_root="src/network/devices/linux/command-kernel/commands",
        class_prefix="",
        default_category="linux",
        uses_modes=False,
        access_style="direct",
        machine_api_module="src/network/devices/linux/command-kernel/LinuxMachineApi",
        machine_api_type="LinuxMachineApi",
        bootstrap_file="src/network/devices/linux/command-kernel/createLinuxHostShell.ts",
        auto_register_supported=True,
        notes=(
            "Capacités universelles (fs/proc/net/users/groups/power) directement sur "
            "ctx.machine. Cast en LinuxMachineApi seulement pour une capacité "
            "spécifique (processControl, netProbe, sftpConnect, audit, logging, "
            "metrics, netstat, os, permissions)."
        ),
    ),
    "windows": TargetConfig(
        key="windows",
        label="Windows (cmd.exe, CmdInterpreter dédié)",
        commands_root="src/network/devices/windows/command-kernel/commands",
        class_prefix="",
        default_category="windows",
        uses_modes=False,
        access_style="direct",
        machine_api_module="src/network/devices/windows/command-kernel/WindowsMachineApi",
        machine_api_type="WindowsMachineApi",
        bootstrap_file="src/network/devices/windows/command-kernel/createWindowsHostShell.ts",
        auto_register_supported=True,
        notes=(
            "Grammaire cmd.exe : casse-insensitive, `\\\\` séparateur, wildcards par "
            "commande — géré par CmdInterpreter, jamais par la commande. Cast en "
            "WindowsMachineApi pour toute capacité au-delà de fs/proc/net/users/groups/power."
        ),
    ),
    "router-cisco": TargetConfig(
        key="router-cisco",
        label="Routeur Cisco IOS",
        commands_root="src/network/devices/router/command-kernel/commands/cisco",
        class_prefix="CiscoRouter",
        default_category="router",
        uses_modes=True,
        access_style="cast",
        machine_api_module="src/network/devices/router/command-kernel/RouterMachineApi",
        machine_api_type="RouterMachineApi",
        capability_field="router",
        bootstrap_file="src/network/devices/router/command-kernel/createCiscoRouterHostShell.ts",
        auto_register_supported=False,
        foundation_test_file="src/__tests__/unit/command-kernel/router-cli-foundation.test.ts",
        notes=(
            "Registres multiples (user/privileged/config/config-if/…) + sous-registres "
            "de composites (showSub…) : --register nécessite --insert-after explicite."
        ),
    ),
    "router-huawei": TargetConfig(
        key="router-huawei",
        label="Routeur Huawei VRP",
        commands_root="src/network/devices/router/command-kernel/commands/huawei",
        class_prefix="HuaweiRouter",
        default_category="router",
        uses_modes=True,
        access_style="cast",
        machine_api_module="src/network/devices/router/command-kernel/RouterMachineApi",
        machine_api_type="RouterMachineApi",
        capability_field="router",
        bootstrap_file="src/network/devices/router/command-kernel/createHuaweiRouterHostShell.ts",
        auto_register_supported=False,
        foundation_test_file="src/__tests__/unit/command-kernel/router-cli-foundation.test.ts",
        notes="Même RouterMachineApi que router-cisco (routeur = routeur, seul le CLI diffère).",
    ),
    "switch-cisco": TargetConfig(
        key="switch-cisco",
        label="Switch Cisco Catalyst",
        commands_root="src/network/devices/switch/command-kernel/commands/cisco",
        class_prefix="CiscoSwitch",
        default_category="switch",
        uses_modes=True,
        access_style="cast",
        machine_api_module="src/network/devices/switch/command-kernel/SwitchMachineApi",
        machine_api_type="SwitchMachineApi",
        capability_field="switch",
        bootstrap_file="src/network/devices/switch/command-kernel/createCiscoSwitchHostShell.ts",
        auto_register_supported=False,
        foundation_test_file="src/__tests__/unit/command-kernel/switch-cli-foundation.test.ts",
        notes="Registres multiples : --register nécessite --insert-after explicite.",
    ),
    "switch-huawei": TargetConfig(
        key="switch-huawei",
        label="Switch Huawei (VRP L2)",
        commands_root="src/network/devices/switch/command-kernel/commands/huawei",
        class_prefix="HuaweiSwitch",
        default_category="switch",
        uses_modes=True,
        access_style="cast",
        machine_api_module="src/network/devices/switch/command-kernel/SwitchMachineApi",
        machine_api_type="SwitchMachineApi",
        capability_field="switch",
        bootstrap_file="src/network/devices/switch/command-kernel/createHuaweiSwitchHostShell.ts",
        auto_register_supported=False,
        foundation_test_file="src/__tests__/unit/command-kernel/switch-cli-foundation.test.ts",
        notes="Même SwitchMachineApi que switch-cisco.",
    ),
}


def target_or_die(key: str) -> TargetConfig:
    if key not in TARGETS:
        known = ", ".join(sorted(TARGETS))
        raise SystemExit(f"cible inconnue : '{key}'. Cibles connues : {known}")
    return TARGETS[key]


# ===========================================================================
# 3. Modèle de données d'une commande à générer
# ===========================================================================


@dataclass
class ArgSpec:
    name: str
    type: str = "string"
    required: bool = False
    variadic: bool = False
    description: str = ""

    def __post_init__(self) -> None:
        if self.type not in ARG_TYPES:
            raise ValueError(f"type d'argument invalide '{self.type}' (attendu: {sorted(ARG_TYPES)})")
        if not self.name:
            raise ValueError("un argument doit avoir un 'name'")

    def to_ts(self) -> str:
        parts = [
            f"name: {ts_string(self.name)}",
            f"type: {ts_string(self.type)}",
            f"required: {ts_bool(self.required)}",
        ]
        if self.variadic:
            parts.append("variadic: true")
        parts.append(f"description: {ts_string(self.description)}")
        return "{ " + ", ".join(parts) + " }"

    def runtime_type(self) -> str:
        base = TS_RUNTIME_TYPE[self.type]
        if self.variadic:
            base = f"{base}[]"
        return base if self.required else f"{base} | undefined"


@dataclass
class OptionSpec:
    long: str
    short: Optional[str] = None
    takes_value: bool = True
    type: Optional[str] = None
    default: Optional[str] = None
    description: str = ""
    required_capability: Optional[str] = None
    numeric_shorthand: bool = False

    def __post_init__(self) -> None:
        if not self.long:
            raise ValueError("une option doit avoir un 'long'")
        if self.type and self.type not in ARG_TYPES:
            raise ValueError(f"type d'option invalide '{self.type}' (attendu: {sorted(ARG_TYPES)})")

    def to_ts(self) -> str:
        parts = [f"long: {ts_string(self.long)}"]
        if self.short:
            parts.append(f"short: {ts_string(self.short)}")
        parts.append(f"takesValue: {ts_bool(self.takes_value)}")
        if self.type:
            parts.append(f"type: {ts_string(self.type)}")
        if self.default is not None:
            parts.append(f"defaultValue: {ts_default_literal(self.default, self.type)}")
        parts.append(f"description: {ts_string(self.description)}")
        if self.required_capability:
            parts.append(f"requiredCapability: Capability.{self.required_capability}")
        if self.numeric_shorthand:
            parts.append("numericShorthand: true")
        return "{ " + ", ".join(parts) + " }"

    def runtime_type(self) -> str:
        if not self.takes_value:
            return "boolean"
        base = TS_RUNTIME_TYPE[self.type or "string"]
        return f"{base} | undefined"


@dataclass
class CommandSpec:
    target: str
    name: str
    kind: str = "leaf"
    class_name: str = ""
    summary: str = "TODO: résumé une ligne"
    usage: str = ""
    aliases: list[str] = field(default_factory=list)
    category: str = ""
    args: list[ArgSpec] = field(default_factory=list)
    options: list[OptionSpec] = field(default_factory=list)
    privilege_level: str = "ANY"
    required_groups: list[str] = field(default_factory=list)
    required_capabilities: list[str] = field(default_factory=list)
    allowed_modes: list[str] = field(default_factory=list)
    subdir: str = ""
    streaming: bool = False
    children: list[str] = field(default_factory=list)
    target_mode: Optional[str] = None
    incomplete_message: str = "% Incomplete command."

    @staticmethod
    def from_dict(d: dict) -> "CommandSpec":
        args = [build_arg_spec_from_dict(a) for a in d.get("args", [])]
        options = [build_option_spec_from_dict(o) for o in d.get("options", [])]
        known = {f.name for f in CommandSpec.__dataclass_fields__.values()}
        kwargs = {k: v for k, v in d.items() if k in known and k not in ("args", "options")}
        return CommandSpec(args=args, options=options, **kwargs)


# ===========================================================================
# 4. Petits utilitaires de rendu TypeScript
# ===========================================================================


def ts_escape_body(s: str) -> str:
    """Échappe `\\` et `'` sans toucher aux séquences d'échappement que
    l'appelant ajoute lui-même après coup (ex: un `\\n` littéral voulu dans
    le TS généré) — utiliser `ts_string()` pour une valeur complète, ceci
    pour composer un littéral avec du texte ajouté après l'échappement."""
    return s.replace("\\", "\\\\").replace("'", "\\'")


def ts_string(s: str) -> str:
    return f"'{ts_escape_body(s)}'"


def ts_bool(b: bool) -> str:
    return "true" if b else "false"


def ts_default_literal(value: str, type_: Optional[str]) -> str:
    if type_ == "int":
        return str(int(value))
    if type_ == "float":
        return str(float(value))
    if type_ == "boolean":
        return "true" if value.lower() in ("1", "true", "yes", "on") else "false"
    return ts_string(value)


def pascal_case(s: str) -> str:
    """PascalCase à partir de n'importe quelle casse d'entrée — un nom de
    verbe SQL*Plus/vendeur tapé en MAJUSCULES (`DEFINE`, `SET`) doit produire
    `Define`/`Set` (convention réelle du dépôt : `SqlPlusSetCommand`,
    `CiscoRouterShowIpCommand`), pas `DEFINE`/`SET` accolé tel quel."""
    parts = re.split(r"[^A-Za-z0-9]+", s)
    return "".join(p[:1].upper() + p[1:].lower() for p in parts if p)


def camel_case(s: str) -> str:
    p = pascal_case(s)
    return (p[:1].lower() + p[1:]) if p else p


def relative_import(from_dir: Path, to_module_no_ext: Path) -> str:
    """Chemin d'import relatif (POSIX, sans extension) de `from_dir` vers
    `to_module_no_ext` — les deux DOIVENT être relatifs à REPO_ROOT."""
    rel = posixpath.relpath(to_module_no_ext.as_posix(), from_dir.as_posix())
    if not rel.startswith("."):
        rel = "./" + rel
    return rel


# ===========================================================================
# 5. Parsing de la mini-DSL --arg / --option ("clé=valeur|clé=valeur|…")
# ===========================================================================


def parse_kv_string(raw: str) -> dict[str, str]:
    """`"name=col|type=string|required=true"` -> {"name": "col", ...}.
    Séparateur `|` (pas `,` : une description contient souvent des virgules).
    Chaque champ ne coupe que sur le PREMIER `=` (une description peut en
    contenir)."""
    out: dict[str, str] = {}
    for field_str in raw.split("|"):
        field_str = field_str.strip()
        if not field_str:
            continue
        if "=" not in field_str:
            raise ValueError(f"champ invalide (attendu clé=valeur) : '{field_str}' dans '{raw}'")
        key, _, value = field_str.partition("=")
        out[key.strip()] = value.strip()
    return out


def _to_bool(v: Optional[str], default: bool = False) -> bool:
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def build_arg_spec_from_dict(d: dict) -> ArgSpec:
    return ArgSpec(
        name=d["name"],
        type=d.get("type", "string"),
        required=bool(d.get("required", False)),
        variadic=bool(d.get("variadic", False)),
        description=d.get("description", ""),
    )


def build_arg_spec(raw: str) -> ArgSpec:
    kv = parse_kv_string(raw)
    if "name" not in kv:
        raise ValueError(f"--arg sans 'name' : '{raw}'")
    return ArgSpec(
        name=kv["name"],
        type=kv.get("type", "string"),
        required=_to_bool(kv.get("required")),
        variadic=_to_bool(kv.get("variadic")),
        description=kv.get("description", ""),
    )


def build_option_spec_from_dict(d: dict) -> OptionSpec:
    return OptionSpec(
        long=d["long"],
        short=d.get("short"),
        takes_value=bool(d.get("takes_value", d.get("takesValue", True))),
        type=d.get("type"),
        default=d.get("default"),
        description=d.get("description", ""),
        required_capability=d.get("required_capability", d.get("requiredCapability")),
        numeric_shorthand=bool(d.get("numeric_shorthand", d.get("numericShorthand", False))),
    )


def build_option_spec(raw: str) -> OptionSpec:
    kv = parse_kv_string(raw)
    if "long" not in kv:
        raise ValueError(f"--option sans 'long' : '{raw}'")
    return OptionSpec(
        long=kv["long"],
        short=kv.get("short"),
        takes_value=_to_bool(kv.get("takes-value"), default=True) if "takes-value" in kv else True,
        type=kv.get("type"),
        default=kv.get("default"),
        description=kv.get("description", ""),
        required_capability=kv.get("required-capability"),
        numeric_shorthand=_to_bool(kv.get("numeric-shorthand")),
    )


# ===========================================================================
# 6. Validation cible <-> kind
# ===========================================================================


def validate_spec(spec: CommandSpec, target: TargetConfig) -> list[str]:
    errors: list[str] = []
    if spec.kind not in KINDS:
        errors.append(f"--kind invalide '{spec.kind}' (attendu: {sorted(KINDS)})")
    if spec.privilege_level not in PRIVILEGE_LEVELS:
        errors.append(f"--privilege invalide '{spec.privilege_level}' (attendu: {sorted(PRIVILEGE_LEVELS)})")

    if spec.kind in ("push-mode", "pop-mode", "end-mode") and not target.uses_modes:
        errors.append(
            f"--kind {spec.kind} n'a de sens que pour un CLI vendeur à modes "
            f"(uses_modes=True) — '{target.key}' n'en a pas (Executor/Interpreter "
            "ne connaissent pas les modes)."
        )
    if spec.kind == "composite" and not target.uses_modes:
        errors.append(
            f"--kind composite (subRegistry) n'est géré QUE par CliInterpreter "
            f"(vendeur à modes) — '{target.key}' utilise l'Executor/Interpreter "
            "générique, qui ne dispatche pas de subRegistry. Un shell POSIX "
            "compose ses sous-commandes autrement (ex: argument positional lu "
            "dans execute())."
        )
    if spec.kind == "push-mode" and not spec.target_mode:
        errors.append("--kind push-mode nécessite --target-mode <mode-cible>")
    if spec.allowed_modes and not target.uses_modes:
        errors.append(f"--allowed-modes n'a de sens que pour un CLI vendeur à modes ('{target.key}' n'en a pas)")
    if not spec.name:
        errors.append("--name est requis")
    return errors


# ===========================================================================
# 7. Dérivation des valeurs par défaut (nom de classe, catégorie, usage…)
# ===========================================================================


def default_class_name(spec: CommandSpec, target: TargetConfig) -> str:
    infix = ""
    if spec.subdir:
        last_segment = spec.subdir.strip("/").split("/")[-1]
        infix = pascal_case(last_segment)
    return f"{target.class_prefix}{infix}{pascal_case(spec.name)}Command"


def default_file_stem(spec: CommandSpec) -> str:
    return pascal_case(spec.name)


def default_usage(spec: CommandSpec) -> str:
    parts = [spec.name]
    for a in spec.args:
        token = f"<{a.name}>" if a.required else f"[{a.name}]"
        if a.variadic:
            token = token[:-1] + "...]" if token.endswith("]") else token + "..."
        parts.append(token)
    for o in spec.options:
        token = f"--{o.long}" + (f" <{o.long}>" if o.takes_value else "")
        parts.append(f"[{token}]")
    return " ".join(parts)


def finalize_spec(spec: CommandSpec, target: TargetConfig) -> CommandSpec:
    if not spec.class_name:
        spec.class_name = default_class_name(spec, target)
    if not spec.category:
        spec.category = "cli-mode" if spec.kind in ("push-mode", "pop-mode", "end-mode") else target.default_category
    if not spec.usage:
        spec.usage = default_usage(spec)
    if spec.kind == "push-mode" and spec.privilege_level == "ANY":
        # Les transitions de mode sont conventionnellement OPERATOR (voir
        # vendor-cli/cisco/{Enable,ConfigureTerminal}.ts) — ANY resterait
        # correct mais surprendrait ; on ne force que si l'appelant a laissé
        # le défaut du script (ANY) sans le préciser lui-même.
        spec.privilege_level = "OPERATOR"
    return spec


# ===========================================================================
# 8. Rendu des fichiers de commande, par 'kind'
# ===========================================================================


HEADER_IMPORTS_COMMON = [
    "import { BaseCommand } from '@/command-kernel/command/base-command';",
    "import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';",
    "import { EXIT_OK } from '@/command-kernel/command/types';",
    "import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';",
    "import { PrivilegeLevel } from '@/command-kernel/session/types';",
]


def privilege_const_decl(spec: CommandSpec) -> tuple[str, str]:
    """Retourne (nom_const, ligne_déclaration)."""
    name = PRIVILEGE_CONST_NAMES[spec.privilege_level]
    args = [f"PrivilegeLevel.{spec.privilege_level}"]
    if spec.required_groups or spec.required_capabilities:
        groups = "[" + ", ".join(ts_string(g) for g in spec.required_groups) + "]"
        args.append(groups)
    if spec.required_capabilities:
        caps = "[" + ", ".join(f"Capability.{c}" for c in spec.required_capabilities) + "]"
        args.append(caps)
    return name, f"const {name} = new DefaultPrivilegePolicy({', '.join(args)});"


def render_descriptor_object(spec: CommandSpec, priv_const: str) -> str:
    lines = ["{"]
    lines.append(f"    name: {ts_string(spec.name)},")
    if spec.aliases:
        lines.append(f"    aliases: [{', '.join(ts_string(a) for a in spec.aliases)}],")
    lines.append(f"    summary: {ts_string(spec.summary)},")
    lines.append(f"    usage: {ts_string(spec.usage)},")
    if spec.args:
        lines.append("    args: [")
        for a in spec.args:
            lines.append(f"      {a.to_ts()},")
        lines.append("    ],")
    else:
        lines.append("    args: [],")
    if spec.options:
        lines.append("    options: [")
        for o in spec.options:
            lines.append(f"      {o.to_ts()},")
        lines.append("    ],")
    else:
        lines.append("    options: [],")
    lines.append(f"    privileges: {priv_const},")
    lines.append(f"    category: {ts_string(spec.category)},")
    if spec.streaming:
        lines.append("    streaming: true,")
    lines.append("  }")
    return "\n".join(lines)


def render_machine_access(target: TargetConfig, indent: str = "    ") -> str:
    if target.access_style == "cast":
        return f"{indent}const machine = ctx.machine as {target.machine_api_type};\n"
    if target.access_style == "capability":
        return f"{indent}const {target.capability_field} = ctx.machine.{target.capability_field}!;\n"
    return (
        f"{indent}// Capacités universelles directement sur ctx.machine (fs/proc/net/\n"
        f"{indent}// users/groups/power). Cast en {target.machine_api_type} seulement si\n"
        f"{indent}// une capacité spécifique du vendeur est nécessaire.\n"
    )


def render_execute_body_todo(spec: CommandSpec, target: TargetConfig) -> str:
    lines: list[str] = []
    for a in spec.args:
        lines.append(f"    const {camel_case(a.name)} = ctx.args.get<{a.runtime_type()}>({ts_string(a.name)});")
    for o in spec.options:
        if o.takes_value:
            lines.append(f"    const {camel_case(o.long)} = ctx.args.get<{o.runtime_type()}>({ts_string(o.long)});")
        else:
            lines.append(f"    const {camel_case(o.long)} = ctx.args.flag({ts_string(o.long)});")
    if lines:
        lines.append("")
    lines.append("    // TODO: lire UNIQUEMENT via la MachineApi ci-dessus, puis formater")
    lines.append("    // chaque ligne de sortie inline (jamais de formateur legacy réutilisé).")
    lines.append("    await ctx.io.stdout.write('TODO\\n');")
    lines.append("    return EXIT_OK;")
    return "\n".join(lines)


def render_leaf_or_streaming_command(spec: CommandSpec, target: TargetConfig, file_path: Path) -> str:
    imports = list(HEADER_IMPORTS_COMMON)
    if target.access_style == "cast" and target.machine_api_module:
        rel = relative_import(file_path.parent, Path(target.machine_api_module))
        imports.append(f"import type {{ {target.machine_api_type} }} from '{rel}';")
    if spec.required_capabilities:
        imports.append("import { Capability } from '@/command-kernel/session/types';")

    priv_name, priv_decl = privilege_const_decl(spec)
    descriptor = render_descriptor_object(spec, priv_name)

    allowed_modes_field = ""
    if spec.allowed_modes:
        modes = ", ".join(ts_string(m) for m in spec.allowed_modes)
        allowed_modes_field = f"  readonly allowedModes = [{modes}];\n"

    machine_access = render_machine_access(target)
    body = render_execute_body_todo(spec, target)

    streaming_note = ""
    if spec.kind == "streaming":
        streaming_note = (
            "  // Flux continu (descriptor.streaming = true) : écrire au fil de l'eau\n"
            "  // et s'arrêter dès que ctx.signal.aborted devient vrai. Exemple :\n"
            "  //   while (!ctx.signal.aborted) {\n"
            "  //     await ctx.io.stdout.write(`...\\n`);\n"
            "  //     await new Promise((r) => setTimeout(r, 1000));\n"
            "  //   }\n"
        )

    doc = (
        f"/**\n"
        f" * `{spec.name}` — TODO: une ligne d'intention métier.\n"
        f" * Commande {'en flux continu' if spec.kind == 'streaming' else 'feuille standalone'} : "
        f"`ctx.machine` est l'unique source de données, formatage inline.\n"
        f" */\n"
    )

    return (
        "\n".join(imports)
        + "\n\n"
        + priv_decl
        + "\n\n"
        + doc
        + f"export class {spec.class_name} extends BaseCommand {{\n"
        + f"  readonly descriptor: CommandDescriptor = {descriptor};\n"
        + allowed_modes_field
        + (streaming_note + "\n" if streaming_note else "\n")
        + "  async execute(ctx: CommandContext): Promise<ExitCode> {\n"
        + machine_access
        + body
        + "\n"
        + "  }\n"
        + "}\n"
    )


def render_composite_command(
    spec: CommandSpec,
    target: TargetConfig,
    file_path: Path,
    sibling_specs: Optional[dict[str, tuple[CommandSpec, TargetConfig]]] = None,
) -> str:
    imports = list(HEADER_IMPORTS_COMMON)
    imports.append("import { CommandRegistry } from '@/command-kernel/registry/command-registry';")
    for child in spec.children:
        imports.append(child_import_line(child, file_path, sibling_specs))

    priv_name, priv_decl = privilege_const_decl(spec)
    descriptor = render_descriptor_object(spec, priv_name)

    allowed_modes_field = ""
    if spec.allowed_modes:
        modes = ", ".join(ts_string(m) for m in spec.allowed_modes)
        allowed_modes_field = f"  readonly allowedModes = [{modes}];\n"

    ctor_lines = ["  constructor() {", "    super();"]
    for child in spec.children:
        ctor_lines.append(f"    this.subRegistry.register(() => new {child}());")
    if not spec.children:
        ctor_lines.append("    // TODO: this.subRegistry.register(() => new <Leaf>Command());")
    ctor_lines.append("  }")

    doc = (
        f"/**\n"
        f" * `{spec.name}` — commande COMPOSITE (racine + sous-registre) : seule\n"
        f" * appelée directement si aucun sous-mot ne matche (message vendeur\n"
        f" * « incomplete command »), sinon l'interpréteur descend dans\n"
        f" * `subRegistry` jusqu'à la feuille.\n"
        f" */\n"
    )

    return (
        "\n".join(imports)
        + "\n\n"
        + priv_decl
        + "\n\n"
        + doc
        + f"export class {spec.class_name} extends BaseCommand {{\n"
        + f"  readonly descriptor: CommandDescriptor = {descriptor};\n"
        + allowed_modes_field
        + "  readonly subRegistry = new CommandRegistry();\n\n"
        + "\n".join(ctor_lines)
        + "\n\n"
        + "  async execute(ctx: CommandContext): Promise<ExitCode> {\n"
        + f"    await ctx.io.stderr.write('{ts_escape_body(spec.incomplete_message)}\\n');\n"
        + "    return 1;\n"
        + "  }\n"
        + "}\n"
    )


def render_push_mode_command(spec: CommandSpec, target: TargetConfig, file_path: Path) -> str:
    imports = [
        "import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';",
        "import { PushModeCommand } from '@/command-kernel/cli/commands/mode-transition';",
        "import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';",
        "import { PrivilegeLevel } from '@/command-kernel/session/types';",
    ]
    priv_name, priv_decl = privilege_const_decl(spec)
    descriptor = render_descriptor_object(spec, priv_name)
    modes = ", ".join(ts_string(m) for m in spec.allowed_modes) if spec.allowed_modes else ""

    doc = (
        f"/**\n"
        f" * `{spec.name}` — transition de mode (push vers `{spec.target_mode}`).\n"
        f" * `prepare()` peut refuser la transition (retourner false après avoir\n"
        f" * écrit un message sur ctx.io.stderr) ou positionner des promptFields\n"
        f" * (ex: interface sélectionnée) avant le push.\n"
        f" */\n"
    )

    return (
        "\n".join(imports)
        + "\n\n"
        + priv_decl
        + "\n\n"
        + doc
        + f"export class {spec.class_name} extends PushModeCommand {{\n"
        + f"  readonly descriptor: CommandDescriptor = {descriptor};\n"
        + (f"  readonly allowedModes = [{modes}];\n" if modes else "")
        + "\n"
        + "  protected async prepare(_ctx: CommandContext): Promise<boolean> {\n"
        + "    // TODO: valider les arguments / positionner ctx.session.promptFields.\n"
        + "    return true;\n"
        + "  }\n\n"
        + "  protected targetMode(_ctx: CommandContext): string {\n"
        + f"    return {ts_string(spec.target_mode or 'TODO')};\n"
        + "  }\n"
        + "}\n"
    )


def render_command_file(
    spec: CommandSpec,
    target: TargetConfig,
    file_path: Path,
    sibling_specs: Optional[dict[str, tuple[CommandSpec, TargetConfig]]] = None,
) -> str:
    if spec.kind in ("leaf", "streaming"):
        return render_leaf_or_streaming_command(spec, target, file_path)
    if spec.kind == "composite":
        return render_composite_command(spec, target, file_path, sibling_specs)
    if spec.kind == "push-mode":
        return render_push_mode_command(spec, target, file_path)
    raise ValueError(f"kind '{spec.kind}' ne produit pas de fichier (voir render_registration_snippet)")


def child_import_line(
    child_class: str,
    parent_file: Path,
    sibling_specs: Optional[dict[str, tuple[CommandSpec, TargetConfig]]],
) -> str:
    """Compute the correct relative import for a composite's child.

    In batch mode (`sibling_specs` non vide), on retrouve la spec de
    l'enfant par son nom de classe et on calcule le chemin relatif
    `./<subdir>/<Stem>` depuis le fichier du parent — plus de `TODO:
    vérifier le chemin`. En mode `new` (spec unique), on retombe sur
    l'ancien comportement (chemin à plat + TODO) parce qu'on ne connaît
    pas où vit l'enfant.
    """
    if sibling_specs and child_class in sibling_specs:
        child_spec, child_target = sibling_specs[child_class]
        child_path = compute_file_path(child_spec, child_target)
        rel = compute_relative_module(parent_file, child_path)
        return f"import {{ {child_class} }} from '{rel}';"
    stem = child_class.removesuffix("Command")
    return f"import {{ {child_class} }} from './{stem}';  // TODO: vérifier le chemin (mode batch requis pour la résolution auto)"


def compute_relative_module(from_file: Path, to_file: Path) -> str:
    """`from_file` et `to_file` sont des chemins repo-relatifs (fichiers).
    Retourne un spécificateur d'import ES-modules (avec `./` ou `../`,
    sans extension `.ts`)."""
    import os
    from_dir = from_file.parent
    to_no_ext = to_file.with_suffix("")
    rel = os.path.relpath(to_no_ext, start=from_dir)
    # Windows-style backslashes → forward slashes (au cas où l'auteur
    # tourne le script sous Windows).
    rel = rel.replace(os.sep, "/")
    if not rel.startswith("."):
        rel = "./" + rel
    return rel


# ===========================================================================
# 9. Stub de test de fondation
# ===========================================================================


def render_test_stub(spec: CommandSpec, target: TargetConfig) -> str:
    return (
        f"\n  it({ts_string(f'{spec.name} — TODO décrire le comportement attendu')}, async () => {{\n"
        f"    // TODO: construire l'équipement/le shell réel pour '{target.key}',\n"
        f"    // exécuter '{spec.name}' via le pipeline command-kernel, asserter la\n"
        f"    // sortie EXACTE attendue (parité vendeur) — ctx.machine comme seule\n"
        f"    // source, jamais de mock du formateur.\n"
        f"    expect(true).toBe(true); // TODO\n"
        f"  }});\n"
    )


# ===========================================================================
# 10. Écriture de fichiers + enregistrement automatique (best-effort)
# ===========================================================================


class GenerationError(RuntimeError):
    pass


def compute_file_path(spec: CommandSpec, target: TargetConfig) -> Path:
    root = Path(target.commands_root)
    if spec.subdir:
        root = root / spec.subdir.strip("/")
    return root / f"{default_file_stem(spec)}.ts"


def write_text_file(path: Path, content: str, force: bool, dry_run: bool) -> str:
    abs_path = REPO_ROOT / path
    exists = abs_path.exists()
    if exists and not force and not dry_run:
        raise GenerationError(
            f"le fichier existe déjà : {path} (utilise --force pour écraser, ou "
            "choisis un autre --name/--subdir/--class-name)"
        )
    if dry_run:
        warning = " (existe déjà — --force serait requis hors dry-run)" if exists and not force else ""
        return f"[dry-run] écrirait {path} ({len(content)} caractères){warning}"
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(content, encoding="utf-8")
    return f"écrit : {path}"


LAST_REGISTER_RE = re.compile(r"^([ \t]*)(\w+)\.register\(\(\) => new \w+\([^)]*\)\);[ \t]*$")
LAST_IMPORT_RE = re.compile(r"^import .+;[ \t]*$")


def find_default_register_anchor(lines: list[str]) -> Optional[int]:
    """Dernière ligne `X.register(() => new YCommand());` du fichier —
    raisonnable seulement pour un registre unique (cibles à plat)."""
    last_idx = None
    for i, line in enumerate(lines):
        if LAST_REGISTER_RE.match(line):
            last_idx = i
    return last_idx


def find_anchor_by_text(lines: list[str], needle: str) -> Optional[int]:
    for i, line in enumerate(lines):
        if needle in line:
            return i
    return None


def attempt_registration(
    spec: CommandSpec,
    target: TargetConfig,
    file_path: Path,
    insert_after: Optional[str],
    dry_run: bool,
) -> str:
    if not target.bootstrap_file:
        return (
            f"[register] aucune cible de bootstrap connue pour '{target.key}' — "
            "ajoute manuellement l'import et l'enregistrement."
        )
    bootstrap_path = REPO_ROOT / target.bootstrap_file
    if not bootstrap_path.exists():
        return f"[register] fichier bootstrap introuvable : {target.bootstrap_file} — enregistrement manuel requis."

    text = bootstrap_path.read_text(encoding="utf-8")
    lines = text.split("\n")

    if not target.auto_register_supported and not insert_after:
        return (
            f"[register] '{target.key}' a plusieurs registres/sous-registres : "
            "insertion automatique refusée sans --insert-after explicite "
            "(passe un extrait EXACT d'une ligne d'enregistrement existante du "
            "registre visé). Snippet à coller à la main :\n"
            + registration_snippet(spec, target, file_path)
        )

    anchor_idx: Optional[int]
    if insert_after:
        anchor_idx = find_anchor_by_text(lines, insert_after)
        if anchor_idx is None:
            return (
                f"[register] --insert-after ne correspond à aucune ligne de "
                f"{target.bootstrap_file} — enregistrement manuel requis:\n"
                + registration_snippet(spec, target, file_path)
            )
    else:
        anchor_idx = find_default_register_anchor(lines)
        if anchor_idx is None:
            return (
                f"[register] aucune ligne '*.register(() => new *Command());' "
                f"trouvée dans {target.bootstrap_file} — enregistrement manuel requis:\n"
                + registration_snippet(spec, target, file_path)
            )

    anchor_line = lines[anchor_idx]
    indent_match = re.match(r"^([ \t]*)", anchor_line)
    indent = indent_match.group(1) if indent_match else ""
    registry_var_match = re.match(r"^[ \t]*(\w+)\.register\(", anchor_line)
    registry_var = registry_var_match.group(1) if registry_var_match else "registry"
    new_register_line = f"{indent}{registry_var}.register(() => new {spec.class_name}());"

    if new_register_line.strip() in text:
        register_added = "(déjà présent — inchangé)"
    else:
        lines.insert(anchor_idx + 1, new_register_line)
        register_added = "ajouté"

    import_rel = relative_import(Path(target.bootstrap_file).parent, file_path.with_suffix(""))
    import_line = f"import {{ {spec.class_name} }} from '{import_rel}';"
    if import_line in lines:
        import_added = "(déjà présent — inchangé)"
    else:
        last_import_idx = None
        for i, line in enumerate(lines):
            if LAST_IMPORT_RE.match(line):
                last_import_idx = i
        insertion_point = (last_import_idx + 1) if last_import_idx is not None else 0
        lines.insert(insertion_point, import_line)
        import_added = "ajouté"

    new_text = "\n".join(lines)
    if not dry_run:
        bootstrap_path.write_text(new_text, encoding="utf-8")

    prefix = "[dry-run] " if dry_run else ""
    return (
        f"{prefix}[register] {target.bootstrap_file} : import {import_added} "
        f"({import_line}) ; enregistrement {register_added} "
        f"({new_register_line.strip()})"
    )


def registration_snippet(spec: CommandSpec, target: TargetConfig, file_path: Path) -> str:
    if not target.bootstrap_file:
        import_rel = "<chemin vers le fichier généré>"
    else:
        import_rel = relative_import(Path(target.bootstrap_file).parent, file_path.with_suffix(""))
    return (
        f"  import {{ {spec.class_name} }} from '{import_rel}';\n"
        f"  <registreDuModeVisé>.register(() => new {spec.class_name}());"
    )


def attempt_test_stub(spec: CommandSpec, target: TargetConfig, dry_run: bool) -> str:
    if not target.foundation_test_file:
        return f"[test] aucun fichier de test de fondation connu pour '{target.key}' — crée-le à la main."
    test_path = REPO_ROOT / target.foundation_test_file
    if not test_path.exists():
        return f"[test] fichier introuvable : {target.foundation_test_file} — stub non ajouté."

    text = test_path.read_text(encoding="utf-8")
    lines = text.split("\n")
    last_close_idx = None
    for i, line in enumerate(lines):
        if line.rstrip() == "});":
            last_close_idx = i
    if last_close_idx is None:
        return f"[test] pas de '}});' trouvé en fin de bloc dans {target.foundation_test_file} — stub non ajouté."

    stub_lines = render_test_stub(spec, target).split("\n")
    lines[last_close_idx:last_close_idx] = stub_lines
    new_text = "\n".join(lines)
    if not dry_run:
        test_path.write_text(new_text, encoding="utf-8")
    prefix = "[dry-run] " if dry_run else ""
    return f"{prefix}[test] stub ajouté dans {target.foundation_test_file} (juste avant la dernière '}});' )"


# ===========================================================================
# 11. CLI (argparse)
# ===========================================================================


def add_common_new_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--target", required=True, choices=sorted(TARGETS), help="cible (voir `list-targets`)")
    p.add_argument("--name", required=True, help="nom du verbe tel qu'il apparaît dans le CLI (ex: SHOW, ip, vlan)")
    p.add_argument("--kind", default="leaf", choices=sorted(KINDS), help="forme de la commande (défaut: leaf)")
    p.add_argument("--class-name", default=None, help="nom de classe TS (déduit sinon, voir --help)")
    p.add_argument("--summary", default=None, help="résumé une ligne (CommandDescriptor.summary)")
    p.add_argument("--usage", default=None, help="chaîne d'usage (déduite des --arg/--option sinon)")
    p.add_argument("--aliases", default="", help="alias séparés par des virgules")
    p.add_argument("--category", default=None, help="catégorie (déduite de la cible sinon)")
    p.add_argument(
        "--arg",
        dest="args_raw",
        action="append",
        default=[],
        help="argument positionnel : \"name=X|type=string|required=true|variadic=false|description=...\" (répétable)",
    )
    p.add_argument(
        "--option",
        dest="options_raw",
        action="append",
        default=[],
        help="option : \"long=X|short=x|takes-value=true|type=string|default=...|description=...\" (répétable)",
    )
    p.add_argument("--args-json", default=None, help="tableau JSON d'args (alternative à --arg), ou @fichier.json")
    p.add_argument("--options-json", default=None, help="tableau JSON d'options (alternative à --option), ou @fichier.json")
    p.add_argument("--privilege", default="ANY", choices=sorted(PRIVILEGE_LEVELS), help="PrivilegeLevel minimum")
    p.add_argument("--required-groups", default="", help="groupes requis, séparés par des virgules")
    p.add_argument("--required-capabilities", default="", help="Capability requises (enum Capability), séparées par des virgules")
    p.add_argument("--allowed-modes", default="", help="modes CLI autorisés, séparés par des virgules (vendeur à modes uniquement)")
    p.add_argument("--subdir", default="", help="sous-dossier sous commands_root de la cible (ex: show, config/config-if)")
    p.add_argument("--children", default="", help="[composite] noms de classes déjà existantes à enregistrer dans le subRegistry, séparés par des virgules")
    p.add_argument("--target-mode", default=None, help="[push-mode] mode CLI cible du push")
    p.add_argument("--incomplete-message", default="% Incomplete command.", help="[composite] message vendeur exact affiché seul")
    p.add_argument("--register", action="store_true", help="tente d'insérer l'import + l'enregistrement dans le bootstrap de la cible")
    p.add_argument("--insert-after", default=None, help="ancre : extrait exact d'une ligne existante après laquelle insérer l'enregistrement")
    p.add_argument("--with-test", action="store_true", help="ajoute un stub de test dans le fichier de fondation de la cible")
    p.add_argument("--force", action="store_true", help="écrase un fichier de commande déjà existant")
    p.add_argument("--dry-run", action="store_true", help="n'écrit rien, affiche ce qui serait fait")


def load_json_maybe_file(raw: str) -> list:
    if raw.startswith("@"):
        path = Path(raw[1:])
        raw_content = path.read_text(encoding="utf-8")
    else:
        raw_content = raw
    data = json.loads(raw_content)
    if not isinstance(data, list):
        raise ValueError("le JSON d'args/options doit être un tableau")
    return data


def spec_from_namespace(ns: argparse.Namespace) -> CommandSpec:
    args: list[ArgSpec] = []
    if ns.args_json:
        args.extend(build_arg_spec_from_dict(d) for d in load_json_maybe_file(ns.args_json))
    args.extend(build_arg_spec(raw) for raw in ns.args_raw)

    options: list[OptionSpec] = []
    if ns.options_json:
        options.extend(build_option_spec_from_dict(d) for d in load_json_maybe_file(ns.options_json))
    options.extend(build_option_spec(raw) for raw in ns.options_raw)

    def split_csv(s: str) -> list[str]:
        return [x.strip() for x in s.split(",") if x.strip()]

    spec = CommandSpec(
        target=ns.target,
        name=ns.name,
        kind=ns.kind,
        class_name=ns.class_name or "",
        summary=ns.summary or "TODO: résumé une ligne",
        usage=ns.usage or "",
        aliases=split_csv(ns.aliases),
        category=ns.category or "",
        args=args,
        options=options,
        privilege_level=ns.privilege,
        required_groups=split_csv(ns.required_groups),
        required_capabilities=split_csv(ns.required_capabilities),
        allowed_modes=split_csv(ns.allowed_modes),
        subdir=ns.subdir,
        streaming=(ns.kind == "streaming"),
        children=split_csv(ns.children),
        target_mode=ns.target_mode,
        incomplete_message=ns.incomplete_message,
    )
    return spec


def generate_one(
    spec: CommandSpec,
    ns: argparse.Namespace,
    sibling_specs: Optional[dict[str, tuple[CommandSpec, TargetConfig]]] = None,
) -> int:
    target = target_or_die(spec.target)
    errors = validate_spec(spec, target)
    if errors:
        for e in errors:
            print(f"  ✗ {e}", file=sys.stderr)
        return 1

    spec = finalize_spec(spec, target)

    print(f"— {spec.name} → {spec.class_name} ({target.label}, kind={spec.kind})")

    if spec.kind in ("pop-mode", "end-mode"):
        base = "PopModeCommand" if spec.kind == "pop-mode" else "EndCommand"
        print(
            f"  [info] {spec.kind} ne nécessite normalement PAS de sous-classe : "
            f"utilise directement `new {base}(...)` dans le bootstrap. Snippet suggéré :"
        )
        ctor = f"'{spec.name}'" if spec.kind == "pop-mode" else "[]"
        print(f"    <registre>.register(() => new {base}({ctor}));")
        return 0

    file_path = compute_file_path(spec, target)
    content = render_command_file(spec, target, file_path, sibling_specs)

    try:
        result = write_text_file(file_path, content, force=ns.force, dry_run=ns.dry_run)
    except GenerationError as e:
        print(f"  ✗ {e}", file=sys.stderr)
        return 1
    print(f"  {result}")

    if ns.dry_run:
        print("  --- contenu généré ---")
        print(content)
        print("  --- fin ---")

    if ns.register:
        print("  " + attempt_registration(spec, target, file_path, ns.insert_after, ns.dry_run))
    else:
        print("  [register] non demandé (--register) — snippet manuel :")
        print(registration_snippet(spec, target, file_path))

    if ns.with_test:
        print("  " + attempt_test_stub(spec, target, ns.dry_run))

    return 0


def cmd_new(ns: argparse.Namespace) -> int:
    spec = spec_from_namespace(ns)
    return generate_one(spec, ns)


def cmd_batch(ns: argparse.Namespace) -> int:
    raw = Path(ns.spec_file).read_text(encoding="utf-8")
    items = json.loads(raw)
    if not isinstance(items, list):
        print("le fichier de batch doit contenir un tableau JSON de spécifications", file=sys.stderr)
        return 1

    class _FakeNs:
        force = ns.force
        dry_run = ns.dry_run
        register = ns.register
        insert_after = None
        with_test = ns.with_test

    # Passe 1 : parser toutes les specs et construire l'index par
    # class_name (pour résoudre les imports composites → enfants).
    parsed: list[tuple[CommandSpec, Optional[str]]] = []
    sibling_specs: dict[str, tuple[CommandSpec, TargetConfig]] = {}
    parse_failures = 0
    for i, item in enumerate(items):
        item_insert_after = item.pop("insert_after", None)
        try:
            spec = CommandSpec.from_dict(item)
            target = target_or_die(spec.target)
            spec = finalize_spec(spec, target)
        except (KeyError, ValueError, SystemExit) as e:
            print(f"[{i}] spécification invalide : {e}", file=sys.stderr)
            parse_failures += 1
            continue
        parsed.append((spec, item_insert_after))
        sibling_specs[spec.class_name] = (spec, target_or_die(spec.target))

    # Passe 2 : générer chaque commande en passant le map complet, ce
    # qui donne à `render_composite_command` les vrais chemins des
    # enfants (plus de TODO à corriger à la main).
    failures = parse_failures
    for spec, item_insert_after in parsed:
        fake_ns = _FakeNs()
        fake_ns.insert_after = item_insert_after
        code = generate_one(spec, fake_ns, sibling_specs)  # type: ignore[arg-type]
        if code != 0:
            failures += 1

    total = len(items)
    print(f"\n{total - failures}/{total} commande(s) générée(s) avec succès.")
    return 1 if failures else 0


def cmd_list_targets(ns: argparse.Namespace) -> int:
    for key in sorted(TARGETS):
        t = TARGETS[key]
        print(f"\n=== {t.key} — {t.label} ===")
        print(f"  commands_root         : {t.commands_root}")
        print(f"  class_prefix           : '{t.class_prefix}'")
        print(f"  default_category       : {t.default_category}")
        print(f"  uses_modes (vendor-cli): {t.uses_modes}")
        print(f"  access_style           : {t.access_style}"
              + (f" (ctx.machine.{t.capability_field})" if t.access_style == "capability" else "")
              + (f" ({t.machine_api_type})" if t.access_style == "cast" else ""))
        if t.bootstrap_file:
            print(f"  bootstrap_file         : {t.bootstrap_file}")
        print(f"  auto_register_supported: {t.auto_register_supported}")
        if t.foundation_test_file:
            print(f"  foundation_test_file   : {t.foundation_test_file}")
        if t.notes:
            print(f"  notes                  : {t.notes}")
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="generate_command.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list-targets", help="liste les cibles connues et leurs conventions")
    p_list.set_defaults(func=cmd_list_targets)

    p_new = sub.add_parser("new", help="génère une commande unique")
    add_common_new_args(p_new)
    p_new.set_defaults(func=cmd_new)

    p_batch = sub.add_parser("batch", help="génère plusieurs commandes depuis un fichier JSON (tableau de spécifications)")
    p_batch.add_argument("spec_file", help="fichier JSON : tableau d'objets au format CommandSpec (voir README du dossier)")
    p_batch.add_argument("--register", action="store_true")
    p_batch.add_argument("--with-test", action="store_true")
    p_batch.add_argument("--force", action="store_true")
    p_batch.add_argument("--dry-run", action="store_true")
    p_batch.set_defaults(func=cmd_batch)

    return p


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_arg_parser()
    ns = parser.parse_args(argv)
    try:
        return ns.func(ns)
    except (GenerationError, ValueError) as e:
        print(f"erreur : {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
