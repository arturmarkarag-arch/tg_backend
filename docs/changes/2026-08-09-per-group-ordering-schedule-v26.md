# v26 — independent delivery day and session close day

## Business contract

Each DeliveryGroup now owns three independent weekly points:

- physical delivery weekday: `DeliveryGroup.dayOfWeek`;
- ordering session start: `orderingSchedule.startDay/startHour/startMinute`;
- ordering session close: `orderingSchedule.endDay/endHour/endMinute`.

Minutes remain restricted to `00/15/30/45`. UI weekday lists remain Monday -> Sunday while internal JS numbering stays `0=Sunday ... 6=Saturday`.

## Session safety

`orderingSchedule.endDay` is no longer rewritten from `dayOfWeek` anywhere in runtime, model validation, startup preflight, or migration.

A delivery day is assigned to the same weekly session only if it occurs after the session closes and before the next weekly session start. This keeps the existing single-current-session identity unambiguous.

Example valid configuration:

- start: Tuesday 10:15
- close: Thursday 09:45
- delivery: Monday

The concrete delivery for a session starting Tuesday 11.08.2026 is Monday 17.08.2026.

Example rejected configuration:

- start: Friday 18:00
- close: Monday 07:30
- delivery: Sunday

That Sunday would occur after the next Friday session has already started, so it cannot safely belong to the previous session in the current architecture.

## Migration

The one-time legacy migration still reproduces old behavior for groups that have no individual schedule. Existing valid schedules are never rewritten merely because `endDay != dayOfWeek`.

## Tests added/updated

- independent delivery/close weekday contract;
- Monday-first UI order;
- quarter-minute validation;
- delivery-date calculation anchored after close;
- invalid delivery crossing into next weekly session rejected;
- startup preflight accepts `endDay != dayOfWeek`;
- Mongoose model preserves independent `endDay`;
- migration does not repair a valid independent `endDay`.
