import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

/**
 * Les locales GENEREES sur l'image. Une Ubuntu minimale n'en porte pas
 * d'autres, et `locale-gen` n'est pas modelise ici — c'est pourquoi
 * `/etc/locale.gen` n'existe pas non plus : declarer le fichier sans
 * savoir le jouer serait un critere range et jamais evalue.
 */
export const INSTALLED_LOCALES = ['C', 'C.UTF-8', 'POSIX', 'en_US.UTF-8'];

const LOCALE_VARIABLES = [
  'LANG', 'LANGUAGE', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE',
  'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS',
  'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
];

const KEYMAPS = ['us', 'uk', 'fr', 'fr-latin1', 'de', 'de-latin1', 'es', 'it', 'be-latin1'];

/**
 * Le prefixe que le client colle devant l'erreur que le demon renvoie
 * (`Failed to issue method call: %s`, extrait du binaire livre). Les
 * messages eux-memes sont ceux de `method_set_locale` et de
 * `process_locale_list_item` (systemd, `src/locale/localed.c`).
 */
function methodCallFailure(message: string): string {
  return `Failed to issue method call: ${message}`;
}

function isInstalled(locale: string): boolean {
  return INSTALLED_LOCALES.some((l) => l.toLowerCase() === locale.toLowerCase());
}

function looksLikeLocale(value: string): boolean {
  return value.length > 0 && !value.includes('/') && /^[\x20-\x7e]+$/.test(value);
}

function setLocale(ctx: LinuxCommandContext, args: string[]): string {
  if (args.length === 0) return methodCallFailure('Locale assignment  not valid, refusing.');

  if (args.length === 1 && !args[0].includes('=')) {
    const wanted = args[0];
    if (!looksLikeLocale(wanted)) {
      return methodCallFailure(`Invalid locale specification: ${wanted}`);
    }
    if (!isInstalled(wanted)) {
      return methodCallFailure(`Specified locale is not installed: ${wanted}`);
    }
    return apply(ctx, wanted);
  }

  let lang: string | null = null;
  for (const assignment of args) {
    const eq = assignment.indexOf('=');
    const name = eq < 0 ? assignment : assignment.slice(0, eq);
    if (eq < 0 || !LOCALE_VARIABLES.includes(name)) {
      return methodCallFailure(`Locale assignment ${assignment} not valid, refusing.`);
    }
    const value = assignment.slice(eq + 1);
    if (!looksLikeLocale(value)) {
      return methodCallFailure(`Locale ${value} is not valid, refusing.`);
    }
    if (!isInstalled(value)) {
      return methodCallFailure(`Locale ${value} not installed, refusing.`);
    }
    if (name === 'LANG') lang = value;
  }
  return lang === null ? '' : apply(ctx, lang);
}

/**
 * Un changement de locale touche la MACHINE, pas une vue : l'identite,
 * `/etc/default/locale` que sa projection reecrit, et l'environnement du
 * shell — celui-la meme que PAM exporte a l'ouverture de session, et
 * dont `locale` et `$LANG` dependent.
 */
function apply(ctx: LinuxCommandContext, locale: string): string {
  ctx.executor.identity.setLocale(locale);
  ctx.executor.projectIdentity();
  return '';
}

function setKeymap(ctx: LinuxCommandContext, args: string[]): string {
  const wanted = args[0];
  if (!wanted) return 'Too few arguments.';
  if (!KEYMAPS.includes(wanted)) {
    return methodCallFailure(`Keymap ${wanted} is not installed.`);
  }
  ctx.executor.identity.setKeymap(wanted);
  ctx.executor.projectIdentity();
  return '';
}

export const localectlCommand: LinuxCommand = {
  name: 'localectl',
  package: 'systemd',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/localectl',
  usage: 'localectl [status|set-locale LOCALE...|list-locales|set-keymap MAP|list-keymaps]',
  help: 'Query or change system locale and keyboard settings.',
  run(ctx: LinuxCommandContext, argv: string[]): string {
    const verb = (argv[0] ?? 'status').toLowerCase();
    switch (verb) {
      case 'status': return ctx.executor.identity.toLocalectl();
      case 'set-locale': return setLocale(ctx, argv.slice(1));
      case 'list-locales': return INSTALLED_LOCALES.filter((l) => l.includes('.')).join('\n');
      case 'set-keymap': return setKeymap(ctx, argv.slice(1));
      case 'list-keymaps': return KEYMAPS.join('\n');
      default: return `Unknown command verb ${verb}.`;
    }
  },
};
