# ghcr.io/singerbj/gh-runner: an always-on Linux gh-runner.
#
#   docker run -d --restart unless-stopped \
#     -e GH_TOKEN=github_pat_… -e GH_RUNNER_REPO=you/your-repo \
#     ghcr.io/singerbj/gh-runner
#
# Every release publishes this for linux/amd64 and linux/arm64, tagged with the
# release version and `latest`. To build it yourself:
#
#   docker build --build-arg GH_RUNNER_VERSION=0.0.2 -t gh-runner packages/gh-runner/deploy
#
# It is also the image `gh-runner linux` runs in Docker, so a job sees the same
# machine whichever of the two picks it up: GitHub's runner image (Ubuntu, git,
# curl, jq, the Docker CLI, and a `runner` user with passwordless sudo, so
# `apt-get` and `npx playwright install --with-deps` work), plus Node LTS, gh,
# and an init process.
FROM ghcr.io/actions/actions-runner:latest

USER root

# Node comes from the official image rather than a distro package, so it is the
# same LTS build the node:lts image carries.
COPY --from=node:lts /usr/local/bin/node /usr/local/bin/node
COPY --from=node:lts /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node:lts /usr/local/include/node /usr/local/include/node
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && if [ -d /usr/local/lib/node_modules/corepack ]; then \
      ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    fi \
 && node --version && npm --version

RUN install -d -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh tini \
 && rm -rf /var/lib/apt/lists/*

ARG GH_RUNNER_VERSION=latest
RUN npm install -g --no-fund --no-audit "@singerbj/gh-runner@${GH_RUNNER_VERSION}" \
 && npm cache clean --force

COPY --chmod=755 entrypoint.sh /usr/local/bin/gh-runner-entrypoint

# The actions runner refuses to run as root. The runner download cache lives
# here, made up front so a named volume mounted on it starts out owned by
# `runner` too.
USER runner
RUN mkdir -p /home/runner/.cache/gh-runner
WORKDIR /home/runner

LABEL org.opencontainers.image.source="https://github.com/singerbj/gh-runner" \
      org.opencontainers.image.description="An always-on Linux GitHub Actions runner that GitHub-hosted jobs fall back to when the repo can't start them" \
      org.opencontainers.image.licenses="MIT"

# tini is PID 1: it reaps what CI jobs leave behind and hands SIGTERM to
# gh-runner, which deregisters the runner before the container exits.
ENTRYPOINT ["tini", "--", "gh-runner-entrypoint"]
