/**
 * Unit tests for `testsprite api <path>`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProfile } from '../lib/credentials.js';
import { ApiError } from '../lib/errors.js';
import type { ApiDeps, ApiOptions } from './api.js';
import { createApiCommand, normalizeApiPath, parseApiMethod, runApi } from './api.js';

interface SentRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

let dir: string;
let credentialsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'testsprite-api-'));
  credentialsPath = join(dir, 'credentials');
  writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
});

/** A fetch that answers every request with `responses` in turn and records what was sent. */
function makeServer(...responses: Array<{ status: number; body?: unknown }>) {
  const sent: SentRequest[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const next = responses[Math.min(sent.length, responses.length) - 1]!;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { sent, fetchImpl: fetchImpl as unknown as ApiDeps['fetchImpl'] };
}

function run(
  opts: Partial<ApiOptions> & Pick<ApiOptions, 'path'>,
  fetchImpl: ApiDeps['fetchImpl'],
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const promise = runApi(
    { profile: 'default', output: 'text', debug: false, ...opts },
    {
      credentialsPath,
      env: {},
      fetchImpl,
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    },
  );
  return { promise, stdout, stderr };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('normalizeApiPath', () => {
  it('adds a leading slash and keeps the query string', () => {
    expect(normalizeApiPath('me')).toBe('/me');
    expect(normalizeApiPath('/tests?projectId=p1&pageSize=5')).toBe(
      '/tests?projectId=p1&pageSize=5',
    );
  });

  it('drops a pasted /api/cli/v1 prefix', () => {
    expect(normalizeApiPath('/api/cli/v1/tests/t1')).toBe('/tests/t1');
    expect(normalizeApiPath('api/cli/v1/runs/r1')).toBe('/runs/r1');
    expect(normalizeApiPath('/api/cli/v1?x=1')).toBe('/?x=1');
    expect(normalizeApiPath('/api/cli/v10/tests')).toBe('/api/cli/v10/tests');
  });

  it('removes line breaks from a copy-pasted endpoint', () => {
    expect(normalizeApiPath('/tests/\n    t1/result')).toBe('/tests/t1/result');
  });

  it.each([
    ['https://evil.example.com/me'],
    ['http://127.0.0.1:8080/me'],
    ['//evil.example.com/me'],
    ['\\\\evil.example.com\\me'],
    ['javascript:alert(1)'],
  ])('refuses the full URL %s so the API key never leaves the configured host', raw => {
    expect(() => normalizeApiPath(raw)).toThrow(ApiError);
    try {
      normalizeApiPath(raw);
    } catch (err) {
      expect((err as ApiError).code).toBe('VALIDATION_ERROR');
      expect((err as ApiError).nextAction).toContain('not a full URL');
    }
  });

  it.each([
    ['/../admin'],
    ['/tests/../../admin'],
    ['/%2E%2E/admin'],
    ['/a/./b'],
    ['\\..\\admin'],
    // URL parsing removes tabs, so these would otherwise become `..`.
    ['/.\t./admin'],
    ['/%2e\t%2e/admin'],
  ])('refuses %s, which would step outside the CLI API', raw => {
    expect(() => normalizeApiPath(raw)).toThrow(/Invalid request/);
  });

  it('allows dots inside a segment and in the query string', () => {
    expect(normalizeApiPath('/tests/t.1?name=../x')).toBe('/tests/t.1?name=../x');
  });

  it('refuses an empty path', () => {
    expect(() => normalizeApiPath('  ')).toThrow(ApiError);
  });
});

describe('parseApiMethod', () => {
  it('defaults to GET and accepts any case', () => {
    expect(parseApiMethod(undefined)).toBe('GET');
    expect(parseApiMethod('patch')).toBe('PATCH');
  });

  it('lists the accepted methods when the value is unknown', () => {
    try {
      parseApiMethod('TRACE');
      expect.unreachable();
    } catch (err) {
      expect((err as ApiError).details).toMatchObject({
        field: 'method',
        accepted: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      });
    }
  });
});

describe('runApi', () => {
  it('sends an authenticated GET to the configured API host and prints the JSON body', async () => {
    const server = makeServer({ status: 200, body: { userId: 'u1' } });
    const { promise, stdout } = run({ path: '/me' }, server.fetchImpl);

    await expect(promise).resolves.toEqual({ userId: 'u1' });
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.url).toBe('https://api.testsprite.com/api/cli/v1/me');
    expect(server.sent[0]!.method).toBe('GET');
    expect(server.sent[0]!.headers.get('x-api-key')).toBe('sk-user-abc');
    expect(server.sent[0]!.headers.get('idempotency-key')).toBeNull();
    expect(server.sent[0]!.body).toBeUndefined();
    expect(JSON.parse(stdout.join('\n'))).toEqual({ userId: 'u1' });
  });

  it('honours --endpoint-url and keeps the query string', async () => {
    const server = makeServer({ status: 200, body: { items: [] } });
    const { promise } = run(
      { path: 'tests?projectId=p1', endpointUrl: 'https://api.staging.example.com' },
      server.fetchImpl,
    );

    await promise;
    expect(server.sent[0]!.url).toBe(
      'https://api.staging.example.com/api/cli/v1/tests?projectId=p1',
    );
  });

  it('sends a write with its JSON body and an auto-minted idempotency key, printed in JSON mode', async () => {
    const server = makeServer({ status: 200, body: { id: 't1', name: 'Checkout' } });
    const { promise, stderr } = run(
      { path: '/tests/t1', method: 'PATCH', data: '{"name":"Checkout"}', output: 'json' },
      server.fetchImpl,
    );

    await promise;
    const sent = server.sent[0]!;
    expect(sent.method).toBe('PATCH');
    expect(JSON.parse(sent.body!)).toEqual({ name: 'Checkout' });
    expect(sent.headers.get('content-type')).toBe('application/json');
    const key = sent.headers.get('idempotency-key');
    expect(key).toMatch(/^cli-api-[0-9a-f-]{36}$/);
    expect(stderr).toContain(`idempotency-key: ${key}`);
  });

  it('uses --idempotency-key as given and does not print it', async () => {
    const server = makeServer({ status: 200, body: {} });
    const { promise, stderr } = run(
      { path: '/schedules', method: 'POST', data: '{}', idempotencyKey: 'ci-42', output: 'json' },
      server.fetchImpl,
    );

    await promise;
    expect(server.sent[0]!.headers.get('idempotency-key')).toBe('ci-42');
    expect(stderr.some(line => line.startsWith('idempotency-key:'))).toBe(false);
  });

  it('retries a write after a 500 with the same idempotency key', async () => {
    const server = makeServer(
      {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'boom', nextAction: '', requestId: 'r1' } },
      },
      { status: 200, body: { ok: true } },
    );
    const { promise } = run({ path: '/schedules', method: 'POST', data: '{}' }, server.fetchImpl);

    await expect(promise).resolves.toEqual({ ok: true });
    expect(server.sent).toHaveLength(2);
    expect(server.sent[1]!.headers.get('idempotency-key')).toBe(
      server.sent[0]!.headers.get('idempotency-key'),
    );
  });

  it('reads the body from --input', async () => {
    const file = join(dir, 'body.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary directory.
    writeFileSync(file, '{\n  "cron": "0 * * * *"\n}\n');
    const server = makeServer({ status: 200, body: {} });
    const { promise } = run({ path: '/schedules', method: 'POST', input: file }, server.fetchImpl);

    await promise;
    expect(JSON.parse(server.sent[0]!.body!)).toEqual({ cron: '0 * * * *' });
  });

  it('explains that --input - (stdin) is not supported instead of looking for a file named -', async () => {
    const server = makeServer({ status: 200, body: {} });
    const err = await rejection(
      run({ path: '/tests', method: 'POST', input: '-' }, server.fetchImpl).promise,
    );
    expect(err.details).toMatchObject({ field: 'input' });
    expect(err.nextAction).toContain('cannot read the body from stdin');
    expect(server.sent).toHaveLength(0);
  });

  it('refuses an --input file over 5 MB before sending anything', async () => {
    const file = join(dir, 'big.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary directory.
    writeFileSync(file, `{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`);
    const server = makeServer({ status: 200, body: {} });

    const err = await rejection(
      run({ path: '/schedules', method: 'POST', input: file }, server.fetchImpl).promise,
    );
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
    expect(err.exitCode).toBe(5);
    expect(err.details).toMatchObject({ field: 'input', maxBytes: 5 * 1024 * 1024 });
    expect(server.sent).toHaveLength(0);
  });

  it('prints nothing for a 204', async () => {
    const server = makeServer({ status: 204 });
    const { promise, stdout } = run({ path: '/tunnel/c1', method: 'DELETE' }, server.fetchImpl);

    await expect(promise).resolves.toBeUndefined();
    expect(stdout).toEqual([]);
  });

  it('surfaces a server error as its typed envelope and exit code', async () => {
    const server = makeServer({
      status: 404,
      body: {
        error: { code: 'NOT_FOUND', message: 'Test not found', nextAction: '', requestId: 'r9' },
      },
    });
    const { promise, stdout } = run({ path: '/tests/nope' }, server.fetchImpl);

    const err = await rejection(promise);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.exitCode).toBe(4);
    expect(err.requestId).toBe('r9');
    expect(stdout).toEqual([]);
  });

  it.each([
    [{ path: 'https://evil.example.com/me' }, 'path'],
    [{ path: '/tests/t1', data: '{"name":"x"}' }, 'data'],
    [{ path: '/me', idempotencyKey: 'k1' }, 'idempotencyKey'],
    [{ path: '/tests', method: 'POST', data: '{}', input: 'body.json' }, 'data'],
    [{ path: '/tests', method: 'POST', data: '{name:' }, 'data'],
    [{ path: '/tests', method: 'POST', input: 'missing.json' }, 'input'],
    [{ path: '/me', method: 'OPTIONS' }, 'method'],
  ] as const)('refuses %o before sending anything (field %s)', async (opts, field) => {
    const server = makeServer({ status: 200, body: {} });
    const err = await rejection(run(opts, server.fetchImpl).promise);

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.exitCode).toBe(5);
    expect(err.details).toMatchObject({ field });
    expect(server.sent).toHaveLength(0);
  });

  it('--dry-run prints the request it would send and sends nothing', async () => {
    const server = makeServer({ status: 200, body: {} });
    const { promise, stdout, stderr } = run(
      { path: '/api/cli/v1/schedules', method: 'post', data: '{"cron":"0 * * * *"}', dryRun: true },
      server.fetchImpl,
    );

    await promise;
    expect(server.sent).toHaveLength(0);
    const printed = JSON.parse(stdout.join('\n')) as {
      dryRun: boolean;
      request: Record<string, unknown>;
    };
    expect(printed.dryRun).toBe(true);
    expect(printed.request).toMatchObject({
      method: 'POST',
      path: '/api/cli/v1/schedules',
      body: { cron: '0 * * * *' },
    });
    expect(printed.request.idempotencyKey).toMatch(/^cli-api-/);
    expect(stderr.join('\n')).toContain('nothing was sent');
  });
});

describe('createApiCommand wiring', () => {
  it('maps the argument and flags, including -X and the global options', async () => {
    const stdout: string[] = [];
    const program = new Command('testsprite')
      .option('--output <mode>', 'Output format (json|text)', 'text')
      .option('--dry-run', 'Skip the network', false)
      .exitOverride();
    program.addCommand(
      createApiCommand({
        credentialsPath,
        env: {},
        stdout: line => stdout.push(line),
        stderr: () => {},
      }),
    );

    await program.parseAsync(
      [
        '--dry-run',
        '--output',
        'json',
        'api',
        'tests/t1',
        '-X',
        'delete',
        '--idempotency-key',
        'k1',
      ],
      { from: 'user' },
    );
    expect(JSON.parse(stdout.join('\n'))).toEqual({
      dryRun: true,
      request: { method: 'DELETE', path: '/api/cli/v1/tests/t1', idempotencyKey: 'k1' },
    });
  });
});
