# T3 Lab

An experiment to run the T3 server and its agents inside a dedicated Linux VM,
while keeping the T3 desktop interface and independently launched terminal agents
on macOS.

The [V1 architecture plan](architecture-v1.md) records the agreed design and scope.

## Current status

- Lima is installed through the Mac's nix-darwin-managed Homebrew configuration.
- The architecture plan is stored in this repository's experiment folder.
- No VM has been created for this experiment.
- The existing T3 environment and running supervisor have not been changed.
- The experiment documents are tracked in Git; remote publication is pending.

## Next task

Prepare a minimal Lima configuration for a Linux ARM VM named `t3-lab`, using
Apple's native virtualization and a private VM disk without sharing the Mac's
home directory. Review the configuration before creating or starting the VM.

## Working agreement

Describe one concrete step, wait for explicit approval, perform only that step,
and report its result before proposing the next one. Update this status as work
progresses. Installation, VM startup, T3 configuration, commits, and pushes are
separate steps.
