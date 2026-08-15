'use strict';

const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

describe('V48.17 live E2E harness isolation', () => {
  it('synthetic closed schedule is guaranteed past the server +60s picking gate', () => {
    const helper = read('scripts/helpers/perGroupTestSchedule.js');
    expect(helper).toContain('startQuartersAgo');
    expect(helper).toContain('closedQuartersAgo');
    expect(helper).toContain('getPickingReadiness(closedSchedule, nowDate).pickingReady');
    expect(helper).toContain('getOpenDateWarsaw(openSchedule, nowDate) !== getOpenDateWarsaw(closedSchedule, nowDate)');
  });

  it('contracts pre-claim synthetic ordering notifications before sellers are created', () => {
    const source = read('scripts/liveOrderPickingE2E.js');
    const seal = source.indexOf('await sealSyntheticOrderingNotification(group._id, openSchedule, world.sessionIds);');
    const sellers = source.indexOf('for (let i = 0; i < sellers; i += 1)');
    expect(seal).toBeGreaterThan(-1);
    expect(sellers).toBeGreaterThan(seal);
    expect(source).toContain('{ $set: { openNotifiedAt: new Date() } }');
  });

  it('MASS pre-claims synthetic ordering notifications before seller fixtures exist', () => {
    const source = read('scripts/liveOrderPickingMassE2E.js');
    const seal = source.indexOf('await sealSyntheticOrderingNotification(world.group._id, openSchedule, world.sessionIds);');
    const users = source.indexOf("users.push({ telegramId: makeTelegramId(i + 1), role: 'seller'");
    expect(seal).toBeGreaterThan(-1);
    expect(users).toBeGreaterThan(seal);
  });

  it('multi-seller start failure records readiness details instead of an empty assertion', () => {
    const source = read('scripts/liveOrderPickingE2E.js');
    expect(source).toContain('pickingNotReady=${Boolean(start.data?.pickingNotReady)}');
    expect(source).toContain("readyAt=${start.data?.pickingReadyAt || ''}");
  });
});
