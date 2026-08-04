/**
 * Importing this module makes the network unavailable for the rest of the
 * process.
 *
 * No test in this repository may reach upstream: a suite whose verdicts depend
 * on what ecosyste.ms happens to be serving today is not a test. Rather than
 * trusting everyone to remember, the one function that could get out —
 * `globalThis.fetch`, which is all `HttpClient` uses — is replaced with a stub
 * that fails loudly and names the URL that was asked for.
 */

const forbidden = (input: unknown): never => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string } | null)?.url ?? String(input));

  throw new Error(
    `Test attempted a network request to ${url}. Tests must be offline: build the ` +
      'signals in code, or hand the module under test a fake HttpClient.',
  );
};

globalThis.fetch = forbidden as unknown as typeof fetch;
