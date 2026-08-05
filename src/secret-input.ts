import type { CustomTuiComponent, TuiController, TuiTheme, UserInterface } from "./types";

const BULLET = "•";

function withoutAnsiSequences(data: string): string {
  let result = "";

  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 0x1b) {
      result += data[index];
      continue;
    }

    const introducer = data[index + 1];
    if (introducer === "[") {
      index += 2;
      while (index < data.length) {
        const code = data.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
        index += 1;
      }
    } else if (introducer === "O") {
      index += 2;
    } else {
      index += 1;
    }
  }

  return result;
}

/** @internal Exported for deterministic component tests. */
export function createSecretInputComponent(
  title: string,
  tui: TuiController,
  theme: TuiTheme,
  done: (value: string | undefined) => void,
): CustomTuiComponent {
  const token: string[] = [];
  let completed = false;

  return {
    render: (_width) => [
      theme.fg("accent", title),
      `${theme.fg("muted", "> ")}${BULLET.repeat(token.length)}`,
    ],

    handleInput: (data) => {
      if (completed) {
        return;
      }
      if (data === "\x1b" || data.includes("\x03")) {
        completed = true;
        token.fill("");
        token.length = 0;
        done(undefined);
        return;
      }

      let changed = false;
      for (const character of withoutAnsiSequences(data)) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (character === "\r" || character === "\n") {
          if (token.length > 0) {
            if (changed) {
              tui.requestRender();
            }
            completed = true;
            const value = token.join("");
            token.fill("");
            token.length = 0;
            done(value);
          }
          return;
        }
        if (character === "\b" || character === "\x7f") {
          if (token.length > 0) {
            token.pop();
            changed = true;
          }
          continue;
        }
        if (codePoint < 0x20 || (codePoint >= 0x80 && codePoint <= 0x9f)) {
          continue;
        }
        token.push(character);
        changed = true;
      }

      if (changed) {
        tui.requestRender();
      }
    },

    invalidate: () => tui.requestRender(),
  };
}

export function promptSecretInput(
  ui: UserInterface,
  title = "Telegram Bot Token",
): Promise<string | undefined> {
  return ui.custom((tui, theme, _keybindings, done) =>
    createSecretInputComponent(title, tui, theme, done),
  );
}
