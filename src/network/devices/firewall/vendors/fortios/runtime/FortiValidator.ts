import {
  argumentAccepts, argumentPlaceholder, type ArgumentSpec,
} from '../../../../../../cli/ArgumentTypes';
import { FortiMessages } from '../FortiMessages';
import { attributeArity, type FortiAttributeSpec } from '../schema/types';

export interface ValidationResult {
  readonly ok: boolean;
  readonly values: string[];
  readonly error: string;
}

export interface ReferenceResolver {
  (target: string, name: string): boolean;
}

const OK = (values: string[]): ValidationResult => ({ ok: true, values, error: '' });
const KO = (error: string): ValidationResult => ({ ok: false, values: [], error });

export class FortiValidator {
  constructor(private readonly resolve: ReferenceResolver) {}

  validate(spec: FortiAttributeSpec, raw: readonly string[]): ValidationResult {
    if (spec.readOnly) return KO(FortiMessages.readOnly(spec.name));
    if (spec.unimplemented) return KO(FortiMessages.unimplemented(spec.name, spec.unimplemented));
    if (raw.length === 0) return KO(FortiMessages.incomplete(`une valeur pour \`${spec.name}\``));

    const arity = attributeArity(spec);
    if (spec.multiValue) return this.validateList(spec, raw);
    if (raw.length !== arity) {
      return KO(FortiMessages.incomplete(
        `${arity} valeur(s) pour \`${spec.name}\`, ${raw.length} donnee(s)`,
      ));
    }

    for (let index = 0; index < raw.length; index++) {
      const error = this.checkOne(spec, spec.parts[index], raw[index]);
      if (error) return KO(error);
    }
    return OK([...raw]);
  }

  private validateList(
    spec: FortiAttributeSpec, raw: readonly string[],
  ): ValidationResult {
    for (const value of raw) {
      const error = this.checkOne(spec, spec.parts[0], value);
      if (error) return KO(error);
    }
    return OK([...raw]);
  }

  private checkOne(
    attribute: FortiAttributeSpec, part: ArgumentSpec, value: string,
  ): string | null {
    if (attribute.referenceTo) {
      if (attribute.referenceTo.some(target => this.resolve(target, value))) return null;
      return FortiMessages.unknownReference(attribute.name, value, attribute.referenceTo[0]);
    }
    if (argumentAccepts(part, value)) return null;
    return FortiMessages.valueError(value, expected(part));
  }
}

function expected(part: ArgumentSpec): string {
  if (part.values && part.values.length > 0) {
    return `valeurs admises : ${part.values.map(v => v.keyword).join(', ')}.`;
  }
  if (part.range) return `attendu ${argumentPlaceholder(part)} (minimum ${part.range[0]}, `
    + `maximum ${part.range[1]}).`;
  return `attendu ${argumentPlaceholder(part)}.`;
}
