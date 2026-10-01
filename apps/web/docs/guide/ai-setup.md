# Setup with an AI agent

Paste this prompt into Claude Code, Copilot, Cursor or any coding agent with your repo open. The agent will:

- run `gh-runner setup`, or make the same edit by hand if `gh` isn't available
- flag jobs that may not work on a gh-runner machine
- add a short "Self-hosted fallback" section to your README
- open a PR with a table of every job it changed or skipped

Use the copy button on the code block, or [download it as Markdown](https://github.com/singerbj/gh-runner/releases/latest/download/gh-runner-setup-prompt.md).

<<< ../../../../packages/gh-runner/prompts/setup-repo.md{md}
