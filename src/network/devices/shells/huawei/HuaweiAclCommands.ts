/**
 * HuaweiAclCommands - Huawei VRP ACL (Access Control List) commands
 *
 * Huawei ACL numbering:
 *   2000-2999: Basic ACL (matches on source IP only)
 *   3000-3999: Advanced ACL (matches on src/dst IP, protocol, ports)
 *
 * Commands:
 *   acl <number>                        — enter ACL configuration view
 *   rule permit/deny [source/dest/ip]   — add rule
 *   undo acl <number>                   — delete ACL
 *   display acl <number>                — show ACL rules
 *   traffic-filter inbound/outbound acl <number> — apply ACL to interface
 */

import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';
import { formatHuaweiAcl, formatHuaweiAclRules } from './HuaweiAclFormat';
import { rendreErreurVrp } from '../cli-utils';
import { analyserAcl } from './HuaweiAclGrammar';
import { analyserRegleVrp, parseHuaweiPortSpec } from './HuaweiAclRule';

export { parseHuaweiPortSpec };

export type HuaweiACLMode = 'acl-basic' | 'acl-advanced';

export interface HuaweiACLContext {
  r(): Router;
  setMode(mode: string): void;
  getSelectedACLNumber(): number | null;
  setSelectedACLNumber(n: number | null): void;
  getSelectedACLMode(): HuaweiACLMode | null;
  setSelectedACLMode(m: HuaweiACLMode | null): void;
  getSelectedACLName(): string | null;
  setSelectedACLName(n: string | null): void;
  getSelectedInterface(): string | null;
}

export function registerHuaweiACLSystemCommands(
  trie: CommandTrie,
  ctx: HuaweiACLContext,
): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('acl', 'Configure Access Control List', (args, ligne) => {
    const a = analyserAcl(args);
    if (a.statut === 'refus') return rendreErreurVrp(a.err, ligne ?? `acl ${args.join(' ')}`);
    const mode = a.cmd.type === 'advanced' ? 'acl-advanced' : 'acl-basic';
    // La liste existe DES son ouverture, meme vide. Elle n'etait
    // materialisee qu'a la premiere regle, de sorte que `step` et
    // `description` ecrits juste apres n'avaient rien ou se poser, et que
    // `display acl 2000` annoncait une liste inexistante.
    if (a.cmd.kind === 'nom') {
      ctx.setSelectedACLName(a.cmd.nom);
      ctx.setSelectedACLNumber(null);
      ctx.r()._ensureNamedAccessList(a.cmd.nom, mode === 'acl-advanced' ? 'extended' : 'standard');
    } else {
      ctx.setSelectedACLNumber(a.cmd.numero);
      ctx.setSelectedACLName(null);
      ctx.r()._aclEnsure(a.cmd.numero);
    }
    ctx.setSelectedACLMode(mode);
    ctx.setMode(mode);
    return '';
  });
  // `advanced` et `basic` étaient extraits du texte de ce handler par
  // `autoContinuations`, qui ne trouve pas de description pour eux dans
  // son dictionnaire global : `acl ?` listait deux mots nus. Les
  // curater les fait sortir de l'extraction avec leur libellé.
  trie.addCompletionKeywords('acl', [
    { keyword: 'advanced', description: 'Advanced ACL (3000-3999)' },
    { keyword: 'basic', description: 'Basic ACL (2000-2999)' },
    { keyword: 'name', description: 'Named ACL' },
    { keyword: 'number', description: 'ACL number' },
  ]);

  trie.registerGreedy('undo acl', 'Delete Access Control List', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    if (args[0].toLowerCase() === 'name' && args.length >= 2) {
      getRouter().removeNamedAccessList(args[1]);
      return '';
    }
    const numTok = args[0].toLowerCase() === 'number' ? args[1] : args[0];
    const num = parseInt(numTok, 10);
    if (isNaN(num)) return 'Error: Invalid ACL number.';
    getRouter().removeAccessList(num);
    return '';
  });
}

function aclRef(ctx: HuaweiACLContext): number | string | null {
  return ctx.getSelectedACLNumber() ?? ctx.getSelectedACLName();
}

/**
 * Les commandes communes aux deux vues d'ACL. `step` et `description`
 * etaient rangees dans des proprietes ad hoc du routeur
 * (`_huaweiAclStep`, `_huaweiAclDesc`) que PERSONNE ne lisait : la vue
 * annoncait « ACL's step is 5 » en dur et la description n'etait rendue
 * nulle part. Elles vivent desormais sur la liste elle-meme.
 */
function registerAclCommonExtras(trie: CommandTrie, ctx: HuaweiACLContext): void {
  trie.registerGreedy('step', 'Set ACL rule renumbering step', (args, ligne) => {
    const n = parseInt(args[0] ?? '', 10);
    if (isNaN(n) || n < 1) {
      return rendreErreurVrp({ kind: 'wrong', token: args[0] ?? 'step' }, ligne ?? `step ${args.join(' ')}`);
    }
    const ref = aclRef(ctx);
    if (ref === null) return 'Error: No ACL selected.';
    ctx.r()._aclSetStep(ref, n);
    return '';
  });
  trie.registerGreedy('description', 'Set ACL description', (args) => {
    const ref = aclRef(ctx);
    if (ref === null) return 'Error: No ACL selected.';
    ctx.r()._aclSetDescription(ref, args.join(' '));
    return '';
  });
  trie.registerGreedy('undo rule', 'Delete an ACL rule', (args, ligne) => {
    const ref = aclRef(ctx);
    if (ref === null) return 'Error: No ACL selected.';
    const id = parseInt(args[0] ?? '', 10);
    if (isNaN(id)) {
      return rendreErreurVrp({ kind: 'incomplete' }, ligne ?? `undo rule ${args.join(' ')}`);
    }
    return ctx.r()._aclRemoveEntry(ref, id) ? '' : `Error: Rule ${id} does not exist.`;
  });
  trie.registerGreedy('undo description', 'Remove ACL description', () => {
    const ref = aclRef(ctx);
    if (ref !== null) ctx.r()._aclSetDescription(ref, '');
    return '';
  });
  trie.registerGreedy('undo step', 'Restore the default step', () => {
    const ref = aclRef(ctx);
    if (ref !== null) ctx.r()._aclSetStep(ref, ctx.r()._aclDefaultStep());
    return '';
  });
  // `display` est utilisable depuis TOUTE vue sur VRP ; il etait refuse
  // depuis la vue ACL, c'est-a-dire precisement la ou l'on ecrit les
  // regles qu'on veut relire.
  registerHuaweiACLDisplayCommands(trie, () => ctx.r());
}

/** L'ajout d'une regle, identique aux deux vues a leur grammaire pres. */
function registerRuleCommand(
  trie: CommandTrie, ctx: HuaweiACLContext, kind: 'basic' | 'advanced',
): void {
  trie.registerGreedy('rule', 'Add ACL rule', (args, ligne) => {
    const aclNum = ctx.getSelectedACLNumber();
    const aclName = ctx.getSelectedACLName();
    if (aclNum === null && aclName === null) return 'Error: No ACL selected.';

    const a = analyserRegleVrp(args, kind);
    if (a.statut === 'refus') return rendreErreurVrp(a.err, ligne ?? `rule ${args.join(' ')}`);

    const type = kind === 'advanced' ? 'extended' : 'standard';
    if (aclName) ctx.r().addNamedAccessListEntry(aclName, type, a.action, a.opts);
    else ctx.r().addAccessListEntry(aclNum!, a.action, a.opts);
    return '';
  });
}

export function buildHuaweiBasicACLCommands(trie: CommandTrie, ctx: HuaweiACLContext): void {
  registerAclCommonExtras(trie, ctx);
  registerRuleCommand(trie, ctx, 'basic');
}

export function buildHuaweiAdvancedACLCommands(trie: CommandTrie, ctx: HuaweiACLContext): void {
  registerAclCommonExtras(trie, ctx);
  registerRuleCommand(trie, ctx, 'advanced');
}

export function registerHuaweiACLInterfaceCommands(
  trie: CommandTrie,
  ctx: HuaweiACLContext,
): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('traffic-filter', 'Apply ACL to interface', (args) => {
    if (args.length < 3) return 'Error: Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected';

    const direction = args[0].toLowerCase();
    if (direction !== 'inbound' && direction !== 'outbound') return 'Error: Expected inbound or outbound.';

    if (args[1].toLowerCase() !== 'acl') return 'Error: Expected "acl".';

    // `traffic-filter { inbound | outbound } acl { <numero> | name <nom> }`.
    // La forme NOMMEE etait refusee alors que VRP la documente, de sorte
    // qu'une ACL nommee ne pouvait etre appliquee nulle part.
    let ref: number | string;
    if (args[2].toLowerCase() === 'name') {
      if (!args[3]) return 'Error: Incomplete command.';
      ref = args[3];
    } else {
      const n = parseInt(args[2], 10);
      if (isNaN(n)) return 'Error: Invalid ACL number.';
      ref = n;
    }

    const dir = direction === 'inbound' ? 'in' : 'out';
    getRouter().setInterfaceACL(ifName, dir as 'in' | 'out', ref);
    return '';
  });

  trie.registerGreedy('undo traffic-filter', 'Remove ACL from interface', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected';

    const direction = args[0].toLowerCase();
    const dir = direction === 'inbound' ? 'in' : 'out';
    getRouter().removeInterfaceACL(ifName, dir as 'in' | 'out');
    return '';
  });
}

export function registerHuaweiACLDisplayCommands(
  trie: CommandTrie,
  getRouter: () => Router,
): void {
  trie.registerGreedy('display acl', 'Display ACL configuration', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const router = getRouter();

    if (args[0].toLowerCase() === 'all') return formatAllACLs(router);

    const ref: number | string = args[0].toLowerCase() === 'name' && args[1]
      ? args[1]
      : parseInt(args[0], 10);
    if (typeof ref === 'number' && isNaN(ref)) return 'Error: Invalid ACL number.';

    const acl = router._aclFind(ref);
    // Une liste existante mais VIDE existe : elle etait annoncee
    // inexistante, ce qui confond deux etats distincts et fait chercher
    // une faute de frappe la ou il manque simplement une regle.
    if (!acl) return `Error: ACL ${ref} does not exist.`;
    return formatHuaweiAcl(acl, router._aclDefaultStep());
  });
}

function formatAllACLs(router: Router): string {
  const acls = router._getAccessListsInternal();
  if (acls.length === 0) return 'Total 0 ACL(s)';
  const lines: string[] = [];
  for (const acl of acls) lines.push(formatHuaweiAcl(acl, router._aclDefaultStep()));
  lines.push(`Total ${acls.length} ACL(s)`);
  return lines.join('\n');
}

export function runningConfigACL(router: Router): string[] {
  const acls = router._getAccessListsInternal();
  const lines: string[] = [];

  for (const acl of acls) {
    lines.push('#');
    if (acl.name) {
      lines.push(`acl name ${acl.name} ${acl.type === 'extended' ? 'advanced' : 'basic'}`);
    } else if (acl.id !== undefined) {
      lines.push(`acl number ${acl.id}`);
    } else {
      continue;
    }
    // Une configuration rejouee doit reproduire la liste : le pas et la
    // description en font partie, et n'y figuraient pas.
    if (acl.step !== undefined && acl.step !== router._aclDefaultStep()) {
      lines.push(` step ${acl.step}`);
    }
    if (acl.description) lines.push(` description ${acl.description}`);
    lines.push(...formatHuaweiAclRules(acl, { showCounts: false }));
  }

  return lines;
}

export function runningConfigInterfaceACL(router: Router, ifName: string): string[] {
  const lines: string[] = [];
  const inACL = router.getInterfaceACL(ifName, 'in');
  const outACL = router.getInterfaceACL(ifName, 'out');
  if (inACL !== null) lines.push(` traffic-filter inbound acl ${inACL}`);
  if (outACL !== null) lines.push(` traffic-filter outbound acl ${outACL}`);
  return lines;
}
