import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createConfirm, declineAll } from "../src/prompt.js";

/** A stream that claims to be a terminal, so the prompt actually asks. */
function fakeTty(answer: string) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  output.isTTY = true;

  let asked = "";
  output.on("data", (chunk: Buffer) => {
    asked += chunk.toString();
  });

  setImmediate(() => input.write(`${answer}\n`));
  return { input, output, asked: () => asked };
}

const confirmWith = (answer: string, fallback?: boolean) => {
  const tty = fakeTty(answer);
  const confirm = createConfirm({
    input: tty.input as unknown as NodeJS.ReadStream,
    output: tty.output as unknown as NodeJS.WriteStream,
  });
  return { confirm, asked: tty.asked };
};

describe("createConfirm", () => {
  it.each([
    ["y", true],
    ["Y", true],
    ["yes", true],
    ["n", false],
    ["no", false],
    ["whatever", false],
  ])("reads %s as %s", async (answer, expected) => {
    const { confirm } = confirmWith(answer);
    await expect(confirm("Open a PR?")).resolves.toBe(expected);
  });

  it("uses the fallback for an empty answer and shows it in the suffix", async () => {
    const yes = confirmWith("");
    await expect(yes.confirm("Open a PR?", true)).resolves.toBe(true);
    expect(yes.asked()).toContain("[Y/n]");

    const no = confirmWith("");
    await expect(no.confirm("Open a PR?", false)).resolves.toBe(false);
    expect(no.asked()).toContain("[y/N]");
  });

  it("answers the fallback instead of blocking when there is no terminal", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;
    const confirm = createConfirm({
      input: input as unknown as NodeJS.ReadStream,
      output: new PassThrough() as unknown as NodeJS.WriteStream,
    });

    // Nothing is ever written to `input`; this would hang if it prompted.
    await expect(confirm("Open a PR?")).resolves.toBe(false);
    await expect(confirm("Open a PR?", true)).resolves.toBe(true);
  });
});

describe("declineAll", () => {
  it("never asks and never agrees", async () => {
    await expect(declineAll("Open a PR?")).resolves.toBe(false);
  });
});
