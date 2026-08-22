import {
  argumentAccepts, argumentPlaceholder, type ArgumentSpec,
} from '../../../../../../cli/ArgumentTypes';
import { FortiMessages } from '../FortiMessages';
import {
  attributeArity, EMPTY_ENVIRONMENT,
  type FortiAttributeSpec, type FortiSchemaEnvironment,
} from '../schema/types';

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
  constructor(
    private readonly resolve: ReferenceResolver,
    private readonly environment: FortiSchemaEnvironment = EMPTY_ENVIRONMENT,
  ) {}

  validate(spec: FortiAttributeSpec, raw: readonly string[]): ValidationResult {
    if (spec.readOnly) return KO(FortiMessages.readOnly(spec.name));
    if (spec.unimplemented) return KO(FortiMessages.unimplemented(spec.name, spec.unimplemented));
    if (raw.length === 0) return KO(FortiMessages.incomplete(`a value for \`${spec.name}\``));

    const refused = this.refusedValue(spec, raw);
    if (refused) return KO(refused);

    const arity = attributeArity(spec);
    if (spec.multiValue) return this.validateList(spec, raw);
    if (raw.length !== arity) {
      return KO(FortiMessages.incomplete(
        `${arity} value(s) for \`${spec.name}\`, ${raw.length} given`,
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

  private refusedValue(
    spec: FortiAttributeSpec, raw: readonly string[],
  ): string | null {
    const refusals = spec.unimplementedValues;
    if (!refusals) return null;

    for (const value of raw) {
      const reason = refusals[value];
      if (reason) return FortiMessages.unimplementedValue(spec.name, value, reason);
    }
    return null;
  }

  private checkOne(
    attribute: FortiAttributeSpec, part: ArgumentSpec, value: string,
  ): string | null {
    if (attribute.referenceTo) {
      if (attribute.referenceTo.some(target => this.resolve(target, value))) return null;
      return FortiMessages.unknownReference(attribute.name, value, attribute.referenceTo[0]);
    }
    if (attribute.valueRefusal) {
      const refusal = attribute.valueRefusal(value, this.environment);
      if (refusal !== null) return FortiMessages.valueError(value, refusal);
    }
    if (attribute.acceptsValue) {
      if (attribute.acceptsValue(value)) return null;
      return FortiMessages.valueError(
        value, attribute.expectedValue ?? expected(part));
    }
    if (argumentAccepts(part, value)) return null;
    return FortiMessages.valueError(value, expected(part));
  }
}

function expected(part: ArgumentSpec): string {
  if (part.values && part.values.length > 0) {
    return `allowed values: ${part.values.map(v => v.keyword).join(', ')}.`;
  }
  if (part.range) return `expected ${argumentPlaceholder(part)} (minimum ${part.range[0]}, `
    + `maximum ${part.range[1]}).`;
  return `expected ${argumentPlaceholder(part)}.`;
}
