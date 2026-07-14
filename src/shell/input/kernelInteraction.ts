import type { InteractionChannel, PromptSpec } from '@/command-kernel/io/interaction';
import type { InputBroker } from './InputBroker';
import type { InputRequest } from './types';

/**
 * Adapte le système d'entrée piloté par l'UI (InputBroker/SessionInputHost,
 * Promise résolue à la saisie, annulation Ctrl+C) au contrat
 * `InteractionChannel` du socle command-kernel : c'est le point de rencontre
 * unique entre la session de terminal et une commande migrée qui dialogue
 * (`prompt secret/text/confirm`). Retourne `undefined` quand aucun humain ne
 * peut répondre — le pont ne fournit alors pas de canal, et la commande
 * échoue proprement via `requireInteraction()`.
 */
export function createKernelInteraction(broker: InputBroker): InteractionChannel | undefined {
  if (!broker.capabilities().interactive) return undefined;
  return {
    prompt: async (spec: PromptSpec) => {
      const request: InputRequest =
        spec.kind === 'secret'
          ? { kind: 'password', prompt: spec.prompt, mask: true, echo: false }
          : { kind: 'text', prompt: spec.prompt, default: spec.defaultValue };
      const result = await broker.read(request);
      if (result.status !== 'ok') return null;
      return result.value ?? '';
    },
  };
}
