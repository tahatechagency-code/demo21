#!/usr/bin/env node
// Starts a LOCAL API for the eval suites: own database (ai_concierge_eval), migrated and seeded with the
// production starter fleet, no Gemini key (the deterministic engine is what is measured), no outbound channels.
// Needs Postgres on :5432 and Redis on :6379. Usage: node evals/serve-local.mjs   (leave it running)
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  DATABASE_URL: process.env.EVAL_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ai_concierge_eval',
  REDIS_URL: process.env.EVAL_REDIS_URL ?? 'redis://localhost:6379/1',
  WEBHOOK_SIGNING_SECRET: 'eval-webhook-secret-1234567890',
  DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001',
  API_PORT: process.env.EVAL_API_PORT ?? '4100',
  API_HOST: '127.0.0.1',
  JWT_SIGNING_SECRET: 'eval-jwt-signing-secret-at-least-32-bytes-long',
  MFA_ENCRYPTION_KEY: 'hEPpdv0I3rPvipYa674EeHgK51Zb+BwciFTcTSAch60=',
  RATE_LIMIT_MAX: '100000',
  CHAT_SESSION_LIMIT_PER_10_MIN: '100000',
  CHAT_GLOBAL_LIMIT_PER_MIN: '100000',
  FOLLOW_UP_SWEEP_INTERVAL_MS: '0',
};
// Gemini is off unless the run asks for it (EVAL_WITH_GEMINI=1 with GEMINI_API_KEY set), so the deterministic
// engine is what is measured by default. Maps is never used by the evals.
if (process.env.EVAL_WITH_GEMINI !== '1') delete env.GEMINI_API_KEY;
delete env.GOOGLE_MAPS_API_KEY;

function run(args, label) {
  const result = spawnSync('pnpm', args, { cwd: root, env, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`${label} failed`);
    process.exit(result.status ?? 1);
  }
}

if (process.argv.includes('--reset')) {
  console.log('==> reset: dropping all rows is done by recreating the eval database');
  run(['--filter', '@ai-concierge/db', 'exec', 'prisma', 'migrate', 'reset', '--force', '--skip-seed'], 'reset');
}
console.log('==> migrate');
run(['--filter', '@ai-concierge/db', 'exec', 'prisma', 'migrate', 'deploy'], 'migrate');
console.log('==> seed');
run(['--filter', '@ai-concierge/api', 'exec', 'tsx', '../../packages/db/src/seed.ts'], 'seed');
console.log(`==> API on http://127.0.0.1:${env.API_PORT}`);
const api = spawn('pnpm', ['--filter', '@ai-concierge/api', 'exec', 'tsx', 'src/server.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: true,
});
api.on('exit', (code) => process.exit(code ?? 0));
