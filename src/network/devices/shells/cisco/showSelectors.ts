import { INTERFACE_NAME } from '@/cli/ArgumentTypes';
import { isValidIPv4 } from '../../../core/ip';
import { CliInvalidInput } from '../cli/CliDiagnostic';

export interface SelectorWords {
  readonly keywords?: readonly string[];
  readonly interfaces?: boolean;
  readonly addresses?: boolean;
  readonly integer?: readonly [number, number];
  readonly max: number;
}

function fits(word: string, allowed: SelectorWords): boolean {
  if (allowed.keywords?.includes(word.toLowerCase())) return true;
  if (allowed.interfaces && INTERFACE_NAME.test(word)) return true;
  if (allowed.addresses && isValidIPv4(word)) return true;
  if (allowed.integer && /^\d+$/.test(word)) {
    const value = Number(word);
    return value >= allowed.integer[0] && value <= allowed.integer[1];
  }
  return false;
}

export function refuseUnknownSelector(args: readonly string[], allowed: SelectorWords): void {
  const bad = args.findIndex((word, at) => at >= allowed.max || !fits(word, allowed));
  if (bad >= 0) throw new CliInvalidInput({ token: args[bad] });
}
