# Setting up a repo

Run this once per repo:

```sh
npx @singerbj/gh-runner setup
```

```txt
==> Setting up octocat/thing to fall back to gh-runner...
    ✓ ci.yml → build stays on ubuntu-latest — gh-runner-linux when out of minutes
    Pull request opened: https://github.com/octocat/thing/pull/42
```

It opens a pull request and exits. It doesn't register a runner. Use `--dry-run` to preview the changes without pushing.

## What the PR changes

One line per GitHub-hosted job:

```yaml
jobs:
  build:
    runs-on: ${{ vars.GH_RUNNER_LINUX || 'ubuntu-latest' }}
  bundle:
    runs-on: ${{ vars.GH_RUNNER_MAC || 'macos-14' }}
```

While the variable is unset, each job runs exactly where it did before. Merging the PR changes nothing until GitHub can't start hosted jobs. See [Out-of-minutes fallback](./fallback).

Each job keeps its platform:

| Hosted runner | Falls back to       | Variable            |
| ------------- | ------------------- | ------------------- |
| `ubuntu-*`    | `gh-runner-linux`   | `GH_RUNNER_LINUX`   |
| `macos-*`     | `gh-runner-mac`     | `GH_RUNNER_MAC`     |
| `windows-*`   | `gh-runner-windows` | `GH_RUNNER_WINDOWS` |
| anything else | `gh-runner`         | `GH_RUNNER`         |

Jobs that are already self-hosted, use an expression, or use a runner `group:` are left alone.

## The workflow check

Every runner session reads `.github/workflows` first and reports which jobs will land on it:

```txt
==> Checking .github/workflows for a matching runs-on...
    ✓ bench.yml → bench will run here
    ! ci.yml:9 → gpu wants cuda, which this runner won't have
      register it too with: --labels cuda
```

If nothing targets the runner, it offers to open the same PR as `gh-runner setup`.

## Your working tree is safe

The rewrite happens in a throwaway `git worktree` from your default branch. Your checkout, index and current branch are never touched. Only the `runs-on` values change, so comments and formatting survive.

## Options

| Flag                  | Effect                                   |
| --------------------- | ---------------------------------------- |
| `--dry-run`           | `setup` only: list changes, push nothing |
| `--fix-workflows`     | Open the PR without asking               |
| `--no-fix-workflows`  | Never offer the PR                       |
| `--fix-jobs a,b`      | Only rewrite these job ids               |
| `--fix-label LABEL`   | Use one label for every rewritten job    |
| `--no-workflow-check` | Skip the check entirely                  |
