import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER, getKeybindings, KeybindingsManager as TuiKeybindingsManager,
  setKeybindings, TUI_KEYBINDINGS, visibleWidth, type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editPostCreateSteps } from "../src/hook-editor.ts";
import type { HookStep } from "../src/types.ts";

const originalKeybindings = getKeybindings();
afterEach(() => setKeybindings(originalKeybindings));
const up = "\x1b[A";
const down = "\x1b[B";
const moveUp = "\x1b[1;3A";
const moveDown = "\x1b[1;3B";
const enter = "\r";
const escape = "\x1b";
const finish = "\x13";

function openEditor(steps: HookStep[] = [], zh = false) {
  const tui = { terminal: { rows: 30, columns: 100 }, requestRender: vi.fn() } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  let dialog!: Component & Focusable;
  const done = vi.fn();
  const custom = (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => new Promise((resolve) => {
    dialog = factory(tui, theme, getKeybindings() as KeybindingsManager, (value) => {
      done(value);
      resolve(value);
    }) as typeof dialog;
  });
  const ctx = { ui: { custom } } as unknown as ExtensionCommandContext;
  const result = editPostCreateSteps(ctx, steps, zh);
  const input = (...keys: string[]) => { for (const key of keys) dialog.handleInput!(key); };
  const paste = (text: string) => input(`\x1b[200~${text}\x1b[201~`);
  const replace = (text: string) => { input("\x01", "\x0b"); paste(text); };
  const screen = (width = 100) => dialog.render(width).join("\n");
  return { dialog, input, paste, replace, screen, result, done, tui };
}

describe("postCreate command list editor", () => {
  it("edits a command line and preserves settings without modifying the original array", async () => {
    const initial: HookStep[] = [{ command: "npm", args: ["install"], timeoutMs: 1000, env: { CI: "1" }, shell: false }];
    const before = structuredClone(initial);
    const prompt = openEditor(initial);
    expect(prompt.screen()).toContain("1. npm install");
    expect(prompt.screen()).toContain("timeout=1000ms · env: CI");
    prompt.input(enter);
    prompt.replace('pnpm install --filter "my package"');
    prompt.input(enter);
    expect(prompt.done).not.toHaveBeenCalled();
    prompt.input(finish);
    await expect(prompt.result).resolves.toEqual([{ ...initial[0], command: "pnpm", args: ["install", "--filter", "my package"] }]);
    expect(initial).toEqual(before);
  });

  it("adds commands using the list actions, then returns to review", async () => {
    const prompt = openEditor();
    prompt.input(enter); // Add command row
    prompt.paste("pnpm install");
    prompt.input(enter, down, down, enter); // Done editing row
    await expect(prompt.result).resolves.toEqual([{ command: "pnpm", args: ["install"] }]);
  });

  it("moves the selected command both ways, retaining selection and metadata at boundaries", async () => {
    const initial = [1, 2, 3].map((number) => ({ command: "echo", args: [`step-${number}`], timeoutMs: number * 1000 }));
    const prompt = openEditor(initial);
    prompt.input(moveUp, moveDown);
    expect(prompt.screen()).toContain("→ 2. echo step-1");
    prompt.input(moveDown, moveDown);
    expect(prompt.screen()).toContain("→ 3. echo step-1");
    prompt.input(moveUp, finish);
    await expect(prompt.result).resolves.toEqual([initial[1], initial[0], initial[2]]);
    expect(initial[0].args).toEqual(["step-1"]);
  });

  it("adds and deletes selected commands, including duplicate command lines", async () => {
    const initial = [{ command: "echo", args: ["same"], timeoutMs: 1000 }, { command: "echo", args: ["same"], timeoutMs: 2000 }];
    const prompt = openEditor(initial);
    prompt.input(down, "d", "a");
    prompt.paste('echo "added command"');
    prompt.input(enter, moveUp, finish);
    await expect(prompt.result).resolves.toEqual([{ command: "echo", args: ["added command"] }, initial[0]]);
    expect(initial).toHaveLength(2);
  });

  it("allows deleting every step and ignores row operations on action buttons", async () => {
    const prompt = openEditor([{ command: "npm", args: ["install"] }]);
    prompt.input("\x1b[3~", "d", moveUp, moveDown, finish);
    await expect(prompt.result).resolves.toEqual([]);
  });

  it("cancels just the current input before cancelling the whole draft", async () => {
    const initial = [{ command: "npm", args: ["install"] }];
    const prompt = openEditor(initial);
    prompt.input("a");
    prompt.paste("npm test");
    prompt.input(enter, "a");
    prompt.paste("npm run build");
    prompt.input(escape);
    expect(prompt.done).not.toHaveBeenCalled();
    expect(prompt.screen()).toContain("2. npm test");
    expect(prompt.screen()).not.toContain("npm run build");
    prompt.input(escape);
    await expect(prompt.result).resolves.toBeUndefined();
    expect(initial).toEqual([{ command: "npm", args: ["install"] }]);
  });

  it("discards a command edit without discarding earlier list changes", async () => {
    const prompt = openEditor([{ command: "npm", args: ["install"] }]);
    prompt.input("a");
    prompt.paste("npm test");
    prompt.input(enter, up, enter);
    prompt.replace("npm run wrong");
    prompt.input(escape, finish);
    await expect(prompt.result).resolves.toEqual([{ command: "npm", args: ["install"] }, { command: "npm", args: ["test"] }]);
  });

  it.each(["npm 'unterminated", "npm install && npm test", "npm install\nnpm test", "echo $'\\u0000'"])("retains invalid input for correction: %j", async (invalid) => {
    const prompt = openEditor();
    prompt.input("a");
    prompt.paste(invalid);
    prompt.input(enter);
    expect(prompt.screen()).toContain("Invalid command");
    for (const line of invalid.split("\n")) expect(prompt.screen()).toContain(line);
    expect(prompt.done).not.toHaveBeenCalled();
    // Cancel the invalid input, then ensure no partial command was inserted.
    prompt.input(escape, finish);
    await expect(prompt.result).resolves.toEqual([]);
  });

  it("keeps invalid input editable and treats list shortcut letters as text inside a command", async () => {
    const prompt = openEditor();
    prompt.input("a");
    prompt.paste("echo 'ad");
    prompt.input(enter);
    prompt.input("'", enter, finish);
    await expect(prompt.result).resolves.toEqual([{ command: "echo", args: ["ad"] }]);
  });

  it("preserves unchanged optional fields and safely renders control characters", async () => {
    const initial = [{ command: "echo", args: ["one\ntwo\x1b[31m"] }, { command: "npm", timeoutMs: 1000 }];
    const prompt = openEditor(initial);
    expect(prompt.screen()).not.toContain("\x1b[31m");
    prompt.input(enter, enter, down, enter, enter, finish);
    await expect(prompt.result).resolves.toEqual(initial);
  });

  it("keeps explicit shell steps in shell mode", async () => {
    const prompt = openEditor([{ command: "echo one && echo two", shell: true, timeoutMs: 1000 }]);
    expect(prompt.screen()).toContain("[shell]");
    prompt.input(enter);
    prompt.replace("echo three | sort");
    prompt.input(enter, finish);
    await expect(prompt.result).resolves.toEqual([{ command: "echo three | sort", shell: true, timeoutMs: 1000 }]);
  });

  it("scrolls large lists and fits narrow terminals with Chinese IME focus", () => {
    const prompt = openEditor(Array.from({ length: 20 }, (_, i) => ({ command: "echo", args: [`步骤 ${i + 1}`] })), true);
    for (let i = 0; i < 19; i++) prompt.input(down);
    expect(prompt.screen()).toContain("→ 20. echo");
    prompt.dialog.focused = true;
    prompt.input(enter);
    for (const width of [20, 40, 80]) {
      const lines = prompt.dialog.render(width);
      expect(lines.join("\n")).toContain("postCreate 命令列表");
      expect(lines.join("\n")).toContain(CURSOR_MARKER);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    prompt.dialog.focused = false;
    expect(prompt.screen()).not.toContain(CURSOR_MARKER);
    expect(prompt.tui.requestRender).toHaveBeenCalled();
    prompt.dialog.invalidate();
  });

  it("respects configured navigation, submit, and cancel keys", async () => {
    setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.down": "ctrl+n", "tui.input.submit": "ctrl+t", "tui.select.cancel": "ctrl+x",
    }));
    const prompt = openEditor([{ command: "npm", args: ["install"] }]);
    expect(prompt.screen()).toContain("ctrl+n select");
    prompt.input("\x0e", enter); // Add row
    expect(prompt.screen()).toContain("ctrl+t apply command");
    prompt.paste("npm test");
    prompt.input("\x14", "\x18");
    await expect(prompt.result).resolves.toBeUndefined();
  });
});
