import { emitKeypressEvents } from "node:readline";
import type { Styles } from "./logger.js";
import { createStyles } from "./logger.js";

export interface MenuChoice<T> {
  value: T;
  label: string;
  detail: string;
  /** Shown greyed out and impossible to tick. */
  disabled: boolean;
  selected: boolean;
}

export interface MenuState<T> {
  choices: Array<MenuChoice<T>>;
  cursor: number;
  status: "open" | "confirmed" | "cancelled";
}

/** The subset of Node's keypress event this menu reacts to. */
export interface MenuKey {
  name?: string | undefined;
  sequence?: string | undefined;
  ctrl?: boolean | undefined;
}

export function initialState<T>(choices: ReadonlyArray<MenuChoice<T>>): MenuState<T> {
  const first = choices.findIndex((choice) => !choice.disabled);
  return {
    choices: choices.map((choice) => ({ ...choice })),
    cursor: first === -1 ? 0 : first,
    status: "open",
  };
}

/** Moves to the next selectable choice, wrapping, and stays put if there is none. */
function move<T>(state: MenuState<T>, step: number): MenuState<T> {
  const { length } = state.choices;
  for (let i = 1; i <= length; i += 1) {
    const next = (state.cursor + step * i + length * i) % length;
    if (!state.choices[next]?.disabled) {
      return { ...state, cursor: next };
    }
  }
  return state;
}

/** Pure keypress handling, so the behaviour is testable without a terminal. */
export function reduce<T>(state: MenuState<T>, key: MenuKey): MenuState<T> {
  if (state.status !== "open") return state;

  if (key.ctrl && key.name === "c") {
    return { ...state, status: "cancelled" };
  }

  switch (key.name) {
    case "up":
    case "k":
      return move(state, -1);
    case "down":
    case "j":
      return move(state, 1);
    case "space": {
      const choice = state.choices[state.cursor];
      if (!choice || choice.disabled) return state;
      const choices = state.choices.map((candidate, index) =>
        index === state.cursor ? { ...candidate, selected: !candidate.selected } : candidate,
      );
      return { ...state, choices };
    }
    case "a": {
      // Toggle all-on / all-off across everything selectable.
      const selectable = state.choices.filter((choice) => !choice.disabled);
      const turnOn = selectable.some((choice) => !choice.selected);
      return {
        ...state,
        choices: state.choices.map((choice) =>
          choice.disabled ? choice : { ...choice, selected: turnOn },
        ),
      };
    }
    case "return":
    case "enter":
      return { ...state, status: "confirmed" };
    case "escape":
      return { ...state, status: "cancelled" };
    default:
      return state;
  }
}

export function selected<T>(state: MenuState<T>): T[] {
  return state.choices.filter((choice) => choice.selected).map((choice) => choice.value);
}

export interface RenderOptions {
  title: string;
  styles?: Styles;
}

/** Renders the menu as lines, without cursor movement — the driver handles that. */
export function renderLines<T>(state: MenuState<T>, options: RenderOptions): string[] {
  const styles = options.styles ?? createStyles(false);
  const { bold, dim, green } = styles;

  const width = Math.max(...state.choices.map((choice) => choice.label.length));

  const lines = [
    `${bold("?")} ${options.title}`,
    dim("  ↑↓ move · space toggle · a all · enter confirm · ctrl-c cancel"),
  ];

  state.choices.forEach((choice, index) => {
    const pointer = index === state.cursor ? green("❯") : " ";
    const box = choice.disabled ? dim("✗") : choice.selected ? green("◉") : "◯";
    const label = choice.label.padEnd(width);
    const text = choice.disabled
      ? dim(`${label}  ${choice.detail}`)
      : `${label}  ${dim(choice.detail)}`;
    lines.push(`${pointer} ${box} ${text}`);
  });

  return lines;
}

export interface PromptOptions<T> extends RenderOptions {
  choices: ReadonlyArray<MenuChoice<T>>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * Runs the menu against a terminal.
 *
 * Returns null when there's no TTY to draw on — callers fall back to a default
 * rather than blocking a script forever — and null when the user cancels.
 */
export function promptMultiSelect<T>(options: PromptOptions<T>): Promise<T[] | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  if (!input.isTTY) {
    return Promise.resolve(null);
  }

  const styles = options.styles ?? createStyles(Boolean(output.isTTY));
  let state = initialState(options.choices);
  let drawn = 0;

  const draw = () => {
    if (drawn > 0) {
      // Back to the top of what we drew last time, then wipe forwards.
      output.write(`\u001b[${drawn}A\u001b[0J`);
    }
    const lines = renderLines(state, { title: options.title, styles });
    output.write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  return new Promise<T[] | null>((resolve) => {
    emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    output.write("\u001b[?25l"); // hide the cursor while we redraw

    const finish = (result: T[] | null) => {
      input.off("keypress", onKeypress);
      input.setRawMode?.(Boolean(wasRaw));
      input.pause();
      output.write("\u001b[?25h");
      resolve(result);
    };

    const onKeypress = (_chunk: string, key: MenuKey | undefined) => {
      state = reduce(state, key ?? {});
      if (state.status === "open") {
        draw();
        return;
      }
      draw();
      finish(state.status === "confirmed" ? selected(state) : null);
    };

    input.on("keypress", onKeypress);
    input.resume();
    draw();
  });
}
