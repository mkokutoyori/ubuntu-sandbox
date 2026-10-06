import type { LinuxServer } from '@/network/devices/LinuxServer';
import type { CommandInteractionPlan, InteractionRuntime } from '@/shell/interaction/CommandInteraction';

export interface Played { readonly prompts: string[]; readonly output: string[]; readonly executed: string[]; readonly aborted: string | null }

export async function play(srv: LinuxServer, line: string, answers: readonly string[]): Promise<Played | null> {
  const plan = (srv as unknown as { interactionPlanFor(l: string, c: object): CommandInteractionPlan | null })
    .interactionPlanFor(line, { currentUser: 'root', currentUid: 0 });
  if (plan === null) return null;
  const played: Played = { prompts: [], output: [], executed: [], aborted: null };
  const values = new Map<string, string>();
  const rt: InteractionRuntime = {
    exec: async (command) => { (played.executed as string[]).push(command); return srv.executeCommand(command); },
    output: (text) => { played.output.push(text); },
    clearScreen: () => {},
    values, metadata: new Map(),
  };
  const queue = [...answers];
  for (const step of plan.steps) {
    if (step.kind === 'output') played.output.push(...step.lines);
    else if (step.kind === 'text' || step.kind === 'password') {
      played.prompts.push(step.prompt);
      let verdict = { valid: false } as { valid: boolean; errorMessage?: string; maxRetries?: number };
      for (let attempt = 0; !verdict.valid; attempt++) {
        const answer = queue.shift() ?? '';
        verdict = step.validate ? step.validate(answer, values) : { valid: true };
        if (verdict.valid) { if (step.storeAs) values.set(step.storeAs, answer); break; }
        played.output.push(verdict.errorMessage ?? '');
        if (verdict.maxRetries !== undefined && attempt >= verdict.maxRetries) return { ...played, aborted: verdict.errorMessage ?? '' };
      }
    } else if (step.kind === 'run') await step.run(rt);
  }
  return played;
}

