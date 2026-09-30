import compose from "../../../packages/gh-runner/deploy/docker-compose.yml?raw";
import prompt from "../../../packages/gh-runner/prompts/setup-repo.md?raw";

/**
 * The compose file and setup prompt are imported from the files that ship with
 * each release, so the page can't show a copy that has drifted from them.
 */
const EMBEDS: Readonly<Record<string, string>> = { compose, prompt };

/**
 * Copy-to-clipboard for the install commands. Falls back to a hidden textarea
 * where the async Clipboard API isn't available (non-secure contexts, older
 * Safari), so the button is never decorative.
 */

const RESET_AFTER_MS = 1600;

async function writeToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }

  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.append(scratch);
  scratch.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  scratch.remove();
  return copied;
}

function wireCopyButton(button: HTMLButtonElement): void {
  const label = button.querySelector<HTMLElement>(".copy-state");
  const embed = button.dataset["copyEmbed"];
  const command = embed ? EMBEDS[embed] : button.dataset["copy"];
  if (!label || !command) return;

  let timer: number | undefined;

  button.addEventListener("click", () => {
    void writeToClipboard(command).then((copied) => {
      label.textContent = copied ? "Copied" : "Press ⌘C";
      button.dataset["copied"] = String(copied);

      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        label.textContent = "Copy";
        delete button.dataset["copied"];
      }, RESET_AFTER_MS);
    });
  });
}

document.querySelectorAll<HTMLElement>("[data-embed]").forEach((element) => {
  element.textContent = EMBEDS[element.dataset["embed"] ?? ""] ?? "";
});

document.querySelectorAll<HTMLButtonElement>("button.copy-command").forEach(wireCopyButton);
