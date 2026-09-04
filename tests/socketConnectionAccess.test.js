const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const access = require('../utils/baseLinkerAccess');

function createHarness(user) {
  let middleware;
  let onConnection;
  const dependencies = {
    'socket.io': { Server: class {
      use(fn) { middleware = fn; }
      on(event, fn) { if (event === 'connection') onConnection = fn; }
    } },
    './models/Block': {},
    './services/blockMoveCommand': {},
    './models/User': { findOne: () => ({ lean: async () => user }) },
    './utils/userAccountState': { isRemovedUser: () => false },
    './utils/validateTelegramInitData': { validateTelegramInitData: () => ({ valid: true }) },
    './utils/jwt': {},
    './utils/redis': { isEnabled: () => false },
    './utils/baseLinkerAccess': access,
    '@socket.io/redis-adapter': {},
    './utils/corsOptions': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../socket.js'), 'utf8'), {
    module, setTimeout, clearTimeout, URLSearchParams, process: { env: {} },
    require(name) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: 'socket.js' });
  module.exports.initSocket({});
  const socket = {
    handshake: { auth: {
      initData: new URLSearchParams({ user: JSON.stringify({ id: 123 }) }).toString(),
    } },
    join: vi.fn(), on: vi.fn(),
  };
  return { socket, middleware: () => middleware(socket, (error) => { if (error) throw error; }), connect: () => onConnection(socket) };
}

describe('authenticated socket connection access', () => {
  it.each([
    ['admin', {}, true],
    ['warehouse', {}, false],
    ['seller', {}, false],
    ['baselinker', {}, true],
  ])('connects %s with %j without crashing and enforces the database permission', async (role, permissions, allowed) => {
    const harness = createHarness({ role, permissions });
    await harness.middleware();
    expect(harness.connect).not.toThrow();
    expect(harness.socket.join).toHaveBeenCalledWith('user_123');
    expect(harness.socket.join.mock.calls.some(([room]) => room === 'baselinker_staff')).toBe(allowed);
    expect(harness.socket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });

  it('rejects blocked users before connection', async () => {
    const harness = createHarness({ role: 'admin', botBlocked: true });
    await expect(harness.middleware()).rejects.toThrow('Account blocked');
    expect(harness.socket.join).not.toHaveBeenCalled();
  });
});
