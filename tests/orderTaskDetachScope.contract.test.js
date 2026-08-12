'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('order -> picking task detach scope contract', () => {
  it('deletes only tasks that contained the detached order, never all empty tasks globally', () => {
    const source = read('routes/orders.js');
    const start = source.indexOf('async function detachOrderFromPendingTasks');
    const end = source.indexOf('async function ensureOrderNotInPickingPipeline', start);
    const body = source.slice(start, end);

    expect(body).toContain('const affectedTasks = await PickingTask.find');
    expect(body).toContain('const affectedTaskIds = affectedTasks.map');
    expect(body).toContain("{ _id: { $in: affectedTaskIds }, status: { $in: ['pending', 'locked'] }, items: { $size: 0 } }");
    expect(body).not.toContain("PickingTask.deleteMany(\n    { status: { $in: ['pending', 'locked'] }, items: { $size: 0 } }");
  });
});
