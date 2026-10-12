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
- No host folders are mounted; explicit SSH forwarding exposes the Mac's 1Password agent.
- Git and `libatomic1` are installed inside the VM and provisioned by the template.
- Git commit identity matches the Mac's personal identity; a local commit was verified.
- Git commit signing uses the Mac's existing 1Password signing key; a signed commit was verified.
- The desktop-managed T3 server is installed and connected over SSH as `lima-t3-lab`.
- Codex CLI and Claude Code are installed in the VM.
- Codex ChatGPT sign-in is verified; Claude Code authentication remains pending.
- Existing chats remain in their original environments; automatic load balancing is off.
- The local T3 server and running supervisor have not been migrated or restarted.
- The initial architecture documents have been published to the repository.

## VM configuration

[lima.yaml](lima.yaml) is the versioned source for the VM configuration. It uses
Apple's native virtualization (`vz`) and a dated Ubuntu image verified by SHA-256.
The image URL and digest come from Lima 2.2.1's official Ubuntu 24.04 template.
If the dated image is retired upstream, update its URL and digest together.

The Lima template uses plain mode and disables host mounts, dynamic port forwarding,
bundled containerd and Lima-managed SSH agent forwarding. A separate host SSH
connection now forwards the 1Password agent for Git signing. Host proxy environment
propagation and importing the Mac's existing SSH public keys remain disabled.
Network egress is available; this setup does not yet implement the architecture's
network policy or gates.

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

## Git commit identity

The guest user's global `user.name` and `user.email` were configured to match the
Mac's effective personal Git identity on 12 October 2026. An empty commit in a
temporary guest repository verified both the author and committer identities.

These are per-user settings, not values embedded in the Lima template. To configure
them on another guest, run Git inside that guest:

```sh
git config --global user.name "<your commit name>"
git config --global user.email "<your commit email>"
```

The initial identity step configured local commits only. Signing was configured
separately as documented below. GitHub authentication has not been set up or tested;
the Mac's credential helpers were not copied into the VM.

## SSH authentication

[ssh-config](ssh-config) records the block placed before general Host rules in
`~/.ssh/config`. It includes Lima's generated `~/.lima/t3-lab/ssh.config`, which
supplies the current loopback SSH port and guest username. Lima regenerates that
included file; do not edit it manually.

The generated include retains Lima's key at `~/.lima/_config/user` and
`IdentitiesOnly yes` for VM login. The host block selects the Mac's 1Password agent
with `IdentityAgent` and enables `ForwardAgent yes` for this alias. Other host
entries are unchanged. Private keys are not stored here.

## Git commit signing through 1Password

On 12 October 2026, forwarding and guest Git signing were configured using the
existing Mac signing key. The private key stays in 1Password; only its public key
and local verification configuration were written into the guest.

The setup has three versioned parts:

- [SSH configuration](ssh-config) enables forwarding for `lima-t3-lab`.
- [Forwarding connection](forward-signing-agent.sh) keeps a dedicated SSH session
  alive and links its guest socket to `~/.ssh/1password-agent.sock`.
- [Git signer](git-ssh-sign) sets `SSH_AUTH_SOCK` to that stable path and invokes
  the guest's `/usr/bin/ssh-keygen`.

T3's already-running server has no forwarded agent environment. The dedicated
session makes signing work for detached processes without restarting T3. It uses
its own SSH connection instead of reusing an older connection created without
forwarding. Ordinary SSH sessions still use the alias's normal settings.

The signer is installed at guest `~/.local/bin/git-ssh-sign`. The guest's global Git
configuration sets `gpg.format=ssh`, `commit.gpgsign=true`, the existing public
`user.signingkey`, and `gpg.ssh.program` to that signer. Local signature verification
uses `gpg.ssh.allowedSignersFile=~/.ssh/t3-lab-allowed-signers`, containing the guest's
commit email and the public signing key. These user-specific values stay outside
the repository.

The host [LaunchAgent](io.t3-lab.signing-agent.plist) is installed as
`~/Library/LaunchAgents/io.t3-lab.signing-agent.plist`. It starts at user login and
retries a failed connection with a ten-second launchd throttle, including when the
VM has not booted yet. Its configured paths refer to this Mac's canonical checkout;
adjust them when setting up another machine. Errors go to
`~/.lima/t3-lab/signing-agent.log`. The job was verified running; a fresh login has
not been tested.

Verification created an empty commit in a temporary guest repository with both
`SSH_AUTH_SOCK` and `SSH_TTY` removed from the command environment. `git verify-commit`
accepted the signature and Git reported status `G`. The fingerprint matched the
Mac's existing signing key. No repository was pushed or cloned.

Forwarding makes the agent's exposed keys usable from the guest subject to
1Password authorization, including for authentication. It is not restricted to
commit signing and does not provide the planned protected-operation gates. Signing
depends on the dedicated SSH session, a running VM and an available Mac agent.
If that connection is unavailable, signed commits fail rather than falling back
to unsigned commits. See the official
[1Password forwarding documentation](https://www.1password.dev/ssh/agent/forwarding).

To inspect or reconnect the dedicated session from the Mac:

```sh
launchctl print "gui/$(id -u)/io.t3-lab.signing-agent"
launchctl kickstart -k "gui/$(id -u)/io.t3-lab.signing-agent"
```

The LaunchAgent source, forwarding script and signer are part of this experiment;
the Lima creation template does not provision this signing setup automatically.

To reproduce it on a fresh setup, first install the SSH block above. Then run
these commands from the Mac's repository root, after configuring guest Git identity:

```sh
scp experiments/t3-lab/git-ssh-sign lima-t3-lab:.local/bin/git-ssh-sign
git config --global --get user.signingkey | ssh lima-t3-lab '
  set -eu
  IFS= read -r task_signing_public_key
  chmod 0755 "$HOME/.local/bin/git-ssh-sign"
  git config --global gpg.format ssh
  git config --global commit.gpgsign true
  git config --global user.signingkey "$task_signing_public_key"
  git config --global gpg.ssh.program "$HOME/.local/bin/git-ssh-sign"
  printf "%s %s\n" "$(git config --global user.email)" "$task_signing_public_key" \
    > "$HOME/.ssh/t3-lab-allowed-signers"
  chmod 0600 "$HOME/.ssh/t3-lab-allowed-signers"
  git config --global gpg.ssh.allowedSignersFile "$HOME/.ssh/t3-lab-allowed-signers"
'
cp experiments/t3-lab/io.t3-lab.signing-agent.plist \
  "$HOME/Library/LaunchAgents/io.t3-lab.signing-agent.plist"
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/io.t3-lab.signing-agent.plist"
```

The forwarded agent becomes available once the dedicated session connects.
To stop that session, use `launchctl bootout "gui/$(id -u)/io.t3-lab.signing-agent"`.
This does not alter the alias's forwarding setting or prevent the installed
LaunchAgent from starting again at the next login.

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
Both also ran with a minimal PATH of `/usr/local/bin:/usr/bin:/bin`. During
installation, no provider login, host credential transfer or model task was performed.

## Codex authentication

Codex was authenticated inside the VM on 12 October 2026 using ChatGPT device-code
sign-in. The login completed successfully, and a separate guest
`codex login status` check returned `Logged in using ChatGPT`.

For an authorized sign-in, run this from the Mac:

```sh
ssh lima-t3-lab 'codex login --device-auth'
```

Complete the link and one-time code shown by the CLI in your Mac's browser. Device
code sign-in must be enabled in ChatGPT security settings before starting the flow.
If you enable it after an attempt has started, cancel that attempt and start again.
Verify the result with `ssh lima-t3-lab 'codex login status'`. See the official
[authentication guide](https://learn.chatgpt.com/docs/auth).

No host credential cache was copied. Keep authentication data outside the
repository and do not print it. Claude Code sign-in and a model task remain pending.

## Global operating skill

The maintained [skill source](skill/SKILL.md) is versioned in this folder.
`~/.agents/skills/t3-lab` is a symlink to that source directory, making it available
globally without duplicating its instructions. Keep the skill and this setup note
aligned when the environment changes.

## Verified setup

The initial boot completed and guest commands confirmed `Linux aarch64`,
Ubuntu 24.04, 4 CPUs, and the configured memory and disk. No `virtiofs`, `9p`, or
SSHFS host mounts were present; the Mac's home path and an SSH agent socket were
absent at that initial check. Agent forwarding was later enabled explicitly for
commit signing. Cloud-init completed successfully. T3 was absent at initial boot and was
subsequently installed by the desktop's managed SSH connection.
Git installation was subsequently verified with `git --version` (2.43.0).
The T3 native binary's version was checked after installing `libatomic1`, and the
desktop Connections screen showed `lima-t3-lab` as Connected. Codex authentication
was subsequently verified separately; a successful model task remains untested.

## Next task

Authenticate Claude Code, or verify a disposable Codex task executes inside the VM.
Either next step requires approval.

## Working agreement

Describe one concrete setup step, wait for explicit approval, perform only that
step, and report its result before proposing the next one. Update this status as
work progresses and commit completed changes without requesting separate approval.
Installation, VM startup, T3 configuration, and pushes remain separately approved
actions unless explicitly authorized together.
