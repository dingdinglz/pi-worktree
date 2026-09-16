import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { BorderedLoader, getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, Editor, Text } from "@earendil-works/pi-tui";
import { createTranslator } from "./i18n.ts";
import type { Locale } from "./types.ts";

function findFdPath(cwd: string): string | undefined {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  // Pi installs fd here when it is not available on PATH. Debian also calls it fdfind.
  const candidates = [
    join(getAgentDir(), "bin", "fd"),
    ...["fd", "fdfind"].flatMap((name) => directories.map((directory) => resolve(cwd, directory, name))),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate. Slash and Tab path completion still work without fd.
    }
  }
  return undefined;
}

export function createTaskAutocompleteProvider(pi: Pick<ExtensionAPI, "getCommands">, cwd: string): CombinedAutocompleteProvider {
  return new CombinedAutocompleteProvider(
    pi.getCommands().map(({ name, description }) => ({ name, description })),
    cwd,
    findFdPath(cwd),
  );
}

export async function promptForTask(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  locale: Locale,
): Promise<string | undefined> {
  const t = createTranslator(locale);
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const editor = new Editor(tui, {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    });
    editor.setAutocompleteProvider(createTaskAutocompleteProvider(pi, ctx.cwd));
    editor.onSubmit = (text) => done(text.trim() || undefined);
    const hint = [
      t("taskCompletionHint"),
      `${keybindings.getKeys("tui.input.tab").join("/")} ${t("taskComplete")}`,
      `${keybindings.getKeys("tui.input.submit").join("/")} ${t("taskSubmit")}`,
      `${keybindings.getKeys("tui.select.cancel").join("/")} ${t("taskCancel")}`,
    ].join(" • ");

    return {
      get focused() { return editor.focused; },
      set focused(value: boolean) { editor.focused = value; },
      render(width) {
        return [
          ...new Text(theme.fg("accent", t("taskPrompt")), 0, 0).render(width),
          ...editor.render(width),
          ...new Text(theme.fg("dim", hint), 0, 0).render(width),
        ];
      },
      handleInput(data) {
        if (keybindings.matches(data, "tui.select.cancel") &&
            (!editor.isShowingAutocomplete() || keybindings.matches(data, "tui.input.copy"))) {
          editor.setText("");
          done(undefined);
          return;
        }
        // Enter accepts a completion first, including slash commands, without submitting the task.
        editor.disableSubmit = editor.isShowingAutocomplete();
        editor.handleInput(data);
        editor.disableSubmit = false;
        tui.requestRender();
      },
      invalidate: () => editor.invalidate(),
      // setText cancels pending completion requests and their fd child processes.
      dispose: () => editor.setText(""),
    };
  });
}

export interface LoaderResult<T> {
  value?: T;
  error?: Error;
  aborted: boolean;
}

export async function withCancellableLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<LoaderResult<T>> {
  const result = await ctx.ui.custom<LoaderResult<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
    loader.onAbort = () => {
      // BorderedLoader aborts its signal; the task resolves after its child process exits.
    };
    task(loader.signal)
      .then((value) => done({ value, aborted: false }))
      .catch((error) =>
        done({
          error: error instanceof Error ? error : new Error(String(error)),
          aborted: loader.signal.aborted,
        }),
      );
    return loader;
  });
  return result ?? { aborted: true };
}
