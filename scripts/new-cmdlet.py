#!/usr/bin/env python3
"""Generate PowerShell cmdlet boilerplate for the Ubuntu Sandbox simulator.

Emits, from one specification, the whole shape this repository settled on
while migrating NetAdapter, NetRoute, NetIPAddress, NetTCPIP, NetNeighbor
and DnsClient:

  * a selection module under src/network/devices/windows/ carrying the
    row shape, the documented enums, the CIM criteria selection built on
    applyCimCriteria, the "no objects found" message built on cimNotFound,
    the enum validation, and (for a write family) the request plan;
  * ONE FILE PER CMDLET under src/powershell/cmdlets/core/ with the real
    parameter set, positional binding, enum and integer validation,
    refusal of what the simulator cannot evaluate, -WhatIf, -PassThru and
    the CIM projection;
  * a probe test skeleton with the header this repository requires.

Generated TypeScript carries NO comments, by house rule: the reasoning
belongs in the commit message. This generator's own docstrings are for
the operator reading the tool, not for the code it produces.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
WINDOWS_DIR = Path("src/network/devices/windows")
CMDLET_DIR = Path("src/powershell/cmdlets/core")
PROBE_DIR = Path("src/__tests__/unit/network-v2")
CIM_COMMON = Path("src/powershell/cmdlets/cimCommon.ts")

PARAM_TYPES = {
    "string": "String",
    "string[]": "String[]",
    "uint16": "UInt16",
    "uint32": "UInt32",
    "enum": "Enum",
    "switch": "SwitchParameter",
    "ip": "IPAddress",
    "ipprefix": "IPPrefix",
    "mac": "MACAddress",
    "datetime": "DateTime",
}

INTEGER_TYPES = {"uint16": (0, 65535, "System.UInt16"),
                 "uint32": (0, 4294967295, "System.UInt32")}

VERB_KINDS = {"Get": "read", "New": "create", "Set": "update",
              "Remove": "delete", "Clear": "clear", "Enable": "toggle",
              "Disable": "toggle", "Test": "read", "Restart": "toggle",
              "Rename": "update"}


def die(message: str) -> "None":
    print(f"new-cmdlet: {message}", file=sys.stderr)
    raise SystemExit(2)


def lower_camel(name: str) -> str:
    """PowerShell parameter name to its TypeScript field name.

    Acronym-aware, because -IPAddress is ipAddress and never iPAddress:
    the leading run of capitals is lowered except for the capital that
    starts the next word.
    """
    if not name or not name[0].isupper():
        return name
    run = 0
    while run < len(name) and name[run].isupper():
        run += 1
    if run == 1:
        return name[0].lower() + name[1:]
    if run == len(name):
        return name.lower()
    return name[:run - 1].lower() + name[run - 1:]


def upper_camel(name: str) -> str:
    return name[0].upper() + name[1:] if name else name


def screaming(name: str) -> str:
    """CamelCase to SCREAMING_SNAKE, keeping acronyms whole.

    NetNeighbor -> NET_NEIGHBOR, IPAddress -> IP_ADDRESS (not I_P_ADDRESS).
    """
    out = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    out = re.sub(r"([a-z\d])([A-Z])", r"\1_\2", out)
    return re.sub(r"_+", "_", out).upper()


@dataclass
class Param:
    name: str
    type: str = "string[]"
    position: int | None = None
    mandatory: bool = False
    is_value: bool = False
    enum: list[str] = field(default_factory=list)
    unsupported: str = ""
    field: str = ""
    alias: str = ""

    @property
    def lower(self) -> str:
        return self.name.lower()

    @property
    def selection_key(self) -> str:
        return lower_camel(self.name)

    @property
    def row_field(self) -> str:
        return self.field or lower_camel(self.name)

    @property
    def enum_const(self) -> str:
        return ""

    def validate(self) -> None:
        if self.type not in PARAM_TYPES:
            die(f"unknown parameter type '{self.type}' for -{self.name}; "
                f"known: {', '.join(sorted(PARAM_TYPES))}")
        if self.type == "enum" and not self.enum:
            die(f"-{self.name} is declared enum but lists no values "
                f"(use enum=A|B|C)")
        if self.enum and self.type != "enum":
            die(f"-{self.name} lists enum values but its type is "
                f"'{self.type}'")


@dataclass
class Spec:
    family: str
    cim_class: str
    verbs: list[str] = field(default_factory=lambda: ["Get"])
    noun: str = ""
    params: list[Param] = field(default_factory=list)
    row: dict[str, str] = field(default_factory=dict)
    output: dict[str, str] = field(default_factory=dict)
    provider: str = ""
    description: str = ""
    module: str = ""

    def validate(self) -> None:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", self.family):
            die(f"family '{self.family}' must be a bare CamelCase word")
        if not self.cim_class:
            die("cim_class is required (for example MSFT_NetNeighbor)")
        for verb in self.verbs:
            if verb not in VERB_KINDS:
                die(f"unknown verb '{verb}'; known: "
                    f"{', '.join(sorted(VERB_KINDS))}")
        seen_positions: dict[int, str] = {}
        for p in self.params:
            p.validate()
            if p.position is not None:
                if p.position in seen_positions:
                    die(f"-{p.name} and -{seen_positions[p.position]} both "
                        f"claim position {p.position}")
                seen_positions[p.position] = p.name
        if not self.row:
            die("no row fields declared; pass --row name:type or a spec file")

    @property
    def name(self) -> str:
        return self.noun or self.family

    @property
    def module_name(self) -> str:
        return self.module or lower_camel(self.family)

    @property
    def selection_type(self) -> str:
        return f"{self.family}Selection"

    @property
    def row_type(self) -> str:
        return f"{self.family}Row"

    @property
    def filters(self) -> list[Param]:
        return [p for p in self.params
                if not p.is_value and not p.unsupported and p.type != "switch"]

    @property
    def values(self) -> list[Param]:
        return [p for p in self.params if p.is_value]

    @property
    def unsupported(self) -> list[Param]:
        return [p for p in self.params if p.unsupported]

    @property
    def enums(self) -> list[Param]:
        return [p for p in self.params if p.type == "enum"]

    @property
    def integers(self) -> list[Param]:
        return [p for p in self.params if p.type in INTEGER_TYPES]


def parse_param(token: str) -> Param:
    parts = token.split(":")
    name = upper_camel(parts[0])
    p = Param(name=name)
    if len(parts) > 1 and parts[1]:
        p.type = parts[1].lower()
    for opt in parts[2:]:
        if not opt:
            continue
        if opt.startswith("pos="):
            p.position = int(opt[4:])
        elif opt == "mandatory":
            p.mandatory = True
        elif opt == "value":
            p.is_value = True
        elif opt.startswith("enum="):
            p.type = "enum"
            p.enum = [v for v in opt[5:].split("|") if v]
        elif opt.startswith("field="):
            p.field = opt[6:]
        elif opt.startswith("alias="):
            p.alias = opt[6:]
        elif opt.startswith("unsupported="):
            p.unsupported = opt[12:]
        else:
            die(f"unknown option '{opt}' on -{name}")
    return p


def parse_row(token: str) -> tuple[str, str]:
    if ":" not in token:
        return token, "string"
    name, ts = token.split(":", 1)
    return name, ts


TS_OF = {"string": "string", "number": "number", "boolean": "boolean"}


def render_selection_module(spec: Spec) -> str:
    L: list[str] = []
    imports = ["import { applyCimCriteria, cimNotFound } from './cimQuery';"]
    if spec.enums:
        imports.append("import { matchEnumValue } from './netIpAddress';")
    if spec.integers:
        imports.append(
            "import { PortNumber } from '@/network/core/ports/PortNumber';")
    L.extend(imports)
    L.append("")

    for p in spec.enums:
        tname = f"{spec.family}{upper_camel(p.name)}"
        union = " | ".join(f"'{v}'" for v in p.enum)
        L.append(f"export type {tname} = {union};")
        const = screaming(f"{spec.family}_{p.name}")
        values = ", ".join(f"'{v}'" for v in p.enum)
        L.append(f"export const {const}: readonly {tname}[] = [{values}];")
        L.append("")

    L.append(f"export const {screaming(spec.family)}_CIM_CLASS = "
             f"'{spec.cim_class}';")
    L.append("")

    L.append(f"export interface {spec.row_type} {{")
    for fname, ftype in spec.row.items():
        L.append(f"  {fname}: {TS_OF.get(ftype, ftype)};")
    L.append("}")
    L.append("")

    L.append(f"export interface {spec.selection_type} {{")
    for p in spec.filters:
        L.append(f"  {p.selection_key}?: string[];")
    L.append("}")
    L.append("")

    L.append(f"export function select{spec.family}"
             f"<T extends {spec.row_type}>(")
    L.append(f"  rows: readonly T[], selection: {spec.selection_type},")
    L.append("): T[] {")
    L.append("  return applyCimCriteria(rows, [")
    for p in spec.filters:
        access = f"r.{p.row_field}"
        if spec.row.get(p.row_field) == "number":
            access = f"String(r.{p.row_field})"
        L.append(f"    [selection.{p.selection_key}, r => {access}],")
    L.append("  ]);")
    L.append("}")
    L.append("")

    L.append(f"export function {lower_camel(spec.family)}SelectionIsEmpty("
             f"selection: {spec.selection_type}): boolean {{")
    L.append("  return Object.values(selection).every(v => v === undefined);")
    L.append("}")
    L.append("")

    L.append(f"export function noMatching{spec.family}("
             f"selection: {spec.selection_type}): string {{")
    L.append(f"  return cimNotFound({screaming(spec.family)}_CIM_CLASS, [")
    for p in spec.filters:
        L.append(f"    ['{p.name}', selection.{p.selection_key}],")
    L.append("  ]);")
    L.append("}")
    L.append("")

    if spec.enums:
        L.append(f"const {screaming(spec.family)}_ENUMS: ReadonlyArray<"
                 f"readonly [keyof {spec.selection_type}, string, "
                 f"readonly string[]]> = [")
        for p in spec.enums:
            L.append(f"  ['{p.selection_key}', '{p.name}', "
                     f"{screaming(f'{spec.family}_{p.name}')}],")
        L.append("];")
        L.append("")
        L.append(f"export function {lower_camel(spec.family)}EnumProblem("
                 f"selection: {spec.selection_type}): string | null {{")
        L.append(f"  for (const [key, label, table] of "
                 f"{screaming(spec.family)}_ENUMS) {{")
        L.append("    for (const given of selection[key] ?? []) {")
        L.append("      if (matchEnumValue(table, given) === null) {")
        L.append("        return `Cannot validate argument on parameter "
                 "'${label}'. The argument \"${given}\" does not belong to "
                 "the set \"${table.join(',')}\".`;")
        L.append("      }")
        L.append("    }")
        L.append("  }")
        L.append("  return null;")
        L.append("}")
        L.append("")

    for p in spec.integers:
        lo, hi, ts_type = INTEGER_TYPES[p.type]
        fn = f"{lower_camel(spec.family)}{upper_camel(p.name)}Problem"
        L.append(f"export function {fn}(raw: string): string | null {{")
        L.append("  const token = raw.trim();")
        if p.type == "uint16":
            L.append("  if (!/^\\d+$/.test(token) || "
                     "!PortNumber.isValid(Number(token))) {")
        else:
            L.append(f"  if (!/^\\d+$/.test(token) || Number(token) > {hi}) {{")
        L.append(f"    return `Cannot convert value \"${{token}}\" to type "
                 f"\"{ts_type}\". Error: \"Value was either too large or too "
                 f"small for a {ts_type.split('.')[-1]}.\"`;")
        L.append("  }")
        L.append("  return null;")
        L.append("}")
        L.append("")

    if any(v in spec.verbs for v in ("New", "Set")):
        L.extend(render_plan(spec))

    return "\n".join(L).rstrip() + "\n"


def render_plan(spec: Spec) -> list[str]:
    L: list[str] = []
    req = f"{spec.family}Request"
    plan = f"{spec.family}Plan"
    L.append(f"export interface {req} {{")
    for p in spec.params:
        if p.unsupported or p.type == "switch":
            continue
        L.append(f"  {p.selection_key}?: string;")
    L.append("}")
    L.append("")
    L.append(f"export interface {plan} {{")
    for p in spec.params:
        if p.unsupported or p.type == "switch":
            continue
        if p.type == "enum":
            L.append(f"  {p.selection_key}: "
                     f"{spec.family}{upper_camel(p.name)};")
        elif p.type in INTEGER_TYPES:
            L.append(f"  {p.selection_key}: number;")
        else:
            L.append(f"  {p.selection_key}: string;")
    L.append("}")
    L.append("")
    L.append(f"export type {spec.family}Decision =")
    L.append(f"  | {{ ok: true; plan: {plan}; message?: undefined }}")
    L.append(f"  | {{ ok: false; plan?: undefined; message: string }};")
    L.append("")
    L.append(f"export function plan{spec.family}(request: {req}): "
             f"{spec.family}Decision {{")
    L.append(f"  const refuse = (message: string): {spec.family}Decision => "
             f"({{ ok: false, message }});")
    L.append("")
    for p in spec.params:
        if p.unsupported or p.type == "switch":
            continue
        key = p.selection_key
        if p.mandatory:
            L.append(f"  const raw{upper_camel(p.name)} = "
                     f"(request.{key} ?? '').trim();")
            L.append(f"  if (raw{upper_camel(p.name)} === '') {{")
            L.append("    return refuse('Cannot process command because of "
                     "one or more missing mandatory parameters: "
                     f"{p.name}.');")
            L.append("  }")
        if p.type == "enum":
            const = screaming(f"{spec.family}_{p.name}")
            default = p.enum[0]
            L.append(f"  const {key} = request.{key} === undefined")
            L.append(f"    ? '{default}' as {spec.family}"
                     f"{upper_camel(p.name)}")
            L.append(f"    : matchEnumValue({const}, request.{key});")
            L.append(f"  if ({key} === null) {{")
            L.append(f"    return refuse(`Cannot validate argument on "
                     f"parameter '{p.name}'. The argument does not belong "
                     f"to the set \"${{{const}.join(',')}}\".`);")
            L.append("  }")
        elif p.type in INTEGER_TYPES:
            fn = f"{lower_camel(spec.family)}{upper_camel(p.name)}Problem"
            L.append(f"  const raw{upper_camel(p.name)}Value = "
                     f"(request.{key} ?? '').trim();")
            L.append(f"  const {key}Problem = raw{upper_camel(p.name)}Value "
                     f"=== '' ? null : {fn}(raw{upper_camel(p.name)}Value);")
            L.append(f"  if ({key}Problem) return refuse({key}Problem);")
            L.append(f"  const {key} = raw{upper_camel(p.name)}Value === '' "
                     f"? 0 : parseInt(raw{upper_camel(p.name)}Value, 10);")
        else:
            L.append(f"  const {key} = (request.{key} ?? '').trim();")
        L.append("")
    fields = ", ".join(p.selection_key for p in spec.params
                       if not p.unsupported and p.type != "switch")
    L.append(f"  return {{ ok: true, plan: {{ {fields} }} }};")
    L.append("}")
    L.append("")
    return L


def render_cmdlet(spec: Spec, verb: str) -> str:
    display = f"{verb}-{spec.name}"
    cls = f"{verb}{spec.name}Cmdlet"
    kind = VERB_KINDS[verb]
    writes = verb in ("New", "Set", "Remove", "Clear", "Enable", "Disable",
                      "Restart", "Rename")
    mod = spec.module_name
    fam_lower = lower_camel(spec.family)

    named: list[str] = []
    named.append("import type { ICmdlet } from '../ICmdlet';")
    named.append("import type { CmdletContext } from '../CmdletContext';")
    named.append("import type { PSValue } from "
                 "'@/powershell/runtime/PSEnvironment';")
    named.append("import { psValueToString } from "
                 "'@/powershell/runtime/PSExpansion';")
    named.append("import {\n  cimFilterReader, remoteCimRefusal, "
                 "requireNetwork,\n} from '../cimCommon';")

    sel_imports = [f"type {spec.selection_type}",
                   f"select{spec.family}",
                   f"{fam_lower}SelectionIsEmpty",
                   f"noMatching{spec.family}"]
    if spec.enums:
        sel_imports.append(f"{fam_lower}EnumProblem")
    for p in spec.integers:
        sel_imports.append(
            f"{fam_lower}{upper_camel(p.name)}Problem")
    if verb in ("New", "Set"):
        sel_imports.append(f"plan{spec.family}")
    named.append("import {\n  " + ",\n  ".join(sel_imports) +
                 f",\n}} from '@/network/devices/windows/{mod}';")

    L = named + [""]

    param_names = [p.name for p in spec.params]
    if writes:
        param_names += ["PassThru", "WhatIf", "Confirm"]
    const_params = screaming(f"{spec.family}_{verb}_PARAMS")
    L.append(f"const {const_params} = [" +
             ", ".join(f"'{n}'" for n in param_names) + "] as const;")
    L.append("")

    if spec.unsupported:
        const_unsup = screaming(f"{spec.family}_UNSUPPORTED")
        L.append(f"const {const_unsup}: ReadonlyArray<readonly "
                 f"[string, string]> = [")
        for p in spec.unsupported:
            L.append(f"  ['{p.lower}', '{p.unsupported}'],")
        L.append("];")
        L.append("")

    L.append(f"export class {cls} implements ICmdlet {{")
    L.append(f"  readonly name = '{display.lower()}';")
    L.append(f"  readonly displayName = '{display}';")
    L.append("  readonly aliases = [] as const;")
    if spec.description:
        L.append(f"  readonly description = '{spec.description}';")
    L.append(f"  readonly parameters = {const_params};")
    L.append("")
    L.append("  execute(ctx: CmdletContext): PSValue {")
    L.append("    const refusal = remoteCimRefusal(ctx, this.displayName);")
    L.append("    if (refusal) { ctx.emitError(refusal); return null; }")
    if spec.unsupported:
        L.append(f"    for (const [key, why] of "
                 f"{screaming(f'{spec.family}_UNSUPPORTED')}) {{")
        L.append("      if (ctx.named[key] !== undefined) {")
        L.append("        ctx.emitError(`${this.displayName} : -${key} is "
                 "not supported by this simulator: ${why}.`);")
        L.append("        return null;")
        L.append("      }")
        L.append("    }")
    L.append("    const net = requireNetwork(ctx);")

    if verb in ("New", "Set") and any(p.mandatory for p in spec.params):
        L.append("    const named = (key: string): string | undefined =>")
        L.append("      ctx.named[key] === undefined ? undefined : "
                 "psValueToString(ctx.named[key]);")
        L.append(f"    const decision = plan{spec.family}({{")
        for p in spec.params:
            if p.unsupported or p.type == "switch":
                continue
            if p.position is not None:
                L.append(f"      {p.selection_key}: named('{p.lower}') ?? "
                         f"(ctx.positional[{p.position}] === undefined")
                L.append(f"        ? undefined : "
                         f"psValueToString(ctx.positional[{p.position}])),")
            else:
                L.append(f"      {p.selection_key}: named('{p.lower}'),")
        L.append("    });")
        L.append("    if (!decision.ok) {")
        L.append("      ctx.emitError(`${this.displayName} : "
                 "${decision.message}`);")
        L.append("      return null;")
        L.append("    }")
        L.append("    if (ctx.named['whatif'] !== undefined) {")
        L.append(f"      ctx.emit('What if: {kind} on "
                 f"{spec.cim_class}.');")
        L.append("      return null;")
        L.append("    }")
        L.append(f"    const failure = net.{lower_camel(verb)}"
                 f"{spec.family}?.(decision.plan) ?? '';")
        L.append("    if (failure) {")
        L.append("      ctx.emitError(`${this.displayName} : ${failure}`);")
        L.append("      return null;")
        L.append("    }")
        L.append("    return null;")
        L.append("  }")
        L.append("}")
        return "\n".join(L).rstrip() + "\n"

    L.append(f"    const list = cimFilterReader(ctx, {const_params});")
    positional = [p for p in spec.params if p.position is not None]
    if positional:
        L.append("    const positional = (n: number): string[] | undefined =>")
        L.append("      ctx.positional[n] === undefined")
        L.append("        ? undefined : [psValueToString(ctx.positional[n])];")
    L.append(f"    const selection: {spec.selection_type} = {{")
    for p in spec.filters:
        src = f"list('{p.lower}')"
        if p.position is not None:
            src += f" ?? positional({p.position})"
        L.append(f"      {p.selection_key}: {src},")
    L.append("    };")

    if spec.enums:
        L.append(f"    const enumProblem = {fam_lower}"
                 f"EnumProblem(selection);")
        L.append("    if (enumProblem) {")
        L.append("      ctx.emitError(`${this.displayName} : "
                 "${enumProblem}`);")
        L.append("      return null;")
        L.append("    }")
    for p in spec.integers:
        fn = f"{fam_lower}{upper_camel(p.name)}Problem"
        L.append(f"    for (const given of selection.{p.selection_key} "
                 f"?? []) {{")
        L.append(f"      const problem = {fn}(given);")
        L.append("      if (problem) {")
        L.append("        ctx.emitError(`${this.displayName} : ${problem}`);")
        L.append("        return null;")
        L.append("      }")
        L.append("    }")

    getter = f"get{spec.family}"
    if spec.provider:
        getter = spec.provider
    L.append(f"    const rows = net.{getter}?.() ?? [];")
    L.append(f"    const matched = select{spec.family}(rows, selection);")
    L.append(f"    if (matched.length === 0 && "
             f"!{fam_lower}SelectionIsEmpty(selection)) {{")
    L.append(f"      ctx.emitError(`${{this.displayName}} : "
             f"${{noMatching{spec.family}(selection)}}`);")
    L.append("      return null;")
    L.append("    }")

    if verb == "Get":
        L.append("    return matched.map(r => ({")
        out = spec.output or {k: k for k in spec.row}
        for prop, src in out.items():
            L.append(f"      {prop}: r.{src},")
        L.append("    } as Record<string, PSValue>)) as PSValue;")
    else:
        L.append("    if (ctx.named['whatif'] !== undefined) {")
        L.append("      for (const row of matched) {")
        L.append(f"        ctx.emit(`What if: {kind} on "
                 f"{spec.cim_class} ${{JSON.stringify(row)}}.`);")
        L.append("      }")
        L.append("      return null;")
        L.append("    }")
        L.append(f"    net.{lower_camel(verb)}{spec.family}?.(matched);")
        L.append("    if (ctx.named['passthru'] === undefined) return null;")
        L.append("    return matched as unknown as PSValue;")
    L.append("  }")
    L.append("}")
    return "\n".join(L).rstrip() + "\n"


def render_probe(spec: Spec) -> str:
    display = f"Get-{spec.name}"
    L = []
    L.append("/**")
    L.append(f" * TODO(mesure) : decrire ici ce que la mesure a TROUVE avant")
    L.append(f" * correctif sur {display} — la commande tapee, l'etat relu,")
    L.append(" * et l'ecart constate. Un en-tete qui ne dit pas la mesure ne")
    L.append(" * vaut rien.")
    L.append(" *")
    L.append(" * TODO(discrimination) : `git stash`, relancer, et ecrire ici")
    L.append(" * combien de cas tombent avant correctif. NOMMER ceux qui")
    L.append(" * passent des deux cotes, chacun avec sa raison (TEMOIN,")
    L.append(" * non-regression, structurel).")
    L.append(" */")
    L.append("")
    L.append("import { describe, it, expect } from 'vitest';")
    L.append("import { WindowsPC } from '@/network/devices/WindowsPC';")
    L.append("import { LinuxServer } from '@/network/devices/LinuxServer';")
    L.append("import { Cable } from '@/network/hardware/Cable';")
    L.append("import { IPAddress, SubnetMask } from "
             "'@/network/core/types';")
    L.append("")
    L.append("async function lab() {")
    L.append("  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);")
    L.append("  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);")
    L.append("  pc.powerOn(); srv.powerOn();")
    L.append("  new Cable('c1').connect(pc.getPort('eth0')!, "
             "srv.getPort('eth0')!);")
    L.append("  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), "
             "new SubnetMask('255.255.255.0'));")
    L.append("  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), "
             "new SubnetMask('255.255.255.0'));")
    L.append("  const interp = pc.getPowerShellInterpreter();")
    L.append("  const ps = (line: string): Promise<string> =>")
    L.append("    Promise.resolve(interp.execute(line)) as Promise<string>;")
    L.append("  const cmd = (line: string): Promise<string> =>")
    L.append("    pc.executeCmdCommand(line);")
    L.append("  return { pc, srv, ps, cmd };")
    L.append("}")
    L.append("")
    L.append(f"describe('{display} rend ce que la machine porte', () => {{")
    L.append("  it('TEMOIN : la vue rend au moins une ligne reelle', "
             "async () => {")
    L.append("    const { ps } = await lab();")
    L.append(f"    const out = await ps('{display}');")
    L.append("    expect(out.trim()).not.toBe('');")
    L.append("  });")
    L.append("")
    for p in spec.filters:
        L.append(f"  it('-{p.name} filtre pour de bon', async () => {{")
        L.append("    const { ps } = await lab();")
        L.append(f"    const out = await ps('{display} -{p.name} <valeur>');")
        L.append("    expect(out).toBeDefined();")
        L.append("  });")
        L.append("")
    for p in spec.enums:
        L.append(f"  it('-{p.name} refuse une valeur hors de "
                 f"l enumeration', async () => {{")
        L.append("    const { ps } = await lab();")
        L.append(f"    const out = await ps('{display} -{p.name} Zorglub');")
        L.append(f"    expect(out).toContain(\"Cannot validate argument on "
                 f"parameter '{p.name}'\");")
        L.append("  });")
        L.append("")
    L.append("  it('une selection qui ne correspond a rien REFUSE au lieu "
             "de tout rendre', async () => {")
    L.append("    const { ps } = await lab();")
    L.append(f"    const out = await ps('{display} -{spec.filters[0].name} "
             f"zorglub');")
    L.append(f"    expect(out).toContain('No {spec.cim_class} objects "
             f"found');")
    L.append("  });")
    L.append("});")
    return "\n".join(L) + "\n"


HELPERS_TS = """import type { CmdletContext } from './CmdletContext';
import type { INetworkProvider } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';

export function requireNetwork(ctx: CmdletContext): INetworkProvider {
  const net = ctx.providers.network;
  if (!net) throw new PSRuntimeError('No network provider on this device.');
  return net;
}

export function cimFilterReader(
  ctx: CmdletContext, filters?: readonly string[],
): (key: string) => string[] | undefined {
  const allowed = filters === undefined
    ? null : new Set(filters.map(f => f.toLowerCase()));
  return (key: string): string[] | undefined => {
    const raw = allowed !== null && !allowed.has(key)
      ? undefined : ctx.named[key];
    if (raw === undefined) return undefined;
    return (Array.isArray(raw) ? raw : [raw]).map(psValueToString);
  };
}

export function resolvedAliases(
  net: INetworkProvider, aliases: string[] | undefined,
): string[] | undefined {
  return aliases?.map(a => net.resolveNetInterface({ alias: a })?.alias ?? a);
}
"""


EXAMPLE_SPEC: dict[str, Any] = {
    "family": "NetNeighbor",
    "noun": "NetNeighbor",
    "cim_class": "MSFT_NetNeighbor",
    "module": "netNeighbor",
    "provider": "getNeighbors",
    "description": "Gets the neighbor cache entries.",
    "verbs": ["Get", "Remove"],
    "row": {
        "ifIndex": "number",
        "ifAlias": "string",
        "ipAddress": "string",
        "linkLayerAddress": "string",
        "state": "string",
        "addressFamily": "string",
        "policyStore": "string",
    },
    "output": {
        "InterfaceIndex": "ifIndex",
        "InterfaceAlias": "ifAlias",
        "IPAddress": "ipAddress",
        "LinkLayerAddress": "linkLayerAddress",
        "State": "state",
        "AddressFamily": "addressFamily",
        "PolicyStore": "policyStore",
    },
    "params": [
        {"name": "IPAddress", "type": "string[]", "position": 0,
         "field": "ipAddress"},
        {"name": "InterfaceIndex", "type": "string[]", "field": "ifIndex"},
        {"name": "InterfaceAlias", "type": "string[]", "field": "ifAlias"},
        {"name": "LinkLayerAddress", "type": "string[]",
         "field": "linkLayerAddress"},
        {"name": "State", "type": "enum", "field": "state",
         "enum": ["Unreachable", "Incomplete", "Probe", "Delay", "Stale",
                  "Reachable", "Permanent"]},
        {"name": "AddressFamily", "type": "enum", "field": "addressFamily",
         "enum": ["IPv4", "IPv6"]},
        {"name": "PolicyStore", "type": "enum", "field": "policyStore",
         "enum": ["ActiveStore", "PersistentStore"]},
        {"name": "AssociatedIPInterface", "type": "string",
         "unsupported": "no CIM instance pipeline binds an IP interface "
                        "object"},
        {"name": "IncludeAllCompartments", "type": "switch",
         "unsupported": "network compartments are not modelled"},
        {"name": "CimSession", "type": "string[]",
         "unsupported": "no remote CIM session exists in this simulator"},
    ],
}


def spec_from_json(path: Path) -> Spec:
    raw = json.loads(path.read_text())
    params = [Param(**{**p, "name": upper_camel(p["name"])})
              for p in raw.pop("params", [])]
    return Spec(params=params, **raw)


def spec_from_args(args: argparse.Namespace) -> Spec:
    params = [parse_param(t) for t in (args.param or [])]
    row = dict(parse_row(t) for t in (args.row or []))
    output: dict[str, str] = {}
    for t in (args.output or []):
        if ":" not in t:
            die(f"--output expects Prop:rowField, got '{t}'")
        prop, src = t.split(":", 1)
        output[prop] = src
    return Spec(
        family=args.family,
        cim_class=args.cim_class,
        verbs=args.verb or ["Get"],
        noun=args.noun or "",
        params=params,
        row=row,
        output=output,
        provider=args.provider or "",
        description=args.description or "",
        module=args.module or "",
    )


def write_file(path: Path, content: str, force: bool, dry: bool) -> None:
    target = REPO_ROOT / path
    if dry:
        print(f"--- {path} " + "-" * max(0, 68 - len(str(path))))
        print(content)
        return
    if target.exists() and not force:
        die(f"{path} already exists (pass --force to overwrite)")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    print(f"wrote {path}")


def generate(spec: Spec, args: argparse.Namespace) -> None:
    spec.validate()
    module_path = WINDOWS_DIR / f"{spec.module_name}.ts"
    write_file(module_path, render_selection_module(spec),
               args.force, args.dry_run)

    for verb in spec.verbs:
        cls_file = CMDLET_DIR / "net" / f"{verb}{spec.name}Cmdlet.ts"
        write_file(cls_file, render_cmdlet(spec, verb),
                   args.force, args.dry_run)

    if not args.no_probe:
        probe = PROBE_DIR / f"probe-{spec.module_name.lower()}.test.ts"
        write_file(probe, render_probe(spec), args.force, args.dry_run)

    if args.emit_helpers:
        write_file(CIM_COMMON, HELPERS_TS, args.force, args.dry_run)

    if not args.dry_run:
        print()
        print("next steps, none of which the generator can do for you:")
        print(f"  1. give {spec.provider or 'get' + spec.family}() a real "
              f"implementation on INetworkProvider and WindowsPSProviders,")
        print("     reading the store the cmd-side view already reads — a "
              "second store is the defect this repo keeps closing;")
        print(f"  2. register each cmdlet in the cmdlet registry;")
        print("  3. MEASURE before you keep any of this: type the command, "
              "read the state back, record the gap;")
        print("  4. fill the probe header with the real numbers, discriminate "
              "it with `git stash`;")
        print("  5. delete whatever legacy handler served this cmdlet — "
              "a duplicate is a defect.")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="new-cmdlet.py",
        description="Generate cmdlet boilerplate (selection module, one file "
                    "per cmdlet, probe skeleton) for the network simulator.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:

  scripts/new-cmdlet.py example > /tmp/netneighbor.json
  scripts/new-cmdlet.py from-spec /tmp/netneighbor.json --dry-run

  scripts/new-cmdlet.py new NetUDPEndpoint \\
      --cim-class MSFT_NetUDPEndpoint --provider getUdpEndpoints \\
      --verb Get \\
      --row localAddress:string --row localPort:number \\
      --row pid:number --row processName:string \\
      --param LocalAddress:string[]:pos=0:field=localAddress \\
      --param LocalPort:uint16:pos=1:field=localPort \\
      --param OwningProcess:string[]:field=pid \\
      --param CimSession:string[]:unsupported=no remote CIM session exists \\
      --output LocalAddress:localAddress --output LocalPort:localPort \\
      --output OwningProcess:pid --output ProcessName:processName

parameter mini-language:  Name:type[:opt[:opt...]]
  types    string string[] uint16 uint32 enum switch ip ipprefix mac datetime
  opts     pos=N  mandatory  value  enum=A|B|C  field=rowField  alias=x
           unsupported=<why this simulator cannot evaluate it>

  `value` marks a SINGULAR parameter that a Set-* cmdlet writes, as opposed
  to the PLURAL parameters that select which rows it writes to — the rule
  Microsoft's own documentation follows and this repository enforces.
""")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--force", action="store_true",
                       help="overwrite files that already exist")
        p.add_argument("--dry-run", action="store_true",
                       help="print what would be written, write nothing")
        p.add_argument("--no-probe", action="store_true",
                       help="skip the probe test skeleton")
        p.add_argument("--emit-helpers", action="store_true",
                       help="also write the shared cimCommon helpers "
                            "(requireNetwork, cimFilterReader, "
                            "resolvedAliases)")

    new = sub.add_parser("new", help="generate a family from CLI arguments")
    new.add_argument("family", help="CamelCase family name, e.g. NetNeighbor")
    new.add_argument("--cim-class", required=True,
                     help="CIM class name, e.g. MSFT_NetNeighbor")
    new.add_argument("--noun", help="cmdlet noun if it differs from family")
    new.add_argument("--module", help="module basename under windows/")
    new.add_argument("--provider",
                     help="INetworkProvider getter, e.g. getNeighbors")
    new.add_argument("--description", help="one-line SYNOPSIS for Get-Help")
    new.add_argument("--verb", action="append",
                     choices=sorted(VERB_KINDS),
                     help="repeatable; defaults to Get")
    new.add_argument("--param", action="append", metavar="SPEC",
                     help="repeatable; see the parameter mini-language")
    new.add_argument("--row", action="append", metavar="NAME:TYPE",
                     help="repeatable row field, type string|number|boolean")
    new.add_argument("--output", action="append", metavar="PROP:FIELD",
                     help="repeatable PSObject property mapping")
    common(new)

    frm = sub.add_parser("from-spec", help="generate from a JSON spec file")
    frm.add_argument("spec", type=Path)
    common(frm)

    ex = sub.add_parser("example", help="print an example JSON spec")

    helpers = sub.add_parser("helpers",
                             help="write only the shared cimCommon helpers")
    common(helpers)

    args = parser.parse_args()

    if args.command == "example":
        print(json.dumps(EXAMPLE_SPEC, indent=2))
        return

    if args.command == "helpers":
        write_file(CIM_COMMON, HELPERS_TS, args.force, args.dry_run)
        return

    spec = (spec_from_json(args.spec) if args.command == "from-spec"
            else spec_from_args(args))
    generate(spec, args)


if __name__ == "__main__":
    main()
