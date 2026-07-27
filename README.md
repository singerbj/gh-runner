# gh-runner

Monorepo for **[`gh-runner-here`](https://www.npmjs.com/package/gh-runner-here)** — a CLI that temporarily registers the machine you're sitting at as a GitHub Actions self-hosted runner for the repo you're standing in, waits for one job, then deregisters and deletes itself.

```bash
cd ~/code/my-repo
npx gh-runner-here
```

## What's in here

| Path                      | Package               | What it is                                         |
| ------------------------- | --------------------- | -------------------------------------------------- |
| `packages/gh-runner-here` | `gh-runner-here`      | The CLI and its programmatic API (TypeScript, ESM) |
| `apps/web`                | `@gh-runner-here/web` | The landing page (Vite, static, deployed to Pages) |

Full CLI docs live in [`packages/gh-runner-here/README.md`](packages/gh-runner-here/README.md).

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
node packages/gh-runner-here/dist/cli.js --help

# or link it onto your PATH
npm link --workspace gh-runner-here
gh-runner-here --repo owner/name
```

## Releasing

`main` is the release branch. Bump the version in `packages/gh-runner-here/package.json` and merge to `main` — the [Release workflow](.github/workflows/release.yml) then:

1. typechecks, tests, and builds every package;
2. checks whether that exact version already exists on npm and stops if it does;
3. publishes with [npm provenance](https://docs.npmjs.com/generating-provenance-statements);
4. cuts a `vX.Y.Z` GitHub release with generated notes.

Merges that don't change the version publish nothing, so unrelated work can land freely.

**Required repository secret:** `NPM_TOKEN` — an npm automation token with publish rights on `gh-runner-here`.

The landing page deploys to GitHub Pages from the same branch via the [Pages workflow](.github/workflows/pages.yml). Enable Pages once with "GitHub Actions" as the source, and every push to `main` updates it.

## License

MIT
