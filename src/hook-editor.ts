import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import { formatHookCommand, parseHookCommand, validatePostCreateSteps } from "./hook-commands.ts";
import type { HookStep } from "./types.ts";
import { redactSecrets, sanitizeForDisplay } from "./util.ts";

export async function editPostCreateSteps(
  ctx: ExtensionCommandContext,
  initial: HookStep[],
  zh: boolean,
): Promise<HookStep[] | undefined> {
  return ctx.ui.custom<HookStep[] | undefined>((tui, theme, keybindings, done) => {
    let steps = structuredClone(initial);
    let list: SelectList;
    let editor: Editor | undefined;
    let editingIndex = 0;
    let focused = false;
    let error = "";
    const border = new DynamicBorder((text: string) => theme.fg("accent", text));
    const selectTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
    const key = (id: Parameters<typeof keybindings.getKeys>[0]) => keybindings.getKeys(id).join("/");
    const selectHint = zh
      ? `${key("tui.select.up")}/${key("tui.select.down")} 选择 · ${key("tui.select.confirm")} 修改/选择 · a 添加 · d 删除 · Alt+↑/↓ 上移/下移 · Ctrl+S 完成 · ${key("tui.select.cancel")} 取消`
      : `${key("tui.select.up")}/${key("tui.select.down")} select · ${key("tui.select.confirm")} edit/choose · a add · d delete · Alt+↑/↓ move · Ctrl+S done · ${key("tui.select.cancel")} cancel`;
    const editHint = zh
      ? `${key("tui.input.submit")} 确认命令 · ${key("tui.select.cancel")} 放弃本次输入`
      : `${key("tui.input.submit")} apply command · ${key("tui.select.cancel")} discard input`;
    const textLines = (text: string, width: number, color: "accent" | "muted" | "dim" | "error" = "muted") =>
      new Text(theme.fg(color, text), 0, 0).render(width);

    function selectedIndex(): number | undefined {
      const value = list.getSelectedItem()?.value;
      return value?.startsWith("step:") ? Number(value.slice(5)) : undefined;
    }

    function showError(cause: unknown): void {
      error = redactSecrets(`${zh ? "命令无效" : "Invalid command"}: ${cause instanceof Error ? cause.message : cause}`);
    }

    function finish(): void {
      try {
        validatePostCreateSteps(steps);
        done(steps);
      } catch (cause) {
        showError(cause);
      }
    }

    function startEditing(index: number): void {
      editingIndex = index;
      error = "";
      editor = new Editor(tui, { borderColor: (text) => theme.fg("accent", text), selectList: selectTheme });
      const previous = steps[index];
      const prefill = previous ? sanitizeForDisplay(formatHookCommand(previous)) : "";
      editor.setText(prefill);
      editor.focused = focused;
      editor.onSubmit = (line) => {
        try {
          const step = previous && line === prefill ? previous : parseHookCommand(line, previous);
          const next = [...steps];
          next[index] = step;
          validatePostCreateSteps(next);
          steps = next;
          editor = undefined;
          error = "";
          rebuild(index);
        } catch (cause) {
          // Editor clears itself on submit; retain invalid input for correction.
          editor?.setText(line);
          showError(cause);
        }
      };
    }

    function rebuild(index: number): void {
      list = new SelectList([
        ...steps.map((step, i) => ({
          value: `step:${i}`,
          label: `${i + 1}. ${step.shell ? "[shell] " : ""}${redactSecrets(formatHookCommand(step)).replace(/\n/g, "\\n").replace(/\t/g, "\\t")}`,
        })),
        { value: "add", label: zh ? "+ 添加命令" : "+ Add command" },
        { value: "done", label: zh ? "✓ 完成编辑，返回审阅" : "✓ Done editing; return to review" },
        { value: "cancel", label: zh ? "取消编辑" : "Cancel editing" },
      ], Math.max(3, Math.min(10, tui.terminal.rows - 12)), selectTheme);
      list.setSelectedIndex(index);
      list.onSelect = (item) => {
        if (item.value === "add") startEditing(steps.length);
        else if (item.value === "done") finish();
        else if (item.value === "cancel") done(undefined);
        else startEditing(Number(item.value.slice(5)));
      };
      list.onCancel = () => done(undefined);
    }

    function move(delta: number): void {
      const index = selectedIndex();
      if (index === undefined || index + delta < 0 || index + delta >= steps.length) return;
      [steps[index], steps[index + delta]] = [steps[index + delta], steps[index]];
      rebuild(index + delta);
    }

    rebuild(0);
    return {
      get focused() { return focused; },
      set focused(value: boolean) {
        focused = value;
        if (editor) editor.focused = value;
      },
      render(width) {
        const index = editor ? editingIndex : selectedIndex();
        const step = index === undefined ? undefined : steps[index];
        const metadata = step
          ? `${step.shell ? "shell" : "argv"} · timeout=${step.timeoutMs ?? 900000}ms${step.env ? ` · env: ${Object.keys(step.env).join(", ")}` : ""}`
          : "";
        return [
          ...border.render(width),
          ...textLines(zh ? "postCreate 命令列表" : "postCreate command list", width, "accent"),
          ...list.render(width),
          ...textLines(metadata, width, "dim"),
          ...(editor ? [
            ...textLines(editingIndex === steps.length
              ? (zh ? "添加命令（输入一行命令）" : "Add command (one command line)")
              : (zh ? `修改第 ${editingIndex + 1} 条命令` : `Edit command ${editingIndex + 1}`), width, "accent"),
            ...editor.render(width),
          ] : []),
          ...(error ? textLines(error, width, "error") : []),
          ...textLines(editor ? editHint : selectHint, width, "dim"),
          ...textLines(zh
            ? "新命令按 argv 执行，带空格的参数请加引号；shell 语法请显式使用 sh -c '...'。"
            : "New commands use argv; quote arguments containing spaces. For shell syntax, use explicit sh -c '...'.", width, "dim"),
          ...border.render(width),
        ];
      },
      handleInput(data) {
        if (editor) {
          if (keybindings.matches(data, "tui.select.cancel")) {
            editor = undefined;
            error = "";
          } else editor.handleInput(data);
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        } else if (matchesKey(data, "a")) {
          startEditing(steps.length);
        } else if (matchesKey(data, "d") || matchesKey(data, "delete")) {
          const index = selectedIndex();
          if (index !== undefined) {
            steps.splice(index, 1);
            rebuild(Math.min(index, Math.max(0, steps.length - 1)));
          }
        } else if (matchesKey(data, "alt+up")) {
          move(-1);
        } else if (matchesKey(data, "alt+down")) {
          move(1);
        } else if (matchesKey(data, "ctrl+s")) {
          finish();
        } else list.handleInput(data);
        tui.requestRender();
      },
      invalidate() {
        list.invalidate();
        editor?.invalidate();
        border.invalidate();
      },
    };
  });
}
