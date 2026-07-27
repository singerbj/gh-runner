# gh-runner

Monorepo for **[`@singerbj/gh-runner`](https://www.npmjs.com/package/@singerbj/gh-runner)** — a CLI that temporarily registers the machine you're sitting at as a GitHub Actions self-hosted runner for the repo you're standing in. It stays online for as long as the command runs, then deregisters and deletes itself.

```bash
cd ~/code/my-repo
npx @singerbj/gh-runner              # pick platforms from a menu
npx @singerbj/gh-runner mac linux    # or name them — one runner each, in parallel
npx @singerbj/gh-runner --all        # everything this machine can serve
```

Linux can come from a container, so any machine can serve it; macOS and Windows have to be native, so asking a Mac for a Windows runner is an error rather than a silent no-op.

It also audits `.github/workflows` first, so you find out that nothing targets `runs-on: [self-hosted, gh-runner]` _before_ you sit waiting for a job that never arrives — and it offers to open a PR that fixes the YAML, prepared in a throwaway git worktree so your working tree is never touched.

## What's in here

| Path                 | Package               | What it is                                         |
| -------------------- | --------------------- | -------------------------------------------------- |
| `packages/gh-runner` | `@singerbj/gh-runner` | The CLI and its programmatic API (TypeScript, ESM) |
| `apps/web`           | `@gh-runner/web`      | The landing page (Vite, static, deployed to Pages) |

Full CLI docs live in [`packages/gh-runner/README.md`](packages/gh-runner/README.md).

## Development

Requires Node 20+.

```bash
npm install          # install the whole workspace (and the git hooks)
npm run dev          # watch-build the CLI and serve the landing page
npm run build        # turbo build every package
npm test             # turbo run the test suites
npm run typecheck    # turbo typecheck every package
npm run lint         # oxlint
npm run format       # oxfmt .
npm run audit        # better-npm-audit
npm run verify       # lint + format:check + typecheck + test, all of it
```

### Checks

[oxlint](https://oxc.rs/docs/guide/usage/linter.html) and [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) handle linting and formatting — both Rust, both fast enough to run on every commit. oxfmt owns every file type it supports (JS, TS, JSON); nothing else formats them, so there's no second formatter to disagree with.

A **husky pre-commit hook** runs all three checks:

```
pre-commit: oxlint
pre-commit: oxfmt
pre-commit: better-npm-audit
```

It's installed by `npm install` via the `prepare` script. The audit needs the network, so `SKIP_AUDIT=1 git commit ...` skips that one check when you're offline; `git commit --no-verify` skips everything.

[better-npm-audit](https://www.npmjs.com/package/better-npm-audit) also runs [every Monday at noon UTC](.github/workflows/audit.yml). A scheduled run that fails quietly is worthless, so a failure opens a `security`-labelled issue (or comments on the open one) with the report attached.

The repo is a [Turborepo](https://turborepo.com); each task above fans out to the workspaces that define it, with caching between runs.

### Trying the CLI locally

```bash
npm run build
node packages/gh-runner/dist/cli.js --help

# or link it onto your PATH
npm link --workspace @singerbj/gh-runner
gh-runner --repo owner/name
```

## Releasing

`main` is the release branch, and the version bumps itself. Merge a change to `packages/gh-runner` and the [Release workflow](.github/workflows/release.yml):

1. typechecks, tests, and builds every package;
2. asks npm what version is published and bumps the **patch** digit past it;
3. commits that bump to `main` as `Release vX.Y.Z`;
4. publishes with [npm provenance](https://docs.npmjs.com/generating-provenance-statements);
5. cuts a `vX.Y.Z` GitHub release with generated notes.

Merging never moves the major or minor. Those stay where you put them, and there are two ways to put them:

- **Set the version in `packages/gh-runner/package.json`.** A manifest ahead of npm is published exactly as written, with no bump commit — the way to pick a specific number.
- **Run the workflow from the Actions tab** and choose `minor` or `major`. Both reset the patch to zero: from `1.0.7`, minor gives `1.1.0` and major gives `2.0.0`.

Either way, merges afterwards resume at the patch: `1.1.0`, then `1.1.1`, `1.1.2`.

Nothing reads commit messages. An earlier version of this workflow looked for a `[major]` keyword, and the very commit that documented the keyword tripped it — `0.1.0` published as `1.0.0`. A release trigger you can't write about is a bad trigger.

Only changes under `packages/gh-runner` (plus `package-lock.json`) trigger a release, so landing work on the landing page or the root README mints nothing. The bump commit is pushed with `GITHUB_TOKEN`, which by design starts no further workflow runs — a release can't set off another release.

**If `main` is protected**, allow the GitHub Actions bot to push to it, or the workflow stops before publishing and says so. Bumping the manifest by hand in the PR is the way through otherwise.

**Required repository secret:** `NPM_TOKEN`, added at **Settings → Secrets and variables → Actions**.

Use a **classic Automation token**, or a granular token with **Read and write on _all_ packages**. A granular token limited to selected packages can't publish `@singerbj/gh-runner` until it exists — npm only lets you select packages that are already there, so the very first publish of a new name fails with a `403 Forbidden` that says nothing about scopes. (The other way through that chicken-and-egg: publish the first version by hand once, then scope a token — or [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) — to the package that now exists.)

The workflow checks the secret exists before building the tarball, and translates a `403` into the explanation above rather than leaving you with npm's wording.

## The landing page

`apps/web` deploys to GitHub Pages through the [Pages workflow](.github/workflows/pages.yml), which builds the site and publishes it on every push to `main` that touches it — plus on demand from the Actions tab.

**One-time setup:** switch Pages on at **Settings → Pages → Build and deployment → Source: GitHub Actions**. A workflow can't do this for itself — creating a Pages site needs admin rights, and `GITHUB_TOKEN` doesn't have them — so the workflow checks first and tells you to click that if it's missing, rather than failing deep inside `configure-pages`.

Once Pages is on, the site lands at **https://singerbj.github.io/gh-runner/**.

The Vite build uses a relative `base`, so the same output works at a domain root or under a `/gh-runner/` project path without reconfiguration.

## Security

`gh-runner` hands a CI job the machine it runs on, so it has a threat model worth reading: [`SECURITY.md`](SECURITY.md) covers what it guarantees, what it deliberately doesn't, and where to report a vulnerability.

## License

MIT
