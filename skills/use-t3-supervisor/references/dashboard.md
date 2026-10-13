# Dashboard workflows

The dashboard has Rules, Activity, Recaps and Telegram, and Settings views.
Use its current labels and saved state rather than assuming an older screenshot.

## Rules and scope

In Rules, select Global rules, No-project chats, or a synchronized T3 project under
Show rules for. Use the actual selected project identity; similar titles do not
establish that two projects are the same. Ambiguous projects can require explicit
classification. Do not classify one as no-project simply to make a rule eligible.

Choose New rule or open an existing rule. Provide its name, condition, exact message
and mode. A useful condition describes something observable in the current task:

- Condition: The agent announces that it will mark a pull request ready for review.
- Guidance: Before marking the PR ready, complete the project's required checks and review.

This reminder cannot prove that checks are missing or prevent the operation. The
detector sees a bounded window of public main-run activity and command inputs,
not every prior action, child-agent output or private reasoning.

Use Test without sending and Evaluate example to try a clear match, a non-match and
an ambiguous case. Results can be match, no_match or needs_context. Do not convert
missing evidence into a claim that the agent violated a rule.

Save the rule and read back its text, scope and mode. Editing the condition or
message of a sending rule returns it to Observe only. A stale-tab conflict requires
a fresh read and reconciliation of the user's intended edit, not an overwrite of
newer settings. Global rules can be muted for individual scopes.

## Delivery and monitoring settings

Settings shows connection state, coverage, last cycle, sending readiness and budget.
Observe only evaluates; Paused stops that rule; Send guidance permits delivery when
the installation and owner settings allow it.

The Allow the documented delivery race setting acknowledges that T3 may start a
follow-up turn if the active turn finishes during delivery. It is tied to the
observed T3 build and may need acceptance again after a build change. Enable this
only within the user's authorization for guidance delivery.

Pause guidance stops guidance delivery while observation and any enabled Telegram recaps and questionnaires
continue. Pause monitoring stops evaluations and their model cost. Save changes and
verify the resulting state. Daily reserved token budget is a reservation estimate,
not billed usage or an exact cap on every provider token.

## Activity and notification history

Open a relevant Activity item to inspect its reason, thread, rule, run and retained
details. Use Open originating chat when the exact thread is needed. Evidence can
expire; report unavailable details instead of reconstructing them as facts.

Accepted dispatch and visible guidance are distinct outcomes. An uncertain notice
is frozen instead of automatically resent. Inspect the existing evidence before
considering Accept uncertainty; that action changes future eligibility and requires
the owner's acceptance of possible duplicate effects. It does not prove delivery.

Reset episode can allow a future notification for the same rule/thread. Use it when
the user wants a resolved situation rearmed, not as an uncertain-send retry.
This was wrong records feedback; it does not change the rule. Pausing, editing and
resuming establish new activation watermarks rather than replaying old activity.

Recaps and Telegram displays notification, questionnaire and reply-cleanup records
without performing recovery writes. Complete native questionnaires through their
existing T3 interface or the configured Telegram questionnaire card. Ordinary chat
messages and guidance are not substitutes for structured questionnaire answers.

## Persisted chat policy

Use Settings → Chat settings to choose excluded chats and the interactive Telegram
chat. Changes apply without a restart and persist in `/data/thread-settings.sqlite3`
in the instance state volume. Mac and Lima have independent policies. Legacy chat
environment variables seed the database only once and are removed from active Compose.
The interactive selection overrides exclusions for questionnaires only. Expired,
unconfirmed questionnaire deletions remain explicit in Recaps and Telegram history
without permanently degrading readiness; do not retry them or label them deleted.
