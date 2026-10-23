#!/usr/bin/env node
/**
 * Acceptance test for check_sources (F3).
 *
 * Spins up a temporary local HTTP server in-process with a healthy route
 * (/ok), a deliberately broken route (/broken -> 404, standing in for a
 * manually corrupted link), plus a URL to a closed port (connection refused).
 * Calls the exported probe() directly (same process — cross-process loopback
 * fetch is blocked in some sandboxed environments) and asserts:
 *   - the healthy URL probes ok with status 200
 *   - the broken 404 URL lands in the failed bucket
 *   - the unreachable URL lands in the failed bucket with status null
 * Also verifies the default source collectors find URLs in the capabilities
 * matrix and the data-sources markdown.
 *
 * Usage:
 *   node tests/check_sources_cases.mjs
 */

import { createServer } from 'node:http';
import { probe, collectFromCapabilities, collectFromMarkdown } from '../scripts/check_sources.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label} ${detail}`);
  }
}

async function main() {
  const server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('gone');
    }
  });
  const port = await listen(server);
  const okUrl = `http://127.0.0.1:${port}/ok`;
  const brokenUrl = `http://127.0.0.1:${port}/broken`;

  const doomed = createServer(() => {});
  const deadPort = await listen(doomed);
  await close(doomed);
  const deadUrl = `http://127.0.0.1:${deadPort}/unreachable`;

  const okResult = await probe(okUrl, 5000);
  check('healthy URL probes ok (200)', okResult.ok === true && okResult.status === 200, JSON.stringify(okResult));

  const brokenResult = await probe(brokenUrl, 5000);
  check('broken 404 URL fails', brokenResult.ok === false && brokenResult.status === 404, JSON.stringify(brokenResult));

  const deadResult = await probe(deadUrl, 5000);
  check('unreachable URL fails with status null', deadResult.ok === false && deadResult.status === null, JSON.stringify(deadResult));

  const fromCapabilities = collectFromCapabilities();
  check('capabilities collector finds registry URLs', fromCapabilities.length >= 6, `got ${fromCapabilities.length}`);

  const fromMarkdown = collectFromMarkdown(join(ROOT, 'data-sources'));
  check('markdown collector finds data-source URLs', fromMarkdown.length >= 8, `got ${fromMarkdown.length}`);

  await close(server);

  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\ncheck_sources acceptance (F3) passed');
}

main();