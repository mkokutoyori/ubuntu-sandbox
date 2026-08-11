/**
 * Jouer un dialogue de commande SANS terminal.
 *
 * Un plan d'interaction (`CommandInteractionPlan`) est aujourd'hui joue
 * par le terminal, qui affiche les invites et rend les reponses. Un
 * appelant programmatique — `device.executeCommand('enable', {
 * passwordInput })`, un script, un test — n'a pas de terminal, et il
 * n'avait donc AUCUN moyen d'atteindre la porte : `executeCommand`
 * allait droit au gestionnaire du trie, c'est-a-dire de l'autre cote du
 * mot de passe. Une machine avec `enable secret` accordait le niveau 15
 * a qui appelait cette methode.
 *
 * Ce module est la seule facon de jouer un plan sans terminal, pour que
 * les deux chemins ne puissent pas divergre sur ce que le plan decide.
 *
 * La reponse fournie est retapee tant que le plan la refuse et qu'il lui
 * reste des essais : c'est exactement ce que vit un operateur qui retape
 * le meme mot de passe — IOS redemande `Password:` trois fois, puis
 * abandonne sur `% Bad secrets`, et c'est le plan lui-meme qui produit
 * les deux messages.
 */

import type {
  CommandInteractionPlan, InteractionRuntime,
} from './CommandInteraction';

export interface HeadlessAnswers {
  /** Reponse a toute etape `password` du plan. */
  passwordInput?: string;
  /** Reponse a toute etape `text` ou `collect`. */
  textInput?: string;
  /** Reponse a toute etape `confirmation` (defaut : celle du plan). */
  confirmInput?: string;
}

export function hasHeadlessAnswers(answers?: HeadlessAnswers): boolean {
  if (!answers) return false;
  return answers.passwordInput !== undefined
    || answers.textInput !== undefined
    || answers.confirmInput !== undefined;
}

export async function runInteractionPlanHeadless(
  plan: CommandInteractionPlan,
  answers: HeadlessAnswers,
  exec: (command: string) => Promise<string>,
): Promise<string> {
  const sortie: string[] = [];
  const values = new Map<string, string>();
  const rt: InteractionRuntime = {
    exec: async (command) => {
      const out = await exec(command);
      if (out) sortie.push(out);
      return out;
    },
    output: (text) => { sortie.push(text); },
    clearScreen: () => { /* aucun ecran a effacer hors terminal */ },
    values,
    metadata: new Map<string, unknown>(),
  };

  for (const step of plan.steps) {
    if (step.kind === 'output') { sortie.push(...step.lines); continue; }
    if (step.kind === 'run') { await step.run(rt); continue; }
    if (step.kind === 'collect') {
      values.set(step.storeAs, answers.textInput ?? '');
      continue;
    }
    const reponse = step.kind === 'password'
      ? (answers.passwordInput ?? '')
      : step.kind === 'confirmation'
        ? (answers.confirmInput ?? step.defaultAnswer ?? 'yes')
        : (answers.textInput ?? step.defaultValue ?? '');
    if (step.storeAs) values.set(step.storeAs, reponse);
    if (!step.validate) continue;
    let verdict = step.validate(reponse, values);
    let essais = 0;
    while (!verdict.valid) {
      if (verdict.errorMessage) sortie.push(verdict.errorMessage);
      const budget = verdict.maxRetries;
      if (budget === undefined || essais >= budget) return sortie.join('\n');
      essais += 1;
      verdict = step.validate(reponse, values);
    }
  }
  return sortie.join('\n');
}
