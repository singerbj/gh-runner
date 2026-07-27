# gh-runner

Monorepo for **[`gh-runner`](https://www.npmjs.com/package/gh-runner)** — a CLI that temporarily registers the machine you're sitting at as a GitHub Actions self-hosted runner for the repo you're standing in, waits for one job, then deregisters and deletes itself.

```bash
cd ~/code/my-repo
npx gh-runner              # pick platforms from a menu
npx gh-runner mac linux    # or name them — one runner each, in parallel
npx gh-runner --all        # everything this machine can serve
```

Linux can come from a container, so any machine can serve it; macOS and Windows have to be native, so asking a Mac for a Windows runner is an error rather than a silent no-op.

It also audits `.github/workflows` first, so you find out that nothing targets `runs-on: [self-hosted, gh-runner]` _before_ you sit waiting for a job that never arrives — and it offers to open a PR that fixes the YAML, prepared in a throwaway git worktree so your working tree is never touched.

## What's in here

| Path                 | Package          | What it is                                         |
| -------------------- | ---------------- | -------------------------------------------------- |
| `packages/gh-runner` | `gh-runner`      | The CLI and its programmatic API (TypeScript, ESM) |
| `apps/web`           | `@gh-runner/web` | The landing page (Vite, static, deployed to Pages) |

Full CLI docs live in [`packages/gh-runner/README.md`](packages/gh-runner/README.md).

## Development

Requires Node 20+.

```bash
npm install          # install the whole workspace
npm run dev          # watch-build the CLI and serve the landing page
npm run build        # turbo build every package
npm test             # turbo run the test suites
npm run typecheck    # turbo typecheck every package
npm run format       # prettier --write .
```

The repo is a [Turborepo](https://turborepo.com); each task above fans out to the workspaces that define it, with caching between runs.

### Trying the CLI locally

```bash
npm run build
node packages/gh-runner/dist/cli.js --help

# or link it onto your PATH
npm link --workspace gh-runner
gh-runner --repo owner/name
```

## Releasing

`main` is the release branch. Bump the version in `packages/gh-runner/package.json` and merge to `main` — the [Release workflow](.github/workflows/release.yml) then:

1. typechecks, tests, and builds every package;
2. checks whether that exact version already exists on npm and stops if it does;
3. publishes with [npm provenance](https://docs.npmjs.com/generating-provenance-statements);
4. cuts a `vX.Y.Z` GitHub release with generated notes.

Merges that don't change the version publish nothing, so unrelated work can land freely.

**Required repository secret:** `NPM_TOKEN` — an npm automation token with publish rights on `gh-runner`.

The landing page deploys to GitHub Pages from the same branch via the [Pages workflow](.github/workflows/pages.yml). Enable Pages once with "GitHub Actions" as the source, and every push to `main` updates it.

## License

MIT
