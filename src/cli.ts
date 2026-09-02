import { parseCommandLine } from "./util.ts";

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(input: string, valueFlags: ReadonlySet<string> = new Set()): ParsedArgs {
  const tokens = parseCommandLine(input);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let options = true;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (options && token === "--") {
      options = false;
      continue;
    }
    if (options && token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      if (!name) throw new Error("Invalid empty option");
      if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
      if (valueFlags.has(name)) {
        const value = equals === -1 ? tokens[++index] : token.slice(equals + 1);
        if (value === undefined || value.startsWith("--")) throw new Error(`Option --${name} requires a value`);
        flags.set(name, value);
      } else {
        if (equals !== -1) throw new Error(`Option --${name} does not accept a value`);
        flags.set(name, true);
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

export function assertAllowedFlags(parsed: ParsedArgs, allowed: ReadonlySet<string>): void {
  for (const name of parsed.flags.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`);
  }
}

export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}
