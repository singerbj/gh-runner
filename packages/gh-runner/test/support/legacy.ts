/**
 * Workflows as gh-runner 1.0.x wrote them, with a `gh-runner-check` probe job
 * choosing each job's runner. Nothing writes these any more; the fix converts
 * them, so the tests need them verbatim.
 */

const probeJob = (runsOn: string, targets: string[]) => [
  "  gh-runner-check:",
  "    name: Pick runners",
  `    runs-on: ${runsOn}`,
  "    permissions:",
  "      contents: read",
  "    outputs:",
  '      runners: "${{ steps.pick.outputs.runners }}"',
  "    steps:",
  "      - uses: singerbj/gh-runner/actions/pick-runner@0123456789abcdef0123456789abcdef01234567 # v1.0.5",
  "        id: pick",
  "        with:",
  "          targets: |",
  "            {",
  ...targets.map((line, i) => `              ${line}${i === targets.length - 1 ? "" : ","}`),
  "            }",
  "",
];

/** The default mode: prefer the runner while one is online, else the hosted one. */
export const LEGACY_PROBE = [
  "name: CI",
  "on: [push]",
  "jobs:",
  ...probeJob("ubuntu-latest", [
    '"linux": { "labels": ["self-hosted","gh-runner-linux"], "fallback": "ubuntu-latest" }',
    '"mac": { "labels": ["self-hosted","gh-runner-mac"], "fallback": "macos-14" }',
  ]),
  "  build:",
  "    needs: [gh-runner-check]",
  "    runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || 'ubuntu-latest' }}",
  "    steps:",
  "      - run: make",
  "  test-mac:",
  "    needs: [build, gh-runner-check]",
  "    runs-on: ${{ fromJSON(needs.gh-runner-check.outputs.runners).mac || 'macos-14' }}",
  "    steps:",
  "      - run: make test",
  "",
].join("\n");

/** `--no-hosted-fallback`: the hosted runner survives only under `hosted`. */
export const LEGACY_NO_HOSTED_FALLBACK = [
  "jobs:",
  ...probeJob("[self-hosted, gh-runner]", [
    '"linux": { "labels": ["self-hosted","gh-runner-linux"], "fallback": ["self-hosted","gh-runner-linux"], "hosted": "ubuntu-latest" }',
  ]),
  "  build:",
  "    needs:",
  "      - gh-runner-check",
  `    runs-on: \${{ fromJSON(needs.gh-runner-check.outputs.runners).linux || fromJSON('["self-hosted","gh-runner-linux"]') }}`,
  "",
].join("\n");
