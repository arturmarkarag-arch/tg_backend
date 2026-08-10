# Picking manual release — 2026-08-10

- stale worker lock timeout: 15 min → 5 min;
- added `POST /api/picking/tasks/:taskId/release`;
- release is owner-only and CAS-protected;
- final `packedOrderIds` snapshot is persisted atomically with unlock;
- task returns to `pending`, `lockedBy/lockedAt` are cleared;
- partial progress is preserved;
- socket event `picking_task_released` is emitted for live queue refresh.

The 3-minute force-claim guard is intentionally unchanged.
