# Intent guidance implementation and rollout

## Reviewed source

Remote Omegent Opus 5.5 with xhigh effort and Astra 6 with xhigh reasoning independently
returned APPROVE SOURCE in the final bounded implementation round on 9 October 2026.
Their approval covers source; neither claims live message delivery or instruction compliance.
The final source passes 201 tests with zero skips, lint and backend/frontend type checks,
Vite build and the Linux Docker build. Real isolated Luna decisions and T3 read probes
passed. Native Chrome automation verified login, rule save, draft preservation and navigation.

## Installed service

The reviewed image is installed as `t3-supervisor:0.1.0`, manifest
`sha256:ae79ca008e0523bc8197a016e81cd360ec4c89c59bd680711d884c54569a2ed1`.
The service restarted at 2026-10-09T18:59:17.896Z. Health and the UI pass; unauthenticated
API reads return 401. An authenticated owner snapshot reports six synchronized projects,
zero configured rules and 46 existing history rows. Original activation, 98 completion
identities, 44 sent records and all input/cleanup ledgers remain intact. No input uncertainty
or pending cleanup was introduced. The private volume was backed up before replacement.
Rollback image: `t3-supervisor:before-intent-guidance-20261009`.

A dedicated native credential was issued using T3's supported local auth CLI, with only
orchestration read/operate scopes, a one-year expiry and mode 0600 private storage.
The native writer WebSocket handshake authenticated; no dispatch command was sent.
The previous questionnaire credential was neither reused nor replaced. T3 source and
Scanner were not modified.

## Remaining limits

Delivery is disabled until the owner accepts the documented native follow-up race in
Settings and selects Send on a rule. No live guidance send was attempted. The monitor
is advisory: semantic matches can be wrong or missed, and message delivery cannot force
compliance. Token reservations estimate usage rather than cap provider reasoning costs.
The installed native dispatcher may start a follow-up if the target run ends during dispatch.
See [guidance setup and behavior](guidance.md) for login, controls and reconciliation.
