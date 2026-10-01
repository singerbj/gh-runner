import { defineComponent, h, ref } from "vue";

const COMMAND = "npx @singerbj/gh-runner@latest";
const RESET_AFTER_MS = 1600;

/**
 * The one-line install command under the hero, with a copy button.
 */
export const InstallCommand = defineComponent({
  name: "InstallCommand",
  setup() {
    const copied = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function copy(): Promise<void> {
      try {
        await navigator.clipboard.writeText(COMMAND);
        copied.value = true;
      } catch {
        // Non-secure context: leave the text selectable instead.
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => (copied.value = false), RESET_AFTER_MS);
    }

    return () =>
      h(
        "button",
        {
          class: "install-command",
          type: "button",
          "aria-label": `Copy ${COMMAND} to clipboard`,
          onClick: copy,
        },
        [
          h("code", [h("span", { class: "prompt" }, "$ "), COMMAND]),
          h("span", { class: "state" }, copied.value ? "Copied" : "Copy"),
        ],
      );
  },
});
