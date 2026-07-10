import { Capability } from "../session/types";

export type ArgType = "string" | "int" | "float" | "boolean" | "path";

export interface ArgumentSpec {
  readonly name: string;
  readonly type: ArgType;
  readonly required: boolean;
  readonly variadic?: boolean; // ex: cat f1 f2 f3…
  readonly description: string;
}

export interface OptionSpec {
  readonly long: string; // --force
  readonly short?: string; // -f
  readonly takesValue: boolean; // --time=30
  readonly type?: ArgType;
  readonly defaultValue?: unknown;
  readonly description: string;
  /** Une option peut exiger une capacité supplémentaire (ex: --system). */
  readonly requiredCapability?: Capability;
}
