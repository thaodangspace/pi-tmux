# Issue #9 implementation plan

1. Inspect existing durable job registry, reporter, delivery, controller, and tests; preserve existing Pi API behavior.
2. Add durable session and turn records with independent state transitions, ownership checks, stable tmux/server binding, agent-native session ID, bounded atomic persistence and strict validation. Choose explicit V1 migration or compatibility reader; preserve pending completion acknowledgements.
3. Enforce single active turn per session, immutable terminal turns, idle session after terminal turn, and lost reconciliation scoped to owner; avoid storing prompt/transcript/pane output.
4. Wire existing Pi workflows to the model where appropriate without regressing their public contract. Add tests for migration, concurrent turns, A→B reuse, isolation, reconciliation, terminal immutability, corrupt state and bounds.
5. Run typecheck and full tests; inspect diff, commit, push branch and open PR referencing #9. Report test exit codes, PR URL, decisions and limitations. Do not merge or close the issue; parent will review.
