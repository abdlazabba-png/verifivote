#!/usr/bin/env node
// Load-tests the REAL deployed backend (not the mock server this codebase
// started with). Writes directly to DynamoDB via the raw AWS SDK rather
// than through AppSync's GraphQL layer — signing real Cognito-authenticated
// GraphQL requests from a script is substantial extra complexity (SRP auth
// flow, token storage outside a browser) that doesn't actually change what
// this needs to prove: whether the pieces that are NEW in the real backend
// — concurrent DynamoDB writes and the validate-submission Lambda's
// DynamoDB Streams pipeline — hold up under real AWS latency and
// concurrency. That's what this tests. It does NOT test AppSync's own
// resolver/auth layer under concurrent load; the earlier manual browser
// testing already exercised that path, just not at volume.
//
// Test records are deleted at the end so they don't clutter the real
// Coverage/Evidence dashboard with fake data.
//
// Run with: node scripts/load-test-real-backend.mjs
// Needs AWS credentials configured (same ones `npx ampx sandbox` uses).
//
// The sandbox (`npx ampx sandbox`) and the deployed pipeline-deploy backend
// each get their own "Submission-*" DynamoDB table in the same AWS
// account/region (see PILOT_READINESS.md), so auto-detection only works
// while exactly one exists. Once both are deployed, point this at the
// right one explicitly:
//   node scripts/load-test-real-backend.mjs --table Submission-abc123-NONE
//   SUBMISSION_TABLE_NAME=Submission-abc123-NONE node scripts/load-test-real-backend.mjs

import { randomUUID } from 'node:crypto';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { POLLING_UNITS } from '../src/referenceData/states/gombe.js';

const REGION = process.env.AWS_REGION || 'eu-north-1';
const AGENT_COUNT = 25;
const PARTY_CLIENT_ID = 'party-demo-alpha';
const STATE_CODE = 'GM';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

function tableNameFromArgs() {
  const flagIndex = process.argv.indexOf('--table');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return process.argv[flagIndex + 1];
  }
  return process.env.SUBMISSION_TABLE_NAME || null;
}

async function findSubmissionTableName() {
  const explicit = tableNameFromArgs();
  if (explicit) {
    return explicit;
  }

  const { TableNames } = await client.send(new ListTablesCommand({}));
  const matches = (TableNames || []).filter((name) => name.startsWith('Submission-'));
  if (matches.length === 0) {
    throw new Error('No "Submission-*" table found in this account/region.');
  }
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} "Submission-*" tables — sandbox and the deployed backend each have their own ` +
        `(see PILOT_READINESS.md). Re-run with one of:\n` +
        matches.map((name) => `  --table ${name}`).join('\n') +
        `\nor set SUBMISSION_TABLE_NAME.`
    );
  }
  return matches[0];
}

function lgaCodeFor(pu) {
  return pu.wardCode.split('/')[0];
}

function buildRecord(index) {
  const pu = POLLING_UNITS[index % POLLING_UNITS.length]; // deliberate repeats -> exercises duplicate detection
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    partyClientId: PARTY_CLIENT_ID,
    stateCode: STATE_CODE,
    agentId: `loadtest-agent-${index}`,
    puCode: pu.puCode,
    wardCode: pu.wardCode,
    lgaCode: lgaCodeFor(pu),
    partyVotes: { APC: 10 + index, PDP: 5 + index },
    ocrVotes: { APC: 10 + index, PDP: 5 + index },
    photoKey: null,
    gpsLat: null,
    gpsLng: null,
    gpsAccuracy: null,
    deviceId: `loadtest-device-${index}`,
    submissionHash: `loadtest-hash-${index}`,
    clientTimestamp: Date.now(),
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  const tableName = await findSubmissionTableName();
  console.log(`Table: ${tableName}`);
  console.log(`Writing ${AGENT_COUNT} records concurrently...\n`);

  const records = Array.from({ length: AGENT_COUNT }, (_, i) => buildRecord(i));
  const ourIds = new Set(records.map((r) => r.id));

  // Everything that can throw between the writes landing and cleanup runs
  // inside this try, with cleanup in `finally`, so a scan/poll failure
  // (or Ctrl-C) doesn't leave loadtest-* records sitting in the real
  // Coverage/Evidence dashboard — cleanup used to only run on the happy
  // path, with main().catch() at the bottom logging the error and exiting
  // without ever reaching the delete step.
  let foundCount = 0;
  let validatedCount = 0;
  let finalItems = [];
  try {
    const writeStart = performance.now();
    await Promise.all(records.map((r) => docClient.send(new PutCommand({ TableName: tableName, Item: r }))));
    const writeElapsedMs = performance.now() - writeStart;
    console.log(`Writes completed in ${writeElapsedMs.toFixed(0)}ms.`);

    const { Items: afterWrite } = await docClient.send(new ScanCommand({ TableName: tableName }));
    foundCount = (afterWrite || []).filter((item) => ourIds.has(item.id)).length;
    console.log(`Data-loss check: ${foundCount}/${AGENT_COUNT} records present (should be exactly ${AGENT_COUNT}).\n`);

    console.log('Polling for the validation Lambda to catch up via DynamoDB Streams...');
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const { Items } = await docClient.send(new ScanCommand({ TableName: tableName }));
      finalItems = (Items || []).filter((item) => ourIds.has(item.id));
      validatedCount = finalItems.filter((item) => item.validationSeverity).length;
      console.log(`  after ${attempt * 2}s: ${validatedCount}/${AGENT_COUNT} validated`);
      if (validatedCount === AGENT_COUNT) break;
    }

    const severityCounts = {};
    for (const item of finalItems) {
      const sev = item.validationSeverity || 'unvalidated';
      severityCounts[sev] = (severityCounts[sev] || 0) + 1;
    }
    console.log('\nSeverity breakdown:', severityCounts);
  } finally {
    console.log('\nCleaning up test records...');
    // allSettled, not all: a partial write failure above shouldn't stop us
    // from deleting whichever of the 25 records actually landed. Deleting
    // a key that was never written is a harmless no-op in DynamoDB.
    const results = await Promise.allSettled(
      records.map((r) => docClient.send(new DeleteCommand({ TableName: tableName, Key: { id: r.id } })))
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.error(
        `WARNING: ${failed.length}/${records.length} test records failed to delete — clean up manually (table: ${tableName}):`,
        failed.map((r) => r.reason?.message || r.reason)
      );
    } else {
      console.log('Cleanup done.');
    }
  }

  const ok = foundCount === AGENT_COUNT && validatedCount === AGENT_COUNT;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: real backend handled ${AGENT_COUNT} concurrent writes with zero data loss${ok ? ' and the validation Lambda kept up.' : '.'}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
