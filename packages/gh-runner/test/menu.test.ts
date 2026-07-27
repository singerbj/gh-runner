import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { initialState, promptMultiSelect, reduce, renderLines, selected } from "../src/menu.js";
import type { MenuChoice, MenuState } from "../src/menu.js";

const CHOICES: Array<MenuChoice<string>> = [
  {
    value: "osx",
    label: "macOS",
    detail: "native — this machine",
    disabled: false,
    selected: true,
  },
  { value: "linux", label: "Linux", detail: "in a container", disabled: false, selected: false },
  {
    value: "win",
    label: "Windows",
    detail: "needs a Windows machine",
    disabled: true,
    selected: false,
  },
];

const press = (state: MenuState<string>, ...keys: string[]) =>
  keys.reduce((current, name) => reduce(current, { name }), state);

describe("menu state", () => {
  it("starts on the first selectable choice", () => {
    expect(initialState(CHOICES).cursor).toBe(0);
    const disabledFirst = initialState([{ ...CHOICES[2]! }, { ...CHOICES[0]! }]);
    expect(disabledFirst.cursor).toBe(1);
  });

  it("moves with arrows and vim keys, skipping what can't be picked", () => {
    const state = initialState(CHOICES);
    expect(press(state, "down").cursor).toBe(1);
    expect(press(state, "j").cursor).toBe(1);
    // Windows is disabled, so wrapping goes past it back to macOS.
    expect(press(state, "down", "down").cursor).toBe(0);
    expect(press(state, "up").cursor).toBe(1);
  });

  it("toggles with space", () => {
    const state = press(initialState(CHOICES), "down", "space");
    expect(selected(state)).toEqual(["osx", "linux"]);
    expect(selected(press(state, "space"))).toEqual(["osx"]);
  });

  it("refuses to tick a disabled choice", () => {
    // Cursor can't even reach Windows, but force it and try anyway.
    const forced: MenuState<string> = { ...initialState(CHOICES), cursor: 2 };
    expect(selected(reduce(forced, { name: "space" }))).toEqual(["osx"]);
  });

  it("toggles everything selectable with a", () => {
    const all = press(initialState(CHOICES), "a");
    expect(selected(all)).toEqual(["osx", "linux"]);
    expect(selected(press(all, "a"))).toEqual([]);
  });

  it("confirms on enter and cancels on escape or ctrl-c", () => {
    expect(press(initialState(CHOICES), "return").status).toBe("confirmed");
    expect(press(initialState(CHOICES), "escape").status).toBe("cancelled");
    expect(reduce(initialState(CHOICES), { name: "c", ctrl: true }).status).toBe("cancelled");
  });

  it("ignores keys once it's closed", () => {
    const done = press(initialState(CHOICES), "return");
    expect(press(done, "space", "escape")).toBe(done);
  });
});

describe("renderLines", () => {
  it("shows state, reasons, and the key hints", () => {
    const lines = renderLines(initialState(CHOICES), { title: "Which platforms?" });
    expect(lines[0]).toContain("Which platforms?");
    expect(lines[1]).toContain("space toggle");
    expect(lines[2]).toContain("❯");
    expect(lines[2]).toContain("◉"); // macOS pre-selected
    expect(lines[3]).toContain("◯"); // Linux not selected
    expect(lines[4]).toContain("✗"); // Windows unavailable
    expect(lines[4]).toContain("needs a Windows machine");
  });

  it("aligns labels of different lengths", () => {
    const lines = renderLines(initialState(CHOICES), { title: "t" });
    const detailColumn = lines
      .slice(2)
      .map((line) => line.indexOf("native") + line.indexOf("in a"));
    expect(detailColumn.length).toBe(3);
    expect(lines[2]).toContain("macOS  ");
  });
});

describe("promptMultiSelect", () => {
  it("returns null without a TTY, so scripts don't hang", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;
    await expect(
      promptMultiSelect({
        title: "t",
        choices: CHOICES,
        input: input as unknown as NodeJS.ReadStream,
        output: new PassThrough() as unknown as NodeJS.WriteStream,
      }),
    ).resolves.toBeNull();
  });

  it("drives a real keypress stream to a selection", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: (raw: boolean) => void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = () => {};

    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    output.isTTY = false;
    output.resume();

    const promise = promptMultiSelect({
      title: "Which platforms?",
      choices: CHOICES,
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    // down (to Linux), space (tick it), enter.
    setImmediate(() => {
      input.write("\u001b[B");
      input.write(" ");
      input.write("\r");
    });

    await expect(promise).resolves.toEqual(["osx", "linux"]);
  });
});
