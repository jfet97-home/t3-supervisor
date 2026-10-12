---
name: t3-lab
description: Operate and maintain Andrea's local Lima VM for the T3 isolation experiment, including SSH access, login startup, matching Nightly runtimes, and the versioned setup notes.
---

# T3 Lab

## Source of truth

The experiment lives at
`/Users/andreasimonecosta/Developer/t3-supervisor/experiments/t3-lab/`.
Read its `README.md`, `lima.yaml`, `ssh-config`, and applicable project guidance
before changing the setup. The architecture plan is `architecture-v1.md`.
Keep configuration and verified progress there rather than creating another repo.

This skill's maintained source is `skill/SKILL.md` in that experiment folder.
The global `~/.agents/skills/t3-lab` directory links to it. Update the source and
the setup notes after relevant configuration changes; never store credentials.

## Scope and authorization

Describe one concrete setup action and wait for approval before performing it,
unless the current request explicitly authorizes a group of actions. Commit
completed setup changes without another confirmation. Push only when authorized.
Do not treat VM maintenance as permission to install providers, copy their
credentials, migrate projects, restart the desktop, or alter the running supervisor.

Connecting the VM adds a separate T3 environment. Existing threads keep their
execution environment. Independently launched terminal agents remain on macOS.

## VM and SSH

The instance is `t3-lab`: native ARM Ubuntu under Lima's `vz` driver.
Check current state with `limactl list t3-lab` before acting. Use
`limactl shell --workdir=/tmp t3-lab` or `ssh lima-t3-lab` for guest commands.
Do not preserve the host environment or introduce host mounts implicitly.

The SSH alias is in `~/.ssh/config`, before general Host rules, and includes
`~/.lima/t3-lab/ssh.config`. The generated include supplies the current SSH port,
guest username and Lima key. Do not edit it; Lima regenerates it.
The key is `~/.lima/_config/user`; do not read, print, or commit its contents.

The alias selects the Mac's 1Password agent and enables `ForwardAgent yes`.
Lima's generated `IdentityFile` and `IdentitiesOnly yes` still select Lima's key for
VM login. Other host SSH entries retain their existing settings. Forwarding exposes
the agent's available keys for signing and authentication subject to 1Password
authorization; private keys remain on the Mac. Changes require the user's instruction.

Automatic startup is configured at user login with
`limactl autostart enable --condition=login t3-lab`, not before login at system
boot. Verify the generated LaunchAgent and distinguish registration from a tested
fresh login. The virtual disk, keys and runtime state remain outside Git.

## T3 runtime alignment and troubleshooting

Use T3 desktop-managed SSH for this environment. The desktop supplies its exact
app version to the remote archive launcher. A subsequent managed launch after a
desktop update selects the matching runtime. Do not start an unrelated manually
managed T3 service that bypasses this version selection.

The native Linux archive does not require Node/npm. The minimal Ubuntu image
needs `libatomic1`; it is included alongside Git in the VM provisioning script.
If T3 reports that its executable does not run on the host, capture the actual
binary error and `ldd` output before retrying. Missing `libatomic.so.1` was the
verified initial failure; do not assume every later failure has that cause.

Verify a connection in T3's Connections screen and confirm the guest's running
runtime version. A server connection does not prove an authenticated provider or
a successful task. Keep pairing credentials and runtime credential files private.

Lima plain mode disables host mounts and dynamic forwarding. It does not implement
the planned network policy or protected-operation gates. Report those separately
from basic VM isolation and successful T3 connection.

## Git

Git is installed in the guest, and its global commit name and email match the Mac's
personal identity. A local test commit verified author and committer values.
Keep identity configuration separate from GitHub authentication and commit signing.
Do not copy the Mac's Git configuration wholesale: its credential helpers and
1Password signing executable refer to host-only facilities. Repository authentication
has not been configured or tested.

Guest Git signing uses `~/.local/bin/git-ssh-sign`, installed from this experiment's
versioned `git-ssh-sign`. It points `SSH_AUTH_SOCK` at the stable guest symlink
`~/.ssh/1password-agent.sock`. A dedicated SSH session maintains that symlink, managed
on the Mac by `io.t3-lab.signing-agent` at user login. Its forwarding script and
LaunchAgent source are versioned alongside the README; error logs stay under
`~/.lima/t3-lab/`. This arrangement supports detached T3 processes without an
inherited agent environment or a T3 restart.

Global `gpg.format=ssh`, `commit.gpgsign=true`, the existing public signing key and
`gpg.ssh.program` configure signing. `~/.ssh/t3-lab-allowed-signers` enables local
verification. A signed guest commit was verified with the usual agent environment
removed. Signing fails if the bridge is unavailable; do not silently disable it.
Inspect the bridge with `launchctl print gui/$(id -u)/io.t3-lab.signing-agent` and
use the README's reconnect command when needed. A fresh login remains untested.

## Provider CLIs

Codex CLI and Claude Code have separate native Linux installations in the guest.
Their installers manage `~/.local/bin/codex` and `~/.local/bin/claude`; guest
`/usr/local/bin` symlinks expose them to the existing server PATH and non-interactive
SSH sessions. Consult the README for installation commands and verified versions.
Inspect existing launchers before changing them; do not overwrite unrelated tools.

No synchronization with the Mac's provider installations is configured. Codex
ChatGPT sign-in was verified on 12 October 2026; Claude Code sign-in and a model
task remain unverified. Check current Codex authentication with guest
`codex login status`, never by printing its credential cache. CLI installation
does not authorize logging in, copying host credentials or starting an agent task.

For an authorized Codex sign-in, run `codex login --device-auth` inside the VM.
The user completes the displayed link and code in their own browser. Device-code
login must be enabled in ChatGPT security settings; if enabled during an attempt,
cancel that attempt before starting a new one. Preserve credentials only in the
guest's authentication storage, outside the versioned setup notes.
