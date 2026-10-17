/**
 * `testsprite api <path>` — make an authenticated request to the TestSprite CLI
 * API and print the JSON response, in the spirit of `gh api` / `sentry api`.
 *
 * It goes through the regular HTTP client, so profiles, `--endpoint-url`,
 * retries, typed error envelopes, exit codes and `--debug` tracing (with
 * secrets redacted) behave exactly as in every other command. The request
 * always goes to the configured API host: a full URL is refused, so the API
 * key is never sent anywhere else.
 */
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions,
} from '../lib/client-factory.js';
import { resolveProfileName } from '../lib/config.js';
import { localValidationError } from '../lib/errors.js';
import type { FetchImpl } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import { readSecretFileGuarded } from '../lib/secret-file.js';
import { assertIdempotencyKey } from '../lib/validate.js';

export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof API_METHODS)[number];

/** Path prefix of the CLI API; accepted (and dropped) when pasted from the docs. */
const API_PATH_PREFIX = '/api/cli/v1';

/** Cap on an `--input` body file, the same 5 MB as a `test create-batch` body. */
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

export interface ApiOptions extends CommonOptions {
  /** API path relative to the CLI API, e.g. `/tests?projectId=p1`. */
  path: string;
  method?: string;
  /** Inline JSON request body. */
  data?: string;
  /** File holding the JSON request body. */
  input?: string;
  idempotencyKey?: string;
}

export interface ApiDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** What `--dry-run` prints instead of sending the request. */
export interface ApiDryRunRequest {
  method: ApiMethod;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

/** Parse `--method` case-insensitively; GET when omitted. */
export function parseApiMethod(raw: string | undefined): ApiMethod {
  if (raw === undefined) return 'GET';
  const method = API_METHODS.find(candidate => candidate === raw.toUpperCase());
  if (method === undefined) {
    throw localValidationError('method', `must be one of: ${API_METHODS.join(', ')}`, [
      ...API_METHODS,
    ]);
  }
  return method;
}

/**
 * Normalize the `<path>` argument to a path under the CLI API: a leading `/` is
 * added, a pasted `/api/cli/v1` prefix is dropped, and a query string is kept.
 * A full URL is refused (the API key must only go to the configured host), and
 * so are `.` / `..` segments, which would step outside the CLI API.
 */
export function normalizeApiPath(raw: string): string {
  // URL parsing drops tabs and line breaks anywhere (so `.<TAB>.` would become
  // `..`); remove them before checking. Pasted endpoints also carry indentation.
  const trimmed = raw
    .replace(/[ \t]*[\r\n]+[ \t]*/g, '')
    .replace(/\t/g, '')
    .trim();
  if (trimmed === '') {
    throw localValidationError(
      'path',
      'must be an API path such as /me or /tests?projectId=<id>',
      undefined,
      'field',
    );
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || /^[/\\]{2}/.test(trimmed)) {
    throw localValidationError(
      'path',
      'must be a path such as /tests, not a full URL. The CLI sends it to the API host from your ' +
        'profile or --endpoint-url and never sends your API key to another host',
      undefined,
      'field',
    );
  }
  let path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (path === API_PATH_PREFIX || /^\/api\/cli\/v1[/?#]/.test(path)) {
    path = path.slice(API_PATH_PREFIX.length);
    if (!path.startsWith('/')) path = `/${path}`;
  }
  // URL parsing treats `%2e` as `.` and `\` as `/`, so check the decoded form.
  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  const escapes = pathname
    .split(/[/\\]/)
    .map(segment => segment.replace(/%2e/gi, '.'))
    .some(segment => segment === '.' || segment === '..');
  if (escapes) {
    throw localValidationError(
      'path',
      'must not contain "." or ".." segments (requests stay under the CLI API)',
      undefined,
      'field',
    );
  }
  return path;
}

/** Read the request body from `--data` or `--input` and parse it as JSON. */
function readRequestBody(opts: Pick<ApiOptions, 'data' | 'input'>): unknown {
  if (opts.data !== undefined && opts.input !== undefined) {
    throw localValidationError('data', 'cannot be combined with --input; pass the body one way');
  }
  if (opts.input === '-') {
    throw localValidationError(
      'input',
      'cannot read the body from stdin; pass a file path, or --data "$(cat body.json)"',
    );
  }
  const flag = opts.data !== undefined ? 'data' : 'input';
  const raw =
    opts.data ??
    (opts.input !== undefined
      ? readSecretFileGuarded('input', opts.input, { maxBytes: MAX_INPUT_BYTES })
      : undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unparseable';
    throw localValidationError(flag, `must be valid JSON (${reason})`);
  }
}

export async function runApi(opts: ApiOptions, deps: ApiDeps = {}): Promise<unknown> {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const method = parseApiMethod(opts.method);
  const path = normalizeApiPath(opts.path);
  const body = readRequestBody(opts);
  const isWrite = method !== 'GET';
  if (!isWrite && body !== undefined) {
    // Writes can create resources or start billed runs, so a body never
    // silently turns a GET into a POST: the method is always explicit.
    throw localValidationError(
      opts.data !== undefined ? 'data' : 'input',
      'is a request body, which needs --method POST, PUT, PATCH or DELETE',
    );
  }
  if (!isWrite && opts.idempotencyKey !== undefined) {
    throw localValidationError(
      'idempotencyKey',
      'only applies to POST, PUT, PATCH and DELETE requests',
    );
  }
  assertIdempotencyKey(opts.idempotencyKey);

  // Every write carries an Idempotency-Key, so the HTTP layer may safely retry
  // it after a network error or a 500 and a re-run with the same key is not
  // applied twice. An auto-minted key is printed so it can be reused.
  const idempotencyKey = isWrite ? (opts.idempotencyKey ?? `cli-api-${randomUUID()}`) : undefined;
  const out = new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr });
  // Built before the dry-run branch so a bad --endpoint-url is still caught
  // offline; under --dry-run this also prints the dry-run banner.
  const client = makeHttpClient(opts, deps);

  if (
    isWrite &&
    opts.idempotencyKey === undefined &&
    (opts.output === 'json' || opts.verbose || opts.debug)
  ) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  if (opts.dryRun) {
    // Canned samples exist only for the routes the CLI's own commands call,
    // so show the request that would be sent instead of a sample response.
    stderr('[note] --dry-run shows the request that would be sent; nothing was sent');
    const request: ApiDryRunRequest = {
      method,
      path: `${API_PATH_PREFIX}${path}`,
      ...(body !== undefined ? { body } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };
    out.print({ dryRun: true, request });
    return request;
  }

  const result = await client.requestWithMeta<unknown>(method, path, {
    ...(body !== undefined ? { body } : {}),
    ...(idempotencyKey !== undefined ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
    allowNoContent: true,
  });
  // A 204 has no body to print.
  if (result.body !== undefined) out.print(result.body);
  return result.body;
}

interface ApiFlagOpts {
  method?: string;
  data?: string;
  input?: string;
  idempotencyKey?: string;
}

export function createApiCommand(deps: ApiDeps = {}): Command {
  return new Command('api')
    .description(
      'Make an authenticated request to the TestSprite CLI API and print the JSON response',
    )
    .argument(
      '<path>',
      'API path, e.g. /me or /tests?projectId=<id> (the /api/cli/v1 prefix is optional)',
    )
    .option('-X, --method <method>', 'HTTP method: GET, POST, PUT, PATCH or DELETE', 'GET')
    .option('--data <json>', 'JSON request body (needs --method POST, PUT, PATCH or DELETE)')
    .option('--input <file>', 'read the JSON request body from a file (up to 5 MB)')
    .option(
      '--idempotency-key <key>',
      'key for safe retries of a write (1–256 chars). Auto-generated keys print to stderr in JSON, verbose or debug mode.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .addHelpText(
      'after',
      '\nThe request goes to the API host from your profile or --endpoint-url, with your API key.\n' +
        'Only paths are accepted, never full URLs, so the key cannot be sent to another host.\n' +
        'It reuses the CLI client: retries, error envelopes and exit codes match every other command.\n' +
        '\nExamples:\n' +
        '  testsprite api /me\n' +
        "  testsprite api '/tests?projectId=<id>' --output json\n" +
        '  testsprite api /runs/<run-id>\n' +
        '  testsprite api /schedules --method POST --input schedule.json\n' +
        '  testsprite api /tests/<test-id> --method PATCH --data \'{"name":"Checkout"}\' --dry-run\n' +
        '\nExit codes:\n' +
        '  0   success\n' +
        '  3   auth error — run `testsprite setup` to configure credentials\n' +
        '  4   not found\n' +
        '  5   invalid arguments, or the server rejected the request (VALIDATION_ERROR)\n' +
        '  6   conflict, e.g. an idempotency key reused with a different body\n' +
        '  10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        '  other codes follow the shared exit-code table (see DOCUMENTATION.md)',
    )
    .action(async (path: string, cmdOpts: ApiFlagOpts, command: Command) => {
      await runApi({ ...resolveCommonOptions(command, deps.env), ...cmdOpts, path }, deps);
    });
}

function resolveCommonOptions(command: Command, env?: NodeJS.ProcessEnv): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  return {
    profile: resolveProfileName(globals.profile, env),
    output: resolveOutputMode(globals.output),
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    dryRun: globals.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(globals.requestTimeout),
  };
}
