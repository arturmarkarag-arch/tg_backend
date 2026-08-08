# 2026-08-08 — Telegram contact UX v19

## Changed
- Staff Telegram contact shortcuts no longer rely on `tg://user?id=...` as a private-chat fallback.
- Staff-facing API payloads now resolve a Telegram username from the existing `GroupMember` snapshot in one batched lookup when a contact shortcut is rendered.
- No Telegram username means no misleading "Write" action is exposed.

## Reason
Telegram ID links are Bot API mention abstractions and are not a reliable generic private-chat deep link from a normal browser/Mini App. Public `t.me/<username>` links are used for the contact action instead.
