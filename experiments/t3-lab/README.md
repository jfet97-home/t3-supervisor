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
- Git is installed inside the VM; the creation template provisions it too.
- T3 and provider CLIs have not been installed or connected inside the VM.
- The existing T3 environment and running supervisor have not been changed.
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

## Verified setup

The initial boot completed and guest commands confirmed `Linux aarch64`,
Ubuntu 24.04, 4 CPUs, and the configured memory and disk. No `virtiofs`, `9p`, or
SSHFS host mounts were present; the Mac's home path and an SSH agent socket were
absent. Cloud-init completed successfully, and no `t3` executable was installed.
Git installation was subsequently verified with `git --version` (2.43.0).

## Next task

Review how to install and authenticate the T3 server inside this VM. Installing
or connecting T3 requires a separate approved step.

## Working agreement

Describe one concrete setup step, wait for explicit approval, perform only that
step, and report its result before proposing the next one. Update this status as
work progresses and commit completed changes without requesting separate approval.
Installation, VM startup, T3 configuration, and pushes remain separately approved
actions unless explicitly authorized together.
