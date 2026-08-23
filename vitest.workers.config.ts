import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          ENV_MANAGER_BOT_TOKEN: '111111:test-manager-token-aaaa',
          ENV_HOST_UID: '999999',
          ENV_MASTER_ENC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          ENV_PUBLIC_BASE_URL: 'https://test.example.com',
          ENV_ADMIN_SECRET: 'test-admin-secret',
        },
      },
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
  },
});
