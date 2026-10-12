# T3 Lab

An experiment to run the T3 server and its agents inside a dedicated Linux VM,
while keeping the T3 desktop interface and independently launched terminal agents
on macOS.

The [V1 architecture plan](architecture-v1.md) records the agreed design and scope.

## Current status

- Lima is installed through the Mac's nix-darwin-managed Homebrew configuration.
- The architecture plan is stored in this repository's experiment folder.
- `t3-lab` was created and booted with Lima 2.2.1 on 12 October 2026.
- The VM runs Ubuntu 24.04 ARM with 4 CPUs, 8 GiB RAM, and a 60 GiB virtual disk.
- No host folders are mounted, and SSH agent forwarding is disabled.
- Git and `libatomic1` are installed inside the VM and provisioned by the template.
- The desktop-managed T3 server is installed and connected over SSH as `lima-t3-lab`.
- Codex CLI and Claude Code are installed in the VM; provider authentication remains pending.
- Existing chats remain in their original environments; automatic load balancing is off.
- The local T3 server and running supervisor have not been migrated or restarted.
- The initial architecture documents have been published to the repository.

## VM configuration

[lima.yaml](lima.yaml) is the versioned source for the VM configuration. It uses
Apple's native virtualization (`vz`) and a dated Ubuntu image verified by SHA-256.
The image URL and digest come from Lima 2.2.1's official Ubuntu 24.04 template.
If the dated image is retired upstream, update its URL and digest together.

Lima plain mode disables host mounts, dynamic port forwarding, bundled containerd,
and SSH agent forwarding. Host proxy environment propagation and importing the
Mac's existing SSH public keys are also disabled. Network egress is available;
this setup does not yet implement the architecture's network policy or gates.

The VM disk, generated SSH keys, runtime state, and logs stay under Lima's local
data directory, outside this repository. Automatic startup at Mac user login is
enabled through Lima; it does not start at system boot before login. The generated
LaunchAgent file was verified, but a fresh login has not yet been tested.

Run these commands from the repository root:

```sh
# create the VM on a machine where it does not already exist
limactl validate experiments/t3-lab/lima.yaml
limactl create --name=t3-lab --yes experiments/t3-lab/lima.yaml

# start an existing VM and enter it without forwarding the host environment
limactl start --yes t3-lab
limactl shell --workdir=/tmp t3-lab

# enable automatic startup at user login on this Mac
limactl autostart enable --condition=login t3-lab

# inspect or stop the VM
limactl list t3-lab
limactl stop t3-lab
```

Changing the repository YAML does not automatically update an existing instance.
Inspect and apply changes deliberately; do not delete the VM to reapply settings
without first accounting for its data.

## SSH authentication

[ssh-config](ssh-config) records the block placed before general Host rules in
`~/.ssh/config`. It includes Lima's generated `~/.lima/t3-lab/ssh.config`, which
supplies the current loopback SSH port and guest username. Lima regenerates that
included file; do not edit it manually.

This connection uses Lima's generated key at `~/.lima/_config/user`.
`IdentityAgent none` disables the host's 1Password SSH agent for this alias only;
other SSH entries keep their existing agent settings. `ForwardAgent no` separately
prevents forwarding an agent socket into the VM. Private keys are not stored here.

## T3 connection and version alignment

In the desktop application, the connection was added through Settings →
Connections → Add environment → SSH, using `lima-t3-lab` and the defaults from
the SSH alias. The desktop downloads and runs its exact app version in the guest's
`~/.t3/runtime/versions/` directory. This setup uses the managed SSH launcher,
without a separately installed T3 background service.

After a desktop update, the next managed SSH launch selects the matching server
archive. Existing conversations remain on their original environment. A new task
must explicitly target the VM; automatic load balancing is currently off.

The initial native binary failed with a missing `libatomic.so.1` error on the
minimal Ubuntu image. Installing `libatomic1` fixed the verified binary failure;
the creation template now includes it. The connected server initially matched
desktop version `0.0.46-nightly.20261011.2994`.

## Provider CLI installation

Codex CLI and Claude Code were installed separately inside the VM on 12 October
2026 using their official native Linux installers. The verified versions were
Codex CLI `0.162.1` and Claude Code `2.1.296`. These installations are independent
of the Mac's installations; no version synchronization has been configured.

The native installers manage each command under the guest user's `~/.local/bin`.
Symlinks in `/usr/local/bin` make them available to non-interactive SSH sessions
and processes whose existing PATH does not include `~/.local/bin`. The Lima
creation template does not install providers automatically.

To repeat the installation on a fresh VM, enter the guest first:

```sh
ssh lima-t3-lab

# install as the guest user, not as root
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
curl -fsSL https://claude.ai/install.sh | bash

# expose the user-managed launchers through the existing server PATH
sudo ln -s "$HOME/.local/bin/codex" /usr/local/bin/codex
sudo ln -s "$HOME/.local/bin/claude" /usr/local/bin/claude

codex --version
claude --version
```

For existing installations, inspect the launchers before creating symlinks;
do not overwrite unrelated commands. The installers select their current releases,
so repeating these commands later may install different versions. See the official
[Codex installation guide](https://learn.chatgpt.com/docs/codex/cli) and
[Claude Code installation guide](https://code.claude.com/docs/en/setup).

Both commands passed version and help checks, including `codex app-server --help`.
Both also ran with a minimal PATH of `/usr/local/bin:/usr/bin:/bin`. No provider
login, host credential transfer or model task was performed.

## Global operating skill

The maintained [skill source](skill/SKILL.md) is versioned in this folder.
`~/.agents/skills/t3-lab` is a symlink to that source directory, making it available
globally without duplicating its instructions. Keep the skill and this setup note
aligned when the environment changes.

## Verified setup

The initial boot completed and guest commands confirmed `Linux aarch64`,
Ubuntu 24.04, 4 CPUs, and the configured memory and disk. No `virtiofs`, `9p`, or
SSHFS host mounts were present; the Mac's home path and an SSH agent socket were
absent. Cloud-init completed successfully. T3 was absent at initial boot and was
subsequently installed by the desktop's managed SSH connection.
Git installation was subsequently verified with `git --version` (2.43.0).
The T3 native binary's version was checked after installing `libatomic1`, and the
desktop Connections screen showed `lima-t3-lab` as Connected. This does not yet
prove provider authentication or a successful task inside the VM.

## Next task

Authenticate one installed provider inside the VM, then verify a disposable task
executes there. Authentication and running that task require approval.

## Working agreement

Describe one concrete setup step, wait for explicit approval, perform only that
step, and report its result before proposing the next one. Update this status as
work progresses and commit completed changes without requesting separate approval.
Installation, VM startup, T3 configuration, and pushes remain separately approved
actions unless explicitly authorized together.
