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
# node:lts already carries git, curl and the ICU libraries the actions runner
# needs, so the only additions are gh and an init process.
FROM node:lts

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

# The actions runner refuses to run as root. The image's "node" user owns
# /home/node, so a named volume there (the runner cache, job workspaces)
# starts out owned by it too.
USER node
WORKDIR /home/node

LABEL org.opencontainers.image.source="https://github.com/singerbj/gh-runner" \
      org.opencontainers.image.description="An always-on Linux GitHub Actions runner that GitHub-hosted jobs fall back to when the repo can't start them" \
      org.opencontainers.image.licenses="MIT"

# tini is PID 1: it reaps what CI jobs leave behind and hands SIGTERM to
# gh-runner, which deregisters the runner before the container exits.
ENTRYPOINT ["tini", "--", "gh-runner-entrypoint"]
