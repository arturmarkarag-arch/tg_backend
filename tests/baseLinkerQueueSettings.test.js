const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

function harness(initialValue = null) {
  let value = initialValue;
  const write = vi.fn(async (_, update) => { value = update.$set.value; });
  const api = vi.fn(async () => ({ statuses: [
    { id: 99, name: 'Do opakowania' },
    { id: 100, name: 'Wysłano' },
    { id: 101, name: 'Anulowane' },
    { id: 102, name: 'Inny status' },
  ] }));
  function load() {
    const filename = path.join(__dirname, '../services/baseLinkerQueueScope.js');
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const mocks = {
      '../models/AppSetting': {
        findOne: () => ({ lean: async () => value ? { value } : null }),
        findOneAndUpdate: write,
      },
      './baseLinkerClient': { callBaseLinker: api },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, process, Date, require: (id) => mocks[id] || realRequire(id),
    });
    return module.exports;
  }
  return { load, api, write, value: () => value };
}

describe('BaseLinker queue settings storage', () => {
  it('keeps the former single status only as intake fallback and requires sent + cancelled explicitly', async () => {
    const h = harness({ statusId: 99, statusName: 'Do opakowania' });
    expect(await h.load().getQueueScope()).toMatchObject({
      configured: false,
      intakeStatusId: 99,
      intakeStatusName: 'Do opakowania',
      sentStatusId: null,
      cancelledStatusId: null,
      sentLookbackDays: 14,
    });
  });

  it('persists three distinct upstream statuses and fixes Sent/Cancelled retention to 14 days', async () => {
    const h = harness();
    const saved = await h.load().saveQueueSettings({
      intakeStatusId: 99,
      sentStatusId: 100,
      cancelledStatusId: 101,
    });
    expect(saved).toMatchObject({
      configured: true,
      intakeStatusId: 99,
      intakeStatusName: 'Do opakowania',
      sentStatusId: 100,
      sentStatusName: 'Wysłano',
      cancelledStatusId: 101,
      cancelledStatusName: 'Anulowane',
      sentLookbackDays: 14,
    });
    expect(saved.sentDateInStatusFrom).toBeGreaterThan(0);
    expect(saved.cancelledDateInStatusFrom).toBeGreaterThan(0);
    expect(saved.cancelledLookbackDays).toBe(14);
    expect(h.api).toHaveBeenCalledWith('getOrderStatusList', {});
    expect(h.value()).toMatchObject({ intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101 });
  });

  it('rejects missing, duplicate and unknown status ids before persistence', async () => {
    const invalid = [
      {},
      { intakeStatusId: 99, sentStatusId: 100 },
      { intakeStatusId: 99, sentStatusId: 99, cancelledStatusId: 101 },
      { intakeStatusId: 0, sentStatusId: 100, cancelledStatusId: 101 },
      { intakeStatusId: true, sentStatusId: 100, cancelledStatusId: 101 },
      { intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 777 },
    ];
    for (const values of invalid) {
      const h = harness();
      await expect(h.load().saveQueueSettings(values)).rejects.toMatchObject({ status: 400 });
      expect(h.write).not.toHaveBeenCalled();
    }
  });

  it('changes scopeKey on every saved configuration revision', async () => {
    const h = harness();
    const first = await h.load().saveQueueSettings({ intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101 });
    const second = await h.load().saveQueueSettings({ intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101 });
    expect(second.scopeKey).not.toBe(first.scopeKey);
  });

  it('preserves the last persisted settings if BaseLinker status lookup fails', async () => {
    const h = harness();
    await h.load().saveQueueSettings({ intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101 });
    h.api.mockRejectedValue(new Error('offline'));
    await expect(h.load().saveQueueSettings({ intakeStatusId: 102, sentStatusId: 100, cancelledStatusId: 101 })).rejects.toThrow('offline');
    expect(await h.load().getQueueScope()).toMatchObject({ intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101 });
  });
});
