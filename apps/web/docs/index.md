---
layout: home

hero:
  name: gh-runner
  text: Your machine as a GitHub Actions runner
  tagline: One command. Gone when you stop it.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/singerbj/gh-runner

features:
  - lucide: cpu
    title: Your hardware
    details: Apple silicon, your GPU, services behind the VPN. Jobs run where they make sense.
    link: /guide/platforms
  - lucide: trash-2
    title: Leaves nothing behind
    details: Ctrl+C deregisters the runner and deletes everything it downloaded.
    link: /guide/getting-started
  - lucide: refresh-cw
    title: Out-of-minutes fallback
    details: Jobs stay on GitHub-hosted runners until GitHub refuses them, then move to you.
    link: /guide/fallback
  - lucide: container
    title: Always on with Docker
    details: A prebuilt image keeps a Linux runner online on any server.
    link: /guide/docker
---
