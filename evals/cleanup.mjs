#!/usr/bin/env node
// Removes everything the eval runner created: every conversation of a web chat session whose id starts with
// "eeeeeeee-" (the runner's marker), with all rows hanging off them (messages, journeys, quotes, escalation
// cases, notifications, CRM events ...), found by following the database's own foreign keys.
//   node evals/cleanup.mjs                       (uses EVAL_DATABASE_URL or the local ai_concierge_eval database)
//   node evals/cleanup.mjs --dry-run             (only counts)
// Never run it against a database holding real customers unless you have read the "--dry-run" count first:
// it deletes exactly the conversations whose customerRef is "web:eeeeeeee-%" and nothing else.
import { createPrismaClient } from '../packages/db/dist/index.js';

const url =
  process.env.EVAL_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ai_concierge_eval';
const dryRun = process.argv.includes('--dry-run');
const prisma = createPrismaClient(url);

const MARKER = 'web:eeeeeeee-%';

async function childrenOf(table) {
  return prisma.$queryRawUnsafe(
    `SELECT kcu.table_name AS child, kcu.column_name AS child_col, ccu.column_name AS parent_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_name = $1`,
    table,
  );
}

/** Deletes the rows of `table` matching `where` after deleting every row that points at them. */
async function remove(table, where, seen = new Set()) {
  const key = `${table}|${where}`;
  if (seen.has(key) || seen.size > 200) return 0;
  seen.add(key);
  let count = 0;
  for (const { child, child_col: childCol, parent_col: parentCol } of await childrenOf(table)) {
    if (child === table) continue; // self reference: removed together with its parent rows below
    count += await remove(child, `"${childCol}" IN (SELECT "${parentCol}" FROM "${table}" WHERE ${where})`, seen);
  }
  if (dryRun) {
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`);
    return count + rows[0].n;
  }
  return count + (await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${where}`));
}

try {
  const where = `"customerRef" LIKE '${MARKER}'`;
  const total = await remove('conversations', where);
  const keys = dryRun
    ? (await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key LIKE 'chat:eeeeeeee-%'`))[0].n
    : await prisma.$executeRawUnsafe(`DELETE FROM idempotency_keys WHERE key LIKE 'chat:eeeeeeee-%'`);
  console.log(`${dryRun ? 'would remove' : 'removed'} ${total} rows under eval conversations and ${keys} idempotency keys`);
} finally {
  await prisma.$disconnect();
}
