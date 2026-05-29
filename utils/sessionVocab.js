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
  'picking_in_progress',
  'picking_completed',
  'order_added',
  'rescheduled',
  'hours_changed',
  'window_closed',
];

const EVENT_VOCAB = {
  created:             { label: 'Створено'        },
  picking_confirmed:   { label: 'Підтверджено'    },
  picking_in_progress: { label: 'В роботі'        },
  picking_completed:   { label: 'Завершено'       },
  order_added:         { label: 'Оновлена'        },
  rescheduled:         { label: 'Перенесена'      },
  hours_changed:       { label: 'Змінені години'  },
  window_closed:       { label: 'Закінчилась'     },
};

// status → event the transition emits. Lives here (not duplicated in the
// state-machine module) so adding a new status is a one-file change.
const LIFECYCLE_EVENT = {
  confirmed:   'picking_confirmed',
  in_progress: 'picking_in_progress',
  completed:   'picking_completed',
};

/**
 * Build the wire payload sent to clients. Stays small (< 1 KB).
 */
function getSessionVocab() {
  return {
    statuses: STATUS_VOCAB,
    events:   EVENT_VOCAB,
  };
}

module.exports = {
  PICKING_STATUSES,
  EVENT_TYPES,
  STATUS_VOCAB,
  EVENT_VOCAB,
  LIFECYCLE_EVENT,
  getSessionVocab,
};
