import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { withCheckoutStorage, store, mode } from '../lib/sf365/core.mjs';
import { base as paddleBase } from '../lib/sf365/paddle.mjs';

test('SF365 checkout stores and Paddle mode are isolated across concurrent deploy contexts', async () => {
  const originalStore = globalThis.__SF365_TEST_STORE__;
  const originalPaddleEnv = process.env.PADDLE_ENV;
  globalThis.__SF365_TEST_STORE__ = (_, storeName) => storeName;
  process.env.PADDLE_ENV = 'live';

  try {
    const handle = withCheckoutStorage(async (_, context) => {
      await setTimeout(context?.deploy?.context === 'production' ? 10 : 1);
      return {
        transactions: await store('transactions'),
        files: await store('files'),
        paddleMode: mode('paddle', context).label,
        paddleApi: paddleBase(),
      };
    });

    const [production, preview, branch, unknown] = await Promise.all([
      handle(null, { deploy: { context: 'production' } }),
      handle(null, { deploy: { context: 'deploy-preview' } }),
      handle(null, { deploy: { context: 'branch-deploy' } }),
      handle(null, {}),
    ]);

    assert.deepEqual(production, {
      transactions: 'sf365-transactions',
      files: 'sf365-files',
      paddleMode: 'live',
      paddleApi: 'https://api.paddle.com',
    });
    for (const result of [preview, branch, unknown]) {
      assert.deepEqual(result, {
        transactions: 'sf365-sandbox-transactions',
        files: 'sf365-sandbox-files',
        paddleMode: 'sandbox',
        paddleApi: 'https://sandbox-api.paddle.com',
      });
    }
  } finally {
    if (originalStore === undefined) delete globalThis.__SF365_TEST_STORE__;
    else globalThis.__SF365_TEST_STORE__ = originalStore;
    if (originalPaddleEnv === undefined) delete process.env.PADDLE_ENV;
    else process.env.PADDLE_ENV = originalPaddleEnv;
  }
});
