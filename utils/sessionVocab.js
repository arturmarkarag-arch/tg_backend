'use strict';

/**
 * Single source of truth for the OrderingSession lifecycle vocabulary:
 *   • the enum values used by Mongoose / state-machine logic
 *   • the Ukrainian labels shown in the UI
 *   • the chip variant each status maps to in the design system
 *
 * The vocab is echoed in /api/picking/start-session responses so the client
 * never hardcodes the list. Adding a new status / event type here is the ONLY
 * change required end-to-end: schema enum, state transitions, and UI labels
 * all pick it up automatically.
 */

const PICKING_STATUSES = ['pending', 'confirmed', 'in_progress', 'completed'];

const STATUS_VOCAB = {
  pending:     { label: 'Очікує підтвердження', chip: 'chip-warning' },
  confirmed:   { label: 'Підтверджено',          chip: 'chip-active'  },
  in_progress: { label: 'В роботі',              chip: 'chip-active'  },
  completed:   { label: 'Завершено',             chip: 'chip-success' },
};

const EVENT_TYPES = [
  'created',
  'picking_confirmed',
  'picking_cancelled',
  'picking_in_progress',
  'picking_completed',
  'order_added',
  'rescheduled',
  'hours_changed',
  'window_closed',
];

const EVENT_VOCAB = {
  created:             { label: 'Створено'          },
  picking_confirmed:   { label: 'Підтверджено'      },
  picking_cancelled:   { label: 'Старт скасовано'   },
  picking_in_progress: { label: 'В роботі'          },
  picking_completed:   { label: 'Завершено'         },
  order_added:         { label: 'Оновлена'          },
  rescheduled:         { label: 'Перенесена'        },
  hours_changed:       { label: 'Змінені години'    },
  window_closed:       { label: 'Закінчилась'       },
};

// status → event the transition emits. Lives here (not duplicated in the
// state-machine module) so adding a new status is a one-file change.
const LIFECYCLE_EVENT = {
  pending:     'picking_cancelled',
  confirmed:   'picking_confirmed',
  in_progress: 'picking_in_progress',
  completed:   'picking_completed',
};

// ── Session PHASE (derived, never persisted) ─────────────────────────────────
// pickingStatus alone is overloaded: its birth-state `pending` smears across
// FOUR real situations — window not yet relevant, ordering open, ordering closed
// & ready to pick, and "nothing here at all". That is why an empty just-rolled
// session shows "Очікує підтвердження" while the task list says "all done".
//
// `phase` collapses (window state ⊕ pickingStatus ⊕ has-work) into ONE value the
// UI renders directly. It is computed on every request from live inputs the
// backend already has — there is no second stored field that could drift.
const SESSION_PHASES = ['ordering_open', 'awaiting_picking', 'picking', 'completed', 'idle'];

const PHASE_VOCAB = {
  ordering_open:    { label: 'Приймає замовлення', chip: 'chip-active'  },
  awaiting_picking: { label: 'Готово до збирання', chip: 'chip-warning' },
  picking:          { label: 'Збирається',         chip: 'chip-active'  },
  completed:        { label: 'Зібрано',            chip: 'chip-success' },
  idle:             { label: 'Замовлень немає',    chip: 'chip-warning' },
};

/**
 * Collapse the session situation into a single UI phase.
 *
 * @param {object}  p
 * @param {string}  p.pickingStatus  pending|confirmed|in_progress|completed
 * @param {boolean} p.windowOpen     ordering window currently open for the group
 * @param {boolean} p.hasWork        session has real content:
 *                                     - active orders (>0) for non-completed status
 *                                     - built tasks (>0) for completed status
 * @returns {'ordering_open'|'awaiting_picking'|'picking'|'completed'|'idle'}
 */
function deriveSessionPhase({ pickingStatus, windowOpen, hasWork }) {
  if (pickingStatus === 'completed') return hasWork ? 'completed' : 'idle';
  if (pickingStatus === 'confirmed' || pickingStatus === 'in_progress') return 'picking';
  // pending — split by what is actually happening right now.
  if (windowOpen) return 'ordering_open';
  return hasWork ? 'awaiting_picking' : 'idle';
}

/**
 * Build the wire payload sent to clients. Stays small (< 1 KB).
 */
function getSessionVocab() {
  return {
    statuses: STATUS_VOCAB,
    events:   EVENT_VOCAB,
    phases:   PHASE_VOCAB,
  };
}

module.exports = {
  PICKING_STATUSES,
  EVENT_TYPES,
  STATUS_VOCAB,
  EVENT_VOCAB,
  LIFECYCLE_EVENT,
  SESSION_PHASES,
  PHASE_VOCAB,
  deriveSessionPhase,
  getSessionVocab,
};
