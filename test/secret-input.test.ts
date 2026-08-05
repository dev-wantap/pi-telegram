import { describe, expect, test } from "bun:test";
import { createSecretInputComponent, promptSecretInput } from "../src/secret-input";
import type { TuiComponent, TuiController, TuiTheme, UserInterface } from "../src/types";

const theme: TuiTheme = {
  fg: (_color, text) => text,
};

function harness() {
  let renders = 0;
  const completed: Array<string | undefined> = [];
  const tui: TuiController = {
    requestRender: () => {
      renders += 1;
    },
  };
  const component = createSecretInputComponent("Telegram Bot Token", tui, theme, (value) =>
    completed.push(value),
  );

  return {
    component,
    completed,
    renderCount: () => renders,
  };
}

describe("secret input component", () => {
  test("masks normal typing and multi-character paste without leaking the secret", () => {
    const { component, renderCount } = harness();
    const secret = "synthetic-secret";

    component.handleInput("syn");
    component.handleInput("thetic-secret");

    const transcript = component.render(80);
    expect(transcript).toEqual(["Telegram Bot Token", `> ${"•".repeat(secret.length)}`]);
    expect(transcript.join("\n")).not.toContain(secret);
    expect(renderCount()).toBe(2);
  });

  test("uses exactly one bullet per Unicode code point", () => {
    const { component } = harness();

    component.handleInput("A😀é");

    expect(component.render(80)[1]).toBe("> ••••");
  });

  test("backspace and delete each remove one code point", () => {
    const { component, renderCount } = harness();
    component.handleInput("A😀B");

    component.handleInput("\b");
    expect(component.render(80)[1]).toBe("> ••");
    component.handleInput("\x7f");
    expect(component.render(80)[1]).toBe("> •");
    expect(renderCount()).toBe(3);
  });

  test("empty Enter stays open and a non-empty Enter submits the full token", () => {
    const { component, completed } = harness();

    component.handleInput("\r");
    expect(completed).toEqual([]);
    component.handleInput("pasted-token");
    component.handleInput("\r");

    expect(completed).toEqual(["pasted-token"]);
    expect(component.render(80)[1]).toBe("> ");
  });

  test.each(["\x1b", "\x03"])("%j cancels with undefined", (key) => {
    const { component, completed } = harness();
    component.handleInput("secret");

    component.handleInput(key);

    expect(completed).toEqual([undefined]);
    expect(component.render(80)[1]).toBe("> ");
  });

  test("ignores ANSI sequences and control bytes", () => {
    const { component, completed, renderCount } = harness();

    component.handleInput("\x1b[A\x00ok\x1b[3~");
    component.handleInput("\n");

    expect(completed).toEqual(["ok"]);
    expect(renderCount()).toBe(1);
  });

  test("invalidate requests a render", () => {
    const { component, renderCount } = harness();

    component.invalidate();

    expect(renderCount()).toBe(1);
  });
});

test("promptSecretInput awaits the component through ui.custom", async () => {
  let component: TuiComponent | undefined;
  const ui: UserInterface = {
    input: async () => undefined,
    confirm: async () => false,
    notify: () => {},
    custom: async (factory) =>
      new Promise((resolve) => {
        const created = factory({ requestRender: () => {} }, theme, {}, resolve);
        if (created instanceof Promise) throw new Error("Unexpected async test component");
        component = created;
      }),
  };

  const result = promptSecretInput(ui, "Token");
  expect(component?.render(80)).toEqual(["Token", "> "]);
  component?.handleInput?.("abc\r");

  expect(await result).toBe("abc");
});
