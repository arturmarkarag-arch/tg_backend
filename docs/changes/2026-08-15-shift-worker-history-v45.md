# V45 — Shift workers + expandable task history

V44 incorrectly replaced the familiar warehouse worker roster with one global task-history list.

V45 restores the worker roster and makes history a disclosure under each worker:

- worker row stays visible as before;
- chevron expands that worker only;
- first 25 tasks of the current OrderingSession are fetched lazily;
- «Показати ще +» loads another 25;
- every task row has the product thumbnail, block/position, state, participation and time;
- the 15-second `/shift-board` poll no longer transfers the whole task history;
- workers who only authored partial checkmarks are also kept in the roster, even if another worker later completed the task.
