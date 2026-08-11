# V33 — current-session picking history

Date: 2026-08-11

## Goal
Show an admin who picked each warehouse product position during the current delivery-group session, without creating a second long-lived audit system.

## Source of truth
`PickingTask` remains the only source of truth. The shift board derives history from tasks whose:

- `deliveryGroupId` is the selected group;
- `orderingSessionId` is the group's current `OrderingSession`.

Each history row includes product, block, position, task status, checkbox authors (`items[].packedBy*`), the current lock owner for an active task, and the worker who finalized the task (`completedBy*`).

## Session reset semantics
The history is intentionally session-scoped, exactly like the existing `Зміна` counters. When the selected group moves to a new current `OrderingSession`, the shift-board query uses the new session id and the visible history starts empty. Sessions of other delivery groups are independent.

Old `PickingTask` documents are not physically deleted by this UI reset because they are still used by existing repair/integrity tooling and TTL cleanup. They are never included in the current-session history response.

## UI
`Зміна` now contains a collapsible `Історія збирання` panel showing:

- product name;
- block and position;
- completed/in-progress state;
- every worker represented by final checkbox authorship and their shops;
- current worker for a locked task;
- worker who finalized the position;
- packed count and activity time.
