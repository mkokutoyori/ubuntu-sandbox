import { PSNumber, type NumericKind } from './PSNumber';
import { conversionFailure, type PSConversionError } from './PSConvert';

export class EnumType {
  private readonly byName = new Map<string, PSEnumValue>();
  private readonly ordered: PSEnumValue[] = [];

  constructor(
    readonly name: string,
    readonly underlying: NumericKind,
    readonly flags: boolean,
    readonly fullName: string = name,
  ) {}

  add(memberName: string, value: number): PSEnumValue {
    const member = new PSEnumValue(this, memberName, value);
    this.byName.set(memberName.toLowerCase(), member);
    this.ordered.push(member);
    return member;
  }

  members(): readonly PSEnumValue[] {
    return this.ordered;
  }

  names(): string[] {
    return this.ordered.map(member => member.memberName as string);
  }

  member(name: string): PSEnumValue | undefined {
    return this.byName.get(name.toLowerCase());
  }

  fromNumber(value: number): PSEnumValue {
    const exact = this.ordered.find(member => member.numeric === value);
    return exact ?? new PSEnumValue(this, null, value);
  }

  parse(text: string): PSEnumValue {
    const parts = text.split(',').map(part => part.trim());
    if (parts.length > 1 && !this.flags) throw this.unmatched(text);
    let combined = 0;
    for (const part of parts) {
      const known = this.member(part);
      if (known !== undefined) {
        combined |= known.numeric;
      } else if (/^-?\d+$/.test(part)) {
        combined |= Number(part);
      } else {
        throw this.unmatched(part);
      }
    }
    return this.fromNumber(parts.length === 1 && /^-?\d+$/.test(parts[0]) ? Number(parts[0]) : combined);
  }

  private unmatched(text: string): PSConversionError {
    return conversionFailure(text, this.fullName, `Unable to match the identifier name ${text} to a valid enumerator name. Specify one of the following enumerator names and try again:\n${this.names().join(', ')}`);
  }
}

export class PSEnumValue extends PSNumber {
  constructor(
    readonly definition: EnumType,
    readonly memberName: string | null,
    readonly numeric: number,
  ) {
    super(definition.underlying === 'int32' ? 'int32' : definition.underlying, numeric);
  }

  toString(): string {
    if (this.memberName !== null) return this.memberName;
    if (!this.definition.flags || this.numeric === 0) return String(this.numeric);
    let remaining = this.numeric;
    const names: string[] = [];
    for (const member of this.definition.members()) {
      if (member.numeric !== 0 && (remaining & member.numeric) === member.numeric) {
        names.push(member.memberName as string);
        remaining &= ~member.numeric;
      }
    }
    return remaining === 0 && names.length > 0 ? names.join(', ') : String(this.numeric);
  }
}

export function enumMember(value: PSEnumValue, member: string): unknown {
  switch (member) {
    case 'value__': return value.numeric;
    case 'hasflag': return (flag: unknown) => (value.numeric & Number(flag)) === Number(flag);
    case 'tostring': return () => value.toString();
    case 'equals': return (other: unknown) => other instanceof PSEnumValue && other.definition === value.definition && other.numeric === value.numeric;
    case 'gethashcode': return () => value.numeric;
    default: return undefined;
  }
}

const BUILTIN_ENUMS: ReadonlyArray<{ name: string; fullName: string; flags: boolean; underlying?: NumericKind; members: ReadonlyArray<readonly [string, number]> }> = [
  {
    name: 'StringComparison', fullName: 'System.StringComparison', flags: false,
    members: [['CurrentCulture', 0], ['CurrentCultureIgnoreCase', 1], ['InvariantCulture', 2], ['InvariantCultureIgnoreCase', 3], ['Ordinal', 4], ['OrdinalIgnoreCase', 5]],
  },
  {
    name: 'StringSplitOptions', fullName: 'System.StringSplitOptions', flags: true,
    members: [['None', 0], ['RemoveEmptyEntries', 1], ['TrimEntries', 2]],
  },
  {
    name: 'DayOfWeek', fullName: 'System.DayOfWeek', flags: false,
    members: [['Sunday', 0], ['Monday', 1], ['Tuesday', 2], ['Wednesday', 3], ['Thursday', 4], ['Friday', 5], ['Saturday', 6]],
  },
  {
    name: 'SplitOptions', fullName: 'System.Management.Automation.SplitOptions', flags: true,
    members: [['SimpleMatch', 1], ['RegexMatch', 2], ['CultureInvariant', 4], ['IgnorePatternWhitespace', 8], ['Multiline', 16], ['Singleline', 32], ['IgnoreCase', 64], ['ExplicitCapture', 128]],
  },
  {
    name: 'AceFlags', fullName: 'System.Security.AccessControl.AceFlags', flags: true, underlying: 'byte',
    members: [['None', 0], ['ObjectInherit', 1], ['ContainerInherit', 2], ['NoPropagateInherit', 4], ['InheritOnly', 8], ['Inherited', 16], ['SuccessfulAccess', 64], ['FailedAccess', 128]],
  },
  {
    name: 'CommandTypes', fullName: 'System.Management.Automation.CommandTypes', flags: true,
    members: [['Alias', 1], ['Function', 2], ['Filter', 4], ['Cmdlet', 8], ['ExternalScript', 16], ['Application', 32], ['Script', 64], ['Configuration', 256], ['All', 511]],
  },
];

export function builtinEnums(): Map<string, EnumType> {
  const registry = new Map<string, EnumType>();
  for (const definition of BUILTIN_ENUMS) {
    const type = new EnumType(definition.name, definition.underlying ?? 'int32', definition.flags, definition.fullName);
    for (const [name, value] of definition.members) type.add(name, value);
    registry.set(definition.name.toLowerCase(), type);
    registry.set(definition.fullName.toLowerCase(), type);
  }
  return registry;
}
