BaseLinker workflow/state refactor — SERVER
Manual file replacement patch.

Main changes:
- Pure picking state machine moved to domain/baseLinkerPickingState.js.
- Model enums and picking service use the same status/item-state source.
- Completion is independent from ownership: releasing/reopening a fully handled order keeps it ready_to_pack / ready_to_pack_with_issue instead of incorrectly falling back to paused/problem.
- New writes accept only pending/picked/not_found/shortage. damaged/other remain readable for legacy persisted rows.
