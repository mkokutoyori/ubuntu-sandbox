/*
 * Audit — tout parametre qu'une cmdlet LIT doit etre un parametre qu'elle
 * ANNONCE.
 *
 * `-<Tab>` interroge `PSRuntime.getCommandParameters`, qui rend la
 * declaration `ICmdlet.parameters` et rien d'autre. Une cmdlet qui lit
 * `ctx.named['interfacealias']` sans le declarer accepte donc un
 * parametre que la completion ne propose jamais : l'operateur doit
 * deviner un nom que la machine connait. C'est le defaut mesure sur
 * `Set-DnsClientServerAddress`, et il ne s'agissait pas d'un cas isole —
 * 435 cmdlets ont ete auditees, 49 lisaient au moins un parametre non
 * declare, 98 noms en tout.
 *
 * Cet audit ferme la CLASSE plutot que l'instance : il relit le source de
 * chaque cmdlet enregistree, releve chaque `ctx.named['x']` et exige que
 * `x` soit declare — ou nomme dans la table d'ALIAS ci-dessous, qui dit
 * quels noms de rechange le shell honore sans les proposer, exactement
 * comme PowerShell ne complete que le nom canonique.
 *
 * La table est une DECLARATION, pas une deduction : un alias ajoute au
 * code sans etre inscrit ici fait tomber l'audit, ce qui est le but.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';

const CMDLET_ROOT = 'src/powershell/cmdlets';

/** alias lu par le gestionnaire -> nom canonique que la completion propose (null : le canonique est deja lu ailleurs dans la meme expression). */
const HONOURED_ALIASES: Record<string, Record<string, string | null>> = {
  'measure-object': { max: 'Maximum', min: 'Minimum' },
  'add-netlbfoteamnic': { ifalias: 'Name', interfacealias: 'Name' },
  'add-netlbfoteammember': { am: 'AdministrativeMode' },
  'set-netlbfoteammember': { am: 'AdministrativeMode' },
  'test-netconnection': { cn: 'ComputerName', remoteaddress: 'ComputerName' },
  'set-netadapter': { linklayeraddress: 'MacAddress' },
  'new-item': { type: 'ItemType' },
  'out-file': { path: 'FilePath' },
  'start-process': { arguments: 'ArgumentList', path: 'FilePath' },
  'set-service': { starttype: 'StartupType' },
  'new-service': { binarypath: 'BinaryPathName', starttype: 'StartupType' },
  'format-wide': { columns: 'Column' },
  'limit-eventlog': { maxsize: 'MaximumSize' },
  'add-localgroupmember': { members: 'Member' },
  'remove-localgroupmember': { members: 'Member' },
};

interface ScannedCmdlet {
  name: string;
  declared: string[];
  used: string[];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

function stringsOf(node: ts.Node, consts: Map<string, string[]>): string[] {
  if (ts.isStringLiteral(node)) return [node.text];
  if (ts.isAsExpression(node)) return stringsOf(node.expression, consts);
  if (ts.isSpreadElement(node)) return stringsOf(node.expression, consts);
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(e => stringsOf(e, consts));
  if (ts.isIdentifier(node)) return consts.get(node.text) ?? [];
  return [];
}

function scanFile(path: string): ScannedCmdlet[] {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const consts = new Map<string, string[]>();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const values = stringsOf(decl.initializer, consts);
      if (values.length > 0) consts.set(decl.name.text, values);
    }
  }

  const classes = new Map<string, { name: string | null; declared: string[]; used: string[]; base: string | null }>();
  for (const statement of sf.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    let name: string | null = null;
    let declared: string[] = [];
    for (const member of statement.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      if (member.name.text === 'name' && member.initializer && ts.isStringLiteral(member.initializer)) {
        name = member.initializer.text;
      }
      if (member.name.text === 'parameters' && member.initializer) {
        declared = stringsOf(member.initializer, consts);
      }
    }
    const used = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'named'
        && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
        used.add(node.argumentExpression.text.toLowerCase());
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
    const heritage = statement.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    const baseExpr = heritage?.types[0]?.expression;
    classes.set(statement.name.text, {
      name, declared, used: [...used],
      base: baseExpr && ts.isIdentifier(baseExpr) ? baseExpr.text : null,
    });
  }

  const out: ScannedCmdlet[] = [];
  for (const [, info] of classes) {
    if (!info.name) continue;
    const declared = [...info.declared];
    const used = [...info.used];
    let base = info.base;
    const guard = new Set<string>();
    while (base && classes.has(base) && !guard.has(base)) {
      guard.add(base);
      const parent = classes.get(base)!;
      declared.push(...parent.declared);
      used.push(...parent.used);
      base = parent.base;
    }
    out.push({ name: info.name, declared, used });
  }
  return out;
}

const SCANNED = sourceFiles(CMDLET_ROOT).flatMap(scanFile);

describe('Audit — un parametre lu est un parametre annonce', () => {
  it('a bien releve toutes les cmdlets du depot', () => {
    expect(SCANNED.length).toBeGreaterThan(400);
  });

  it('ne laisse aucune cmdlet lire un parametre qu elle n annonce pas', () => {
    const offenders: string[] = [];
    for (const cmdlet of SCANNED) {
      const declared = new Set(cmdlet.declared.map(d => d.toLowerCase()));
      const aliases = HONOURED_ALIASES[cmdlet.name.toLowerCase()] ?? {};
      for (const key of cmdlet.used) {
        if (declared.has(key)) continue;
        if (key in aliases) continue;
        offenders.push(`${cmdlet.name} lit -${key} sans le declarer`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exige que le canonique de chaque alias honore soit annonce', () => {
    const byName = new Map(SCANNED.map(c => [c.name.toLowerCase(), c]));
    const orphans: string[] = [];
    for (const [cmdletName, aliases] of Object.entries(HONOURED_ALIASES)) {
      const cmdlet = byName.get(cmdletName);
      if (!cmdlet) { orphans.push(`${cmdletName} : cmdlet inconnue dans la table d alias`); continue; }
      const declared = new Set(cmdlet.declared.map(d => d.toLowerCase()));
      for (const [alias, canonical] of Object.entries(aliases)) {
        if (canonical === null) continue;
        if (!declared.has(canonical.toLowerCase())) {
          orphans.push(`${cmdletName} : alias -${alias} renvoie a -${canonical}, qui n est pas annonce`);
        }
      }
    }
    expect(orphans).toEqual([]);
  });
});

describe('Audit — la completion rend ce que la cmdlet declare', () => {
  const shell = (): PowerShellSubShell => {
    const pc = new WindowsPC('windows-pc', 'PC-AUDIT');
    pc.powerOn();
    return PowerShellSubShell.create(pc).subShell;
  };

  it('propose -InterfaceAlias et -ServerAddresses pour Set-DnsClientServerAddress', () => {
    const proposals = shell().getCompletions('Set-DnsClientServerAddress -');
    expect(proposals).toContain('-InterfaceAlias');
    expect(proposals).toContain('-ServerAddresses');
  });

  it('filtre sur le prefixe deja tape', () => {
    const proposals = shell().getCompletions('Set-DnsClientServerAddress -Ser');
    expect(proposals).toContain('-ServerAddresses');
    expect(proposals).not.toContain('-InterfaceAlias');
  });

  it('herite de la classe de base, comme Start-Service de son action de service', () => {
    const proposals = shell().getCompletions('Start-Service -');
    expect(proposals).toContain('-Name');
    expect(proposals).toContain('-DisplayName');
  });

  it('layere toujours les parametres communs de PowerShell', () => {
    const proposals = shell().getCompletions('Set-DnsClientServerAddress -');
    expect(proposals).toContain('-ErrorAction');
    expect(proposals).toContain('-Verbose');
  });
});
