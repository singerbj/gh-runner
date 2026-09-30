// A `gh` stand-in: forwards its argv to the MockGitHub at $MOCK_GH_URL and
// replays the answer — stdout, stderr and exit code — as the real gh would.
//
// Deliberately dumb. Everything that decides what an answer is lives in
// mock-github.ts, so the in-process and spawned paths can't disagree.

const url = process.env.MOCK_GH_URL;
if (!url) {
  process.stderr.write("fake gh: MOCK_GH_URL is not set\n");
  process.exit(2);
}

const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ args: process.argv.slice(2) }),
});
const { code, stdout, stderr } = await response.json();
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
