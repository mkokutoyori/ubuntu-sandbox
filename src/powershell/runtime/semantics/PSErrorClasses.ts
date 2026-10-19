import type { PSValue } from '../PSEnvironment';
import { newErrorRecord } from './PSStreams';

interface ErrorClass {
  readonly pattern: RegExp;
  readonly exceptionType: string;
  readonly category: string;
  readonly errorId: string;
}

const CLASSES: readonly ErrorClass[] = [
  {
    pattern: /^Cannot find path '.*' because it does not exist\.$/,
    exceptionType: 'System.Management.Automation.ItemNotFoundException',
    category: 'ObjectNotFound',
    errorId: 'PathNotFound',
  },
];

export function classifiedError(message: string, cmdletDisplayName: string): Record<string, PSValue> {
  const known = CLASSES.find(entry => entry.pattern.test(message));
  if (known === undefined) {
    return newErrorRecord({
      message,
      exceptionType: 'Microsoft.PowerShell.Commands.WriteErrorException',
      fullyQualifiedErrorId: 'Microsoft.PowerShell.Commands.WriteErrorException',
    });
  }
  const command = cmdletDisplayName.replace(/-/g, '');
  const target = /^Cannot find path '(.*)' because/.exec(message)?.[1] ?? null;
  return newErrorRecord({
    message,
    exceptionType: known.exceptionType,
    category: known.category,
    targetObject: target,
    fullyQualifiedErrorId: `${known.errorId},Microsoft.PowerShell.Commands.${command}Command`,
  });
}
