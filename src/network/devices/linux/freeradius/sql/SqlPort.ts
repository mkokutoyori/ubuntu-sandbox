export interface SqlResult {
  readonly rows: readonly (readonly (string | null)[])[];
  readonly affected: number;
  readonly isQuery: boolean;
  readonly columns?: readonly string[];
}

export interface SqlSession {
  execute(statement: string): SqlResult | { readonly error: string };
  close(): void;
}

export type SqlConnector = (target: { readonly connectString: string; readonly login: string; readonly password: string }) => SqlSession | { readonly error: string };
