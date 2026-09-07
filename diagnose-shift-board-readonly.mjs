#!/usr/bin/env node

import mongoose from 'mongoose';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GROUP_ID = String(process.argv[2] || '').trim();
const URI = String(process.env.MONGO_URI_READONLY || process.env.MONGO_URI || '').trim();

if (!GROUP_ID) {
  console.error('Usage: node diagnose-shift-board-readonly.mjs <deliveryGroupId>');
  process.exit(2);
}

if (!URI) {
  console.error('Немає MONGO_URI_READONLY або MONGO_URI');
  process.exit(2);
}

const {
  getOpenDateWarsaw,
  normalizeOrderingSchedule,
} = require(path.join(__dirname, 'utils', 'orderingSchedule.js'));

function idVariants(value) {
  const s = String(value || '');
  if (!s) return [];

  return mongoose.isValidObjectId(s)
    ? [s, new mongoose.Types.ObjectId(s)]
    : [s];
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function safe(value) {
  return JSON.parse(JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && val._bsontype === 'ObjectId') {
      return String(val);
    }
    return val;
  }));
}

async function main() {
  const conn = mongoose.createConnection(URI, {
    autoIndex: false,
    readPreference: 'primaryPreferred',
    readConcern: { level: 'majority' },
    serverSelectionTimeoutMS: 10000,
  });

  await conn.asPromise();

  const db = conn.db;

  const collections = await db
    .listCollections({}, { nameOnly: true })
    .toArray();

  const existing = collections.map((row) => row.name);
  const normalized = new Map(
    existing.map((name) => [normalizeName(name), name]),
  );

  function pick(...candidates) {
    for (const candidate of candidates) {
      if (existing.includes(candidate)) return candidate;

      const found = normalized.get(normalizeName(candidate));
      if (found) return found;
    }

    return null;
  }

  const names = {
    deliveryGroups: pick('deliverygroups', 'deliveryGroups'),
    orderingSessions: pick('orderingsessions', 'orderingSessions'),
    orders: pick('orders'),
    pickingTasks: pick('pickingtasks', 'pickingTasks'),
    catalogReviews: pick('catalogreviews', 'catalogReviews'),
  };

  const DeliveryGroups = db.collection(names.deliveryGroups);
  const OrderingSessions = db.collection(names.orderingSessions);
  const Orders = db.collection(names.orders);
  const PickingTasks = db.collection(names.pickingTasks);

  const groupIdVariants = idVariants(GROUP_ID);

  const group = await DeliveryGroups.findOne(
    {
      _id: {
        $in: groupIdVariants,
      },
    },
    {
      projection: {
        name: 1,
        dayOfWeek: 1,
        orderingSchedule: 1,
        isActive: 1,
      },
    },
  );

  if (!group) {
    console.log(JSON.stringify({
      error: 'DeliveryGroup not found',
      deliveryGroupId: GROUP_ID,
    }, null, 2));

    await conn.close();
    return;
  }

  const schedule = normalizeOrderingSchedule(group.orderingSchedule);
  const expectedOpenDate = getOpenDateWarsaw(schedule);

  const currentSession = await OrderingSessions.findOne(
    {
      groupId: GROUP_ID,
      openDate: expectedOpenDate,
    },
    {
      projection: {
        groupId: 1,
        openDate: 1,
        openAt: 1,
        closeAt: 1,
        pickingStatus: 1,
        pickingConfirmedAt: 1,
        pickingStartedAt: 1,
        pickingCompletedAt: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  );

  const sessions = await OrderingSessions.find(
    {
      groupId: GROUP_ID,
    },
    {
      projection: {
        groupId: 1,
        openDate: 1,
        pickingStatus: 1,
        pickingConfirmedAt: 1,
        pickingStartedAt: 1,
        pickingCompletedAt: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  )
    .sort({
      openDate: -1,
      createdAt: -1,
    })
    .limit(15)
    .toArray();

  const report = {
    deliveryGroup: safe(group),

    resolver: {
      expectedOpenDate,
      currentSession: safe(currentSession),
    },

    sessionsForGroup: safe(sessions),

    currentSessionData: null,

    groupDistributions: {
      orders: [],
      pickingTasks: [],
    },
  };

  if (currentSession) {
    const sessionId = String(currentSession._id);
    const sessionVariants = idVariants(sessionId);

    const activeStatuses = ['new', 'in_progress'];

    const orderSummary = await Orders.aggregate([
      {
        $match: {
          orderingSessionId: {
            $in: sessionVariants,
          },
          status: {
            $in: activeStatuses,
          },
        },
      },

      {
        $project: {
          itemCount: {
            $size: {
              $ifNull: ['$items', []],
            },
          },
        },
      },

      {
        $group: {
          _id: null,
          orders: {
            $sum: 1,
          },
          positions: {
            $sum: '$itemCount',
          },
        },
      },
    ]).toArray();

    const uniqueProducts = await Orders.aggregate([
      {
        $match: {
          orderingSessionId: {
            $in: sessionVariants,
          },
          status: {
            $in: activeStatuses,
          },
        },
      },

      {
        $unwind: '$items',
      },

      {
        $match: {
          'items.productId': {
            $ne: null,
          },
        },
      },

      {
        $group: {
          _id: '$items.productId',
        },
      },

      {
        $count: 'count',
      },
    ]).toArray();

    const pickingTasks = await PickingTasks.aggregate([
      {
        $match: {
          orderingSessionId: {
            $in: sessionVariants,
          },
        },
      },

      {
        $project: {
          status: 1,

          itemCount: {
            $size: {
              $ifNull: ['$items', []],
            },
          },
        },
      },

      {
        $group: {
          _id: '$status',
          tasks: {
            $sum: 1,
          },
          items: {
            $sum: '$itemCount',
          },
        },
      },
    ]).toArray();

    report.currentSessionData = {
      orderingSessionId: sessionId,

      pickingStatus: currentSession.pickingStatus,

      activeOrders: {
        count: orderSummary[0]?.orders || 0,
        positions: orderSummary[0]?.positions || 0,
        uniqueProducts: uniqueProducts[0]?.count || 0,
      },

      pickingTasks: safe(
        pickingTasks.map((row) => ({
          status: row._id,
          tasks: row.tasks,
          items: row.items,
        })),
      ),
    };
  }

  report.groupDistributions.orders = safe(
    await Orders.aggregate([
      {
        $match: {
          $or: [
            {
              'buyerSnapshot.deliveryGroupId': {
                $in: groupIdVariants,
              },
            },
            {
              deliveryGroupId: {
                $in: groupIdVariants,
              },
            },
          ],
        },
      },

      {
        $project: {
          orderingSessionId: 1,
          status: 1,

          itemCount: {
            $size: {
              $ifNull: ['$items', []],
            },
          },
        },
      },

      {
        $group: {
          _id: {
            orderingSessionId: '$orderingSessionId',
            status: '$status',
          },

          orders: {
            $sum: 1,
          },

          positions: {
            $sum: '$itemCount',
          },
        },
      },

      {
        $sort: {
          orders: -1,
        },
      },
    ]).toArray(),
  );

  report.groupDistributions.pickingTasks = safe(
    await PickingTasks.aggregate([
      {
        $match: {
          deliveryGroupId: {
            $in: groupIdVariants,
          },
        },
      },

      {
        $project: {
          orderingSessionId: 1,
          status: 1,

          itemCount: {
            $size: {
              $ifNull: ['$items', []],
            },
          },
        },
      },

      {
        $group: {
          _id: {
            orderingSessionId: '$orderingSessionId',
            status: '$status',
          },

          tasks: {
            $sum: 1,
          },

          items: {
            $sum: '$itemCount',
          },
        },
      },

      {
        $sort: {
          tasks: -1,
        },
      },
    ]).toArray(),
  );

  console.log(JSON.stringify(report, null, 2));

  await conn.close();
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});