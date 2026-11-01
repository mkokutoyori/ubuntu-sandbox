export interface NslookupReply {
  readonly lines: string[];
  readonly exit: boolean;
}

export interface NslookupInterpreter {
  bannerLines(): Promise<string[]>;
  interpret(line: string): Promise<NslookupReply>;
}
