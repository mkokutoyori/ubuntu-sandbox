/**
 * `a2ensite` / `a2dissite` / `a2enmod` / `a2dismod`.
 *
 * Ces quatre commandes n'existaient pas. Tout le reste du module Apache
 * les nomme — « `a2ensite` is only an `ln -s` », « `a2enmod` is only an
 * `ln -s` and `a2dismod` only an `rm` » — et cette observation était
 * juste, mais elle a servi de raison de NE PAS les écrire. Le
 * raisonnement ne tient pas : faire marcher `ln -s` à la main n'exige
 * pas que la commande soit absente. Un apprenant qui suit n'importe quel
 * tutoriel Apache tape `a2ensite default-ssl` à sa deuxième ligne et
 * reçoit `command not found`.
 *
 * Elles restent donc CE QU'ELLES SONT : un lien symbolique posé ou
 * retiré, rien de plus. Un lien fait à la main continue de valoir, et
 * `apachectl -M` le voit, puisqu'il lit le répertoire.
 *
 * Deux différences réelles entre les paires, reproduites parce qu'elles
 * disent quelque chose : un site se recharge (`reload`), un module se
 * REDÉMARRE (`restart`) — charger du code dans le serveur n'est pas
 * relire un fichier.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import {
  APACHE_SITES_AVAILABLE, APACHE_SITES_ENABLED,
  APACHE_MODS_AVAILABLE, APACHE_MODS_ENABLED,
} from '../../http/apache/ApacheFiles';

interface Outcome { output: string; exitCode: number }

interface Famille {
  /** `Site` ou `Module` — le mot qu'Apache emploie dans ses messages. */
  readonly nom: string;
  readonly available: string;
  readonly enabled: string;
  /** L'extension du fichier qui EST l'objet : `.conf` ou `.load`. */
  readonly principal: string;
  /** Un module a aussi un `.conf` facultatif, qu'on lie avec le reste. */
  readonly secondaire?: string;
  /** Ce qu'il faut faire ensuite, et ce n'est pas la même chose. */
  readonly apres: string;
}

const SITE: Famille = {
  nom: 'Site',
  available: APACHE_SITES_AVAILABLE,
  enabled: APACHE_SITES_ENABLED,
  principal: '.conf',
  apres: 'systemctl reload apache2',
};

const MODULE: Famille = {
  nom: 'Module',
  available: APACHE_MODS_AVAILABLE,
  enabled: APACHE_MODS_ENABLED,
  principal: '.load',
  secondaire: '.conf',
  apres: 'systemctl restart apache2',
};

/**
 * `a2ensite default-ssl` et `a2ensite default-ssl.conf` désignent le même
 * site : le vrai script tolère le suffixe, et l'omettre est la forme que
 * tout le monde tape.
 */
function baseName(arg: string, suffixe: string): string {
  return arg.endsWith(suffixe) ? arg.slice(0, -suffixe.length) : arg;
}

function activer(ctx: LinuxCommandContext, f: Famille, args: string[]): Outcome {
  const vfs = ctx.executor.vfs;
  const noms = args.filter((a) => !a.startsWith('-'));
  if (noms.length === 0) {
    return { output: `Your choices are: ${disponibles(ctx, f).join(' ')}\nWhich ${f.nom.toLowerCase()}(s) do you want to enable (wildcards ok)?`, exitCode: 1 };
  }
  const lignes: string[] = [];
  let change = false;
  for (const brut of noms) {
    const nom = baseName(brut, f.principal);
    const source = `${f.available}/${nom}${f.principal}`;
    if (!vfs.exists(source)) {
      return { output: `ERROR: ${f.nom} ${nom} does not exist!`, exitCode: 1 };
    }
    const cible = `${f.enabled}/${nom}${f.principal}`;
    if (vfs.exists(cible)) {
      lignes.push(`${f.nom} ${nom} already enabled`);
      continue;
    }
    // Le lien est RELATIF, comme celui que Debian pose : un chemin
    // absolu marcherait ici et se verrait au premier `ls -l`.
    const relatif = f.available.split('/').pop() ?? '';
    vfs.createSymlink(cible, `../${relatif}/${nom}${f.principal}`, 0, 0);
    if (f.secondaire) {
      const confSource = `${f.available}/${nom}${f.secondaire}`;
      if (vfs.exists(confSource)) {
        vfs.createSymlink(`${f.enabled}/${nom}${f.secondaire}`,
          `../${relatif}/${nom}${f.secondaire}`, 0, 0);
      }
    }
    lignes.push(`Enabling ${f.nom.toLowerCase()} ${nom}.`);
    change = true;
  }
  if (change) {
    lignes.push('To activate the new configuration, you need to run:');
    lignes.push(`  ${f.apres}`);
  }
  return { output: lignes.join('\n'), exitCode: 0 };
}

function desactiver(ctx: LinuxCommandContext, f: Famille, args: string[]): Outcome {
  const vfs = ctx.executor.vfs;
  const noms = args.filter((a) => !a.startsWith('-'));
  if (noms.length === 0) {
    return { output: `Your choices are: ${actifs(ctx, f).join(' ')}\nWhich ${f.nom.toLowerCase()}(s) do you want to disable (wildcards ok)?`, exitCode: 1 };
  }
  const lignes: string[] = [];
  let change = false;
  for (const brut of noms) {
    const nom = baseName(brut, f.principal);
    const cible = `${f.enabled}/${nom}${f.principal}`;
    if (!vfs.exists(cible)) {
      // Le vrai script distingue « pas activé » de « n'existe pas » :
      // le second est une faute de frappe, le premier un état.
      if (!vfs.exists(`${f.available}/${nom}${f.principal}`)) {
        return { output: `ERROR: ${f.nom} ${nom} does not exist!`, exitCode: 1 };
      }
      lignes.push(`${f.nom} ${nom} already disabled`);
      continue;
    }
    vfs.deleteFile(cible);
    if (f.secondaire) vfs.deleteFile(`${f.enabled}/${nom}${f.secondaire}`);
    lignes.push(`${f.nom} ${nom} disabled.`);
    change = true;
  }
  if (change) {
    lignes.push('To activate the new configuration, you need to run:');
    lignes.push(`  ${f.apres}`);
  }
  return { output: lignes.join('\n'), exitCode: 0 };
}

function entries(ctx: LinuxCommandContext, dir: string, suffixe: string): string[] {
  const noms = ctx.executor.vfs.listDirectory(dir)?.map((e) => e.name) ?? [];
  return noms.filter((n) => n.endsWith(suffixe)).map((n) => baseName(n, suffixe)).sort();
}

function disponibles(ctx: LinuxCommandContext, f: Famille): string[] {
  return entries(ctx, f.available, f.principal);
}

function actifs(ctx: LinuxCommandContext, f: Famille): string[] {
  return entries(ctx, f.enabled, f.principal);
}

function commande(
  name: string, f: Famille, sens: 'on' | 'off', binaire: string,
): LinuxCommand {
  return {
    name,
    needsNetworkContext: true,
    binaryPath: binaire,
    manSection: 8,
    usage: `${name} [-q] ${f.nom.toLowerCase()} ...`,
    help: sens === 'on'
      ? `Enable an Apache2 ${f.nom.toLowerCase()}.`
      : `Disable an Apache2 ${f.nom.toLowerCase()}.`,
    complete: (ctx: LinuxCommandContext) => makeArgCompleter({
      firstWords: sens === 'on' ? disponibles(ctx, f) : actifs(ctx, f),
    })(ctx, []),
    run(ctx: LinuxCommandContext, args: string[]): string {
      return this.runWithStatusSync!(ctx, args).output;
    },
    runWithStatusSync(ctx: LinuxCommandContext, args: string[]): Outcome {
      return sens === 'on' ? activer(ctx, f, args) : desactiver(ctx, f, args);
    },
  };
}

export const a2ensiteCommand = commande('a2ensite', SITE, 'on', '/usr/sbin/a2ensite');
export const a2dissiteCommand = commande('a2dissite', SITE, 'off', '/usr/sbin/a2dissite');
export const a2enmodCommand = commande('a2enmod', MODULE, 'on', '/usr/sbin/a2enmod');
export const a2dismodCommand = commande('a2dismod', MODULE, 'off', '/usr/sbin/a2dismod');
