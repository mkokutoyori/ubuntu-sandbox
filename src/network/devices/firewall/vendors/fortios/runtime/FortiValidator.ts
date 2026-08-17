import { tryIpToUint32 } from '../../../../../core/ip';
import { FortiMessages } from '../FortiMessages';
import { typeArity, type FortiAttributeSpec } from '../schema/types';

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

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const PORT_RANGE = /^\d{1,5}(-\d{1,5})?(:\d{1,5}(-\d{1,5})?)?$/;

export class FortiValidator {
  constructor(private readonly resolve: ReferenceResolver) {}

  validate(spec: FortiAttributeSpec, raw: readonly string[]): ValidationResult {
    if (spec.readOnly) return KO(FortiMessages.readOnly(spec.name));
    if (spec.unimplemented) return KO(FortiMessages.unimplemented(spec.name, spec.unimplemented));
    if (raw.length === 0) return KO(FortiMessages.incomplete(`une valeur pour \`${spec.name}\``));

    const arity = typeArity(spec);
    if (!spec.multiValue && raw.length !== arity) {
      return KO(FortiMessages.incomplete(
        `${arity} valeur(s) pour \`${spec.name}\`, ${raw.length} donnee(s)`,
      ));
    }
    if (spec.multiValue && arity > 1 && raw.length % arity !== 0) {
      return KO(FortiMessages.incomplete(`un multiple de ${arity} valeurs`));
    }

    for (const value of raw) {
      const error = this.checkOne(spec, value);
      if (error) return KO(error);
    }
    return OK([...raw]);
  }

  private checkOne(spec: FortiAttributeSpec, value: string): string | null {
    switch (spec.type) {
      case 'integer':
        return this.checkInteger(spec, value);
      case 'enum':
      case 'boolean-enable':
        return this.checkEnum(spec, value);
      case 'reference':
        return this.checkReference(spec, value);
      case 'ipv4-address':
      case 'ipv4-netmask':
      case 'ipv4-address-mask':
      case 'ipv4-range':
        return tryIpToUint32(value) === null
          ? FortiMessages.valueError(value, `« ${value} » n'est pas une adresse IPv4.`)
          : null;
      case 'mac-address':
        return MAC.test(value)
          ? null
          : FortiMessages.valueError(value, `« ${value} » n'est pas une adresse MAC.`);
      case 'time':
        return TIME.test(value)
          ? null
          : FortiMessages.valueError(value, 'une heure s\'ecrit HH:MM.');
      case 'port-range':
        return PORT_RANGE.test(value)
          ? null
          : FortiMessages.valueError(value, 'une plage de ports s\'ecrit `d[-d][:s[-s]]`.');
      case 'string':
      case 'user-name':
      case 'password':
      case 'uuid':
        return this.checkLength(spec, value);
      default:
        return null;
    }
  }

  private checkInteger(spec: FortiAttributeSpec, value: string): string | null {
    if (!/^-?\d+$/.test(value)) {
      return FortiMessages.valueError(value, `« ${value} » n'est pas un entier.`);
    }
    const parsed = Number.parseInt(value, 10);
    if (spec.min !== undefined && parsed < spec.min) {
      return FortiMessages.valueError(value, `minimum ${spec.min}.`);
    }
    if (spec.max !== undefined && parsed > spec.max) {
      return FortiMessages.valueError(value, `maximum ${spec.max}.`);
    }
    return null;
  }

  private checkEnum(spec: FortiAttributeSpec, value: string): string | null {
    const allowed = (spec.enumValues ?? []).map(e => e.value);
    if (allowed.length === 0 || allowed.includes(value)) return null;
    return FortiMessages.valueError(value, `valeurs admises : ${allowed.join(', ')}.`);
  }

  private checkReference(spec: FortiAttributeSpec, value: string): string | null {
    const targets = spec.referenceTo ?? [];
    if (targets.length === 0) return null;
    if (targets.some(target => this.resolve(target, value))) return null;
    return FortiMessages.unknownReference(spec.name, value, targets[0]);
  }

  private checkLength(spec: FortiAttributeSpec, value: string): string | null {
    if (spec.maxLength === undefined || value.length <= spec.maxLength) return null;
    return FortiMessages.valueError(value, `${spec.maxLength} caracteres au plus.`);
  }
}
