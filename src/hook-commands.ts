import { validateConfig } from "./config.ts";
import type { HookStep } from "./types.ts";
import { shellQuote } from "./util.ts";

function quoteArgument(arg: string): string {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(arg)) {
    const escaped = arg.replace(/['\\\u0000-\u001f\u007f-\u009f]/g, (char) =>
      char === "'" || char === "\\" ? `\\${char}` : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return `$'${escaped}'`;
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg);
}

export function formatHookCommand(step: HookStep): string {
  if (step.shell) return step.command;
  return [step.command, ...(step.args ?? [])].map(quoteArgument).join(" ");
}

export function validatePostCreateSteps(steps: HookStep[]): void {
  const config = { version: 1, hooks: { postCreate: steps } };
  validateConfig(config, "<postCreate>", "repo");
  if (Buffer.byteLength(JSON.stringify(config, null, 2), "utf8") > 2 * 1024 * 1024) {
    throw new Error("postCreate exceeds the 2 MiB safety limit");
  }
}

// Parse shell-style quotes (including literal ANSI-C escapes), never evaluate
// shell operators or expansions. The /wt argument parser has different rules.
function splitHookCommand(line: string): string[] {
  const args: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | "ansi" | undefined;
  const shellSyntax = () => new Error("Shell syntax requires an explicit sh -c '...' command; use separate steps for multiple commands");
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "ansi") {
      if (char === "'") quote = undefined;
      else if (char === "\\") {
        const escape = /^\\(u[0-9a-f]{4}|x[0-9a-f]{2}|[\\'"abefnrtv])/i.exec(line.slice(i));
        if (!escape) throw new Error("Invalid escape in ANSI-C quoted argument");
        const value = escape[1];
        const escapes: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
        token += value.length > 1 ? String.fromCharCode(Number.parseInt(value.slice(1), 16)) : escapes[value] ?? value;
        i += escape[0].length - 1;
      } else token += char;
    } else if (char === "$" && line[i + 1] === "'" && !quote) {
      quote = "ansi";
      started = true;
      i++;
    } else if (char === "\\" && quote !== "'") {
      const next = line[i + 1];
      if (next === undefined) throw new Error("Trailing backslash in command line");
      // Inside double quotes, backslash is special only before \\, ", $, and `.
      if (quote === '"' && !['\\', '"', '$', '`'].includes(next)) token += char;
      else { token += next; i++; }
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else {
        if (quote === '"' && (char === "$" || char === "`")) throw shellSyntax();
        token += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") {
      if (started) args.push(token);
      token = "";
      started = false;
    } else {
      if (/[|&;<>(){}*?\[\]$`]/.test(char) || (!started && (char === "~" || char === "#"))) throw shellSyntax();
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unterminated quote in command line");
  if (started) args.push(token);
  return args;
}

export function parseHookCommand(line: string, previous?: HookStep): HookStep {
  if (Buffer.byteLength(line, "utf8") > 2 * 1024 * 1024) throw new Error("Command line exceeds the 2 MiB safety limit");
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(line)) {
    throw new Error("Enter one command line without control characters");
  }
  let step: HookStep;
  if (previous?.shell) {
    // Existing explicitly configured shell steps keep their execution mode.
    step = { ...previous, command: line };
  } else {
    const [command, ...args] = splitHookCommand(line);
    if (!command?.trim()) throw new Error("Enter a command");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) {
      throw new Error("Use env NAME=value command for environment assignments");
    }
    step = { ...previous, command, args };
  }
  validatePostCreateSteps([step]);
  return step;
}
