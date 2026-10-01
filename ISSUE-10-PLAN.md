# Issue #10 implementation plan

1. Inspect #9's durable session/turn APIs and current Pi controller and tests. Preserve the existing public Pi tool contract, native reporter, and security invariants.
2. Extract tmux ownership, inert startup gate, binding, provenance, liveness, reconciliation and fail-closed cancellation into a generic controller using an adapter interface. Keep agent-specific executable, arguments, environment and completion strategy in adapters; implement Pi as the first adapter. Avoid agent-name branching in the controller.
3. Wire existing Pi tools through the generic controller. Support successive turns on a logical session using #9's model, without concurrent turns; preserve completion delivery and existing records.
4. Add fake-adapter controller tests independent of Pi, Pi-adapter tests for literal task transmission and reporter semantics, and regression tests for reuse/cancellation/ownership.
5. Run typecheck and full tests, inspect security-sensitive diff, create a focused PR referencing #10. Report the PR URL, changed files, test commands/results, and remaining limitations. Do not merge or close the issue; parent will review and decide.
