BaseLinker 14-day history + Cancelled shelf + retention patch
Baseline: server_FULL_SINGLE_ACCOUNT_TRISTATE_20260906
Manual file replacement patch.

Contract:
- Intake: no age limit while BaseLinker keeps the order in Intake.
- Sent: last 14 days by BaseLinker date_in_status.
- Cancelled: dedicated last-14-days shelf by BaseLinker date_in_status.
- BaseLinker raw snapshots: 14-day TTL + daily application purge.
- Terminal/non-actionable picking rows: purge after 14 days only after exact BaseLinker verification.
- Print jobs: existing 7-day TTL unchanged.
- Print Agent registrations: 14-day TTL.
- Retention sweep: at server startup and then daily via existing scheduler leader.
