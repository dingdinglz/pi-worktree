import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskAutocompleteProvider, promptForTask } from "../src/ui.ts";
import { shellQuote } from "../src/util.ts";
import { tempDir } from "./helpers.ts";

const commands = [
  { name: "review", description: "Review changes", source: "prompt" },
  { name: "skill:testing", description: "Write tests", source: "skill" },
  { name: "custom:2", description: "An extension command", source: "extension" },
] as const;
const pi = { getCommands: vi.fn(() => commands) } as unknown as ExtensionAPI;
const originalKeybindings = getKeybindings();
let root: string;
let cwd: string;
let fd: string;
let fdArgs: string;
const dialogs: Array<Component & Focusable & { dispose(): void }> = [];

async function writeFd(path: string, entries = ["nested/", "nested/widget.ts", "task notes.md"]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > ${shellQuote(fdArgs)}`,
    `printf '%s\\n' ${entries.map(shellQuote).join(" ")}`,
    "",
  ].join("\n"), { mode: 0o755 });
}

beforeEach(async () => {
  root = await tempDir();
  cwd = join(root, "project", "subdir");
  fd = join(root, "bin", "fd");
  fdArgs = join(root, "fd-args");
  await mkdir(join(cwd, "nested"), { recursive: true });
  await writeFile(join(cwd, "nested", "widget.ts"), "export {};\n");
  await writeFile(join(cwd, "task notes.md"), "Task notes\n");
  await writeFd(fd);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PATH", join(root, "bin"));
});

afterEach(async () => {
  for (const dialog of dialogs.splice(0)) dialog.dispose();
  setKeybindings(originalKeybindings);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function suggestions(provider: ReturnType<typeof createTaskAutocompleteProvider>, text: string, force = false) {
  return provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal, force });
}

function openPrompt(locale: "en" | "zh-CN" = "en") {
  const tui = { terminal: { rows: 30, columns: 100 }, requestRender: vi.fn() } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  let dialog!: Component & Focusable & { dispose(): void };
  const done = vi.fn();
  const setProvider = vi.spyOn(Editor.prototype, "setAutocompleteProvider");
  const custom = vi.fn((factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) =>
    new Promise((resolve) => {
      dialog = factory(tui, theme, getKeybindings() as KeybindingsManager, (value) => {
        done(value);
        resolve(value);
      }) as typeof dialog;
      dialogs.push(dialog);
    }),
  );
  const ctx = { cwd, ui: { custom } } as unknown as ExtensionCommandContext;
  const result = promptForTask(pi, ctx, locale);
  const editor = setProvider.mock.contexts.at(-1) as Editor;
  const provider = setProvider.mock.calls.at(-1)![0];
  const input = (data: string) => dialog.handleInput!(data);
  const type = (text: string) => { for (const char of text) input(char); };
  const waitForSuggestions = () => vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true), { interval: 10 });
  return { dialog, editor, provider, done, result, input, type, waitForSuggestions };
}

describe("task autocomplete provider", () => {
  it("offers loaded extension commands, skills, and templates with their invocation names", async () => {
    const provider = createTaskAutocompleteProvider(pi, cwd);
    expect((await suggestions(provider, "/"))?.items.map((item) => item.value)).toEqual(commands.map((command) => command.name));
    expect((await suggestions(provider, "/skill:te"))?.items).toEqual([
      { value: "skill:testing", label: "skill:testing", description: "Write tests" },
    ]);
    const result = await suggestions(provider, "/custom:2");
    expect(provider.applyCompletion(["/custom:2"], 0, 9, result!.items[0], result!.prefix).lines).toEqual(["/custom:2 "]);
  });

  it("completes @ references in the current directory, including inside slash-command arguments", async () => {
    const provider = createTaskAutocompleteProvider(pi, cwd);
    const text = "/review @widget";
    const result = await suggestions(provider, text);
    expect(result).toEqual({
      prefix: "@widget",
      items: [{ value: "@nested/widget.ts", label: "widget.ts", description: "nested/widget.ts" }],
    });
    expect(provider.applyCompletion([`${text} after`], 0, text.length, result!.items[0], result!.prefix).lines)
      .toEqual(["/review @nested/widget.ts  after"]);
    const args = (await readFile(fdArgs, "utf8")).split("\n");
    expect(args.slice(0, 2)).toEqual(["--base-directory", cwd]);
    expect(args).toContain("--exclude");
    expect(args).toContain(".git");
    expect(args).not.toContain("--no-ignore");
  });

  it("quotes file references containing spaces and leaves directories open for completion", async () => {
    const provider = createTaskAutocompleteProvider(pi, cwd);
    const files = await suggestions(provider, "fix @notes");
    expect(files?.items[0].value).toBe('@"task notes.md"');
    expect(provider.applyCompletion(["fix @notes"], 0, 10, files!.items[0], files!.prefix).lines)
      .toEqual(['fix @"task notes.md" ']);
    const directories = await suggestions(provider, "@nested");
    expect(directories?.items[0].value).toBe("@nested/");
    expect(provider.applyCompletion(["@nested"], 0, 7, directories!.items[0], directories!.prefix).lines)
      .toEqual(["@nested/"]);
  });

  it.each(["managed", "fdfind"])("uses %s fd binaries when fd is not on PATH", async (location) => {
    await rm(fd);
    await writeFd(location === "managed" ? join(root, "agent", "bin", "fd") : join(root, "bin", "fdfind"));
    expect((await suggestions(createTaskAutocompleteProvider(pi, cwd), "@widget"))?.items[0].value)
      .toBe("@nested/widget.ts");
  });

  it("skips non-executable fd candidates and prefers Pi's managed binary", async () => {
    const managed = join(root, "agent", "bin", "fd");
    await writeFd(managed, ["managed.ts"]);
    expect((await suggestions(createTaskAutocompleteProvider(pi, cwd), "@managed"))?.items[0].value).toBe("@managed.ts");
    await chmod(managed, 0o644);
    expect((await suggestions(createTaskAutocompleteProvider(pi, cwd), "@widget"))?.items[0].value).toBe("@nested/widget.ts");
  });

  it("keeps slash and Tab path completion working without fd", async () => {
    await rm(fd);
    const provider = createTaskAutocompleteProvider(pi, cwd);
    expect((await suggestions(provider, "/review"))?.items[0].value).toBe("review");
    expect((await suggestions(provider, "fix nested/wid", true))?.items[0].value).toBe("nested/widget.ts");
    expect(await suggestions(provider, "@widget")).toBeNull();
  });
});

describe("task prompt editor", () => {
  it("automatically suggests / and @, accepts with Enter/Tab, then submits task text", async () => {
    const prompt = openPrompt();
    prompt.type("/rev");
    await prompt.waitForSuggestions();
    prompt.input("\r");
    expect(prompt.editor.getText()).toBe("/review ");
    expect(prompt.done).not.toHaveBeenCalled();
    prompt.type("@widget");
    await prompt.waitForSuggestions();
    prompt.input("\t");
    expect(prompt.editor.getText()).toBe("/review @nested/widget.ts ");
    expect(prompt.done).not.toHaveBeenCalled();
    prompt.input("\r");
    await expect(prompt.result).resolves.toBe("/review @nested/widget.ts");
  });

  it("navigates candidates with arrow keys", async () => {
    const prompt = openPrompt();
    prompt.type("/");
    await prompt.waitForSuggestions();
    prompt.input("\x1b[B");
    prompt.input("\x1b[B");
    prompt.input("\x1b[A");
    prompt.input("\t");
    expect(prompt.editor.getText()).toBe("/skill:testing ");
    expect(prompt.done).not.toHaveBeenCalled();
  });

  it("closes suggestions on the first Escape and cancels on the second", async () => {
    const prompt = openPrompt();
    prompt.type("/rev");
    await prompt.waitForSuggestions();
    prompt.input("\x1b");
    expect(prompt.editor.isShowingAutocomplete()).toBe(false);
    expect(prompt.editor.getText()).toBe("/rev");
    expect(prompt.done).not.toHaveBeenCalled();
    prompt.input("\x1b");
    await expect(prompt.result).resolves.toBeUndefined();
  });

  it("lets Ctrl+C cancel even while suggestions are open", async () => {
    const prompt = openPrompt();
    prompt.type("/");
    await prompt.waitForSuggestions();
    prompt.input("\x03");
    await expect(prompt.result).resolves.toBeUndefined();
    expect(prompt.editor.isShowingAutocomplete()).toBe(false);
  });

  it.each(["", "   "])("treats an empty task as cancellation (%j)", async (text) => {
    const prompt = openPrompt();
    prompt.type(text);
    prompt.input("\r");
    await expect(prompt.result).resolves.toBeUndefined();
  });

  it("forwards focus for Chinese IME and fits narrow terminal widths", () => {
    const prompt = openPrompt("zh-CN");
    prompt.dialog.focused = true;
    prompt.type("修复中文输入");
    expect(prompt.editor.focused).toBe(true);
    for (const width of [20, 40, 80]) {
      const lines = prompt.dialog.render(width);
      expect(lines.join("\n")).toContain("任务描述");
      expect(lines.join("\n")).toContain(CURSOR_MARKER);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    prompt.dialog.focused = false;
    expect(prompt.editor.focused).toBe(false);
  });

  it("respects configured completion and cancellation keys", async () => {
    setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS, {
      "tui.input.tab": "ctrl+n",
      "tui.select.cancel": "ctrl+x",
    }));
    const prompt = openPrompt();
    expect(prompt.dialog.render(120).join("\n")).toContain("ctrl+n complete");
    prompt.type("/rev");
    await prompt.waitForSuggestions();
    prompt.input("\x0e");
    expect(prompt.editor.getText()).toBe("/review ");
    prompt.input("\x18");
    await expect(prompt.result).resolves.toBeUndefined();
  });

  it("aborts pending autocomplete work when the dialog is disposed", async () => {
    const prompt = openPrompt();
    let signal!: AbortSignal;
    let resolve!: (result: null) => void;
    vi.spyOn(prompt.provider, "getSuggestions").mockImplementation((_lines, _line, _col, options) => {
      signal = options.signal;
      return new Promise((done) => { resolve = done; });
    });
    prompt.type("/");
    await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 10 });
    expect(signal.aborted).toBe(false);
    prompt.dialog.dispose();
    expect(signal.aborted).toBe(true);
    resolve(null);
    await new Promise((done) => setImmediate(done));
    expect(prompt.editor.isShowingAutocomplete()).toBe(false);
  });
});
