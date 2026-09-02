import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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
