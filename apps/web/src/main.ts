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
  const command = button.dataset["copy"];
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

document.querySelectorAll<HTMLButtonElement>("button.copy-command").forEach(wireCopyButton);
