'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { indexOrThrow } = require('./helpers/sourceContract');

describe('14-day operational history retention contract', () => {
  it('owns one shared 14-day duration', () => {
    const policy = read('utils/retentionPolicy.js');
    expect(policy).toContain('OPERATIONAL_HISTORY_RETENTION_DAYS = 14');
  });

  it('expires catalog review and Telegram publication history after 14 days', () => {
    const reviews = read('models/CatalogReview.js');
    const publications = read('models/TelegramPublicationEvent.js');
    expect(reviews).toContain('expireAfterSeconds: OPERATIONAL_HISTORY_RETENTION_SECONDS');
    expect(publications).toContain('expireAfterSeconds: OPERATIONAL_HISTORY_RETENTION_SECONDS');
  });

  it('stamps and sweeps completed picking tasks on the shared horizon', () => {
    const picking = read('services/pickingService.js');
    const archive = read('services/archiveProductPrimitives.js');
    const retention = read('services/retention.js');
    expect(picking).toContain('COMPLETED_TTL_MS     = OPERATIONAL_HISTORY_RETENTION_MS');
    expect(archive).toContain('now.getTime() + OPERATIONAL_HISTORY_RETENTION_MS');
    expect(retention).toContain('COMPLETED_PICKING_RETENTION_DAYS = OPERATIONAL_HISTORY_RETENTION_DAYS');
  });

  it('purges only completed Telegram events and removes child deliveries first', () => {
    const retention = read('services/retention.js');
    const deliveryDelete = indexOrThrow(retention, 'TelegramNotificationDelivery.deleteMany', { label: 'Telegram delivery delete' });
    const eventDelete = indexOrThrow(retention, 'TelegramNotificationEvent.deleteMany', { from: deliveryDelete, label: 'Telegram event delete' });
    expect(retention).toContain("status: 'completed'");
    expect(retention).toContain('completedAt: { $lt: cutoff }');
    expect(eventDelete).toBeGreaterThan(deliveryDelete);
    expect(retention).toContain('await purgeOldTelegramDeliveryLedger()');
  });
});
