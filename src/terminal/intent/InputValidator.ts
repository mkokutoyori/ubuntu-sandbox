/**
 * InputValidator — composable predicate that {@link InputPrompt} consults
 * before accepting a user response. Returning {valid: true} commits the
 * value; {valid: false, errorMessage} forces the flow to redisplay the
 * prompt (up to maxAttempts).
 *
 * Functions are first-class so flows can build ad-hoc validators inline.
 * The static helpers cover the common cases (regex, length, choice) so
 * call-sites stay tiny and intentional.
 */

export interface ValidationOutcome {
  readonly valid: boolean;
  readonly errorMessage?: string;
}

export type InputValidator = (value: string) => ValidationOutcome | Promise<ValidationOutcome>;

export const Validators = {
  nonEmpty(errorMessage = 'Value cannot be empty'): InputValidator {
    return v => v.length === 0 ? { valid: false, errorMessage } : { valid: true };
  },

  pattern(re: RegExp, errorMessage = 'Invalid format'): InputValidator {
    return v => re.test(v) ? { valid: true } : { valid: false, errorMessage };
  },

  minLength(n: number, errorMessage?: string): InputValidator {
    return v => v.length >= n ? { valid: true } : {
      valid: false,
      errorMessage: errorMessage ?? `Must be at least ${n} characters`,
    };
  },

  maxLength(n: number, errorMessage?: string): InputValidator {
    return v => v.length <= n ? { valid: true } : {
      valid: false,
      errorMessage: errorMessage ?? `Must be at most ${n} characters`,
    };
  },

  oneOf(values: ReadonlyArray<string>, errorMessage?: string): InputValidator {
    return v => values.includes(v) ? { valid: true } : {
      valid: false,
      errorMessage: errorMessage ?? `Must be one of: ${values.join(', ')}`,
    };
  },

  matches(other: () => string, errorMessage = 'Values do not match'): InputValidator {
    return v => v === other() ? { valid: true } : { valid: false, errorMessage };
  },

  all(...vs: InputValidator[]): InputValidator {
    return async v => {
      for (const validator of vs) {
        const out = await validator(v);
        if (!out.valid) return out;
      }
      return { valid: true };
    };
  },
};
