# Platforms & labels

## Choosing platforms

With no arguments, `gh-runner` shows a menu with your own OS pre-selected. Platforms this machine can't serve are listed with the reason.

Name them to skip the menu:

```sh
gh-runner mac              # mac | macos | darwin | osx
gh-runner linux            # linux | ubuntu
gh-runner windows          # windows | win
gh-runner mac linux        # several, in parallel
gh-runner --all            # everything possible here
```

Asking for a platform this machine can't serve is an error. `--all` never errors.

## Labels

Every runner registers these labels:

| Label               | Registered on    | Use it when                |
| ------------------- | ---------------- | -------------------------- |
| `gh-runner`         | every machine    | the job can run anywhere   |
| `gh-runner-mac`     | macOS only       | the job needs macOS        |
| `gh-runner-linux`   | Linux only       | the job needs Linux        |
| `gh-runner-windows` | Windows only     | the job needs Windows      |
| `<hostname>`        | that one machine | the job needs your machine |

```yaml
jobs:
  any:
    runs-on: [self-hosted, gh-runner]
  mac-only:
    runs-on: [self-hosted, gh-runner-mac]
```

GitHub also adds `self-hosted`, the OS and the architecture (`X64`, `ARM64`). Add your own with `--labels gpu,cuda-12`.

## What each machine can serve

| Your machine | Native              | Via Docker        | Never          |
| ------------ | ------------------- | ----------------- | -------------- |
| macOS        | `gh-runner-mac`     | `gh-runner-linux` | Windows        |
| Linux        | `gh-runner-linux`   | —                 | macOS, Windows |
| Windows      | `gh-runner-windows` | `gh-runner-linux` | macOS          |

Docker can provide Linux anywhere. It can't provide macOS or Windows: there's no macOS container runtime, and Windows containers need a Windows host.

## Linux in a container

`gh-runner linux` on a Mac or PC runs GitHub's runner image in Docker. It registers the same labels as a native Linux machine.

```sh
gh-runner linux --docker-platform linux/amd64   # x64 under emulation
gh-runner linux --docker-image my/runner:1      # your own image
```

- **Isolated:** no host mounts and no Docker socket, so jobs can't see your files.
- **No `docker build`:** jobs that need Docker won't work in this mode.
- **First run** pulls a ~1 GB image.

On a Linux host, `linux` runs natively. Pass `--docker-image` or `--docker-platform` to use a container instead.
