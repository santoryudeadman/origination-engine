// One HTTP client for every outbound integration.
//
// The behaviour that matters is identical whether the vendor is a CRM or a sequencer:
//   * dry-run by default — print the request, send nothing
//   * refuse to run without a credential rather than silently no-op
//   * log every request, so a test can assert on the exact shape
//
// So there is one implementation, and each vendor supplies its auth dialect.

export function createHttpClient({
  vendor,
  baseUrl,
  token,
  auth = 'bearer',
  dryRun = true,
  log = () => {},
  extraHeaders = {},
  fetchImpl = globalThis.fetch,
}) {
  const requests = [];

  /** Lemlist wants HTTP Basic with an EMPTY username and the key as the password. */
  function authorization() {
    if (auth === 'lemlist') return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
    return `Bearer ${token}`;
  }

  async function send(method, path, body, opts = {}) {
    const url = /^https?:/.test(path) ? path : `${baseUrl}${path}`;
    requests.push({ method, url, body });

    if (dryRun) {
      log(`${method} ${path}`);
      return { dryrun: true, status: 0, json: null };
    }
    if (!token) throw new Error(`${vendor}: token is not set — see .env.example`);

    const res = await fetchImpl(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
        Authorization: authorization(),
        ...(opts.headers || {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

    if (!res.ok) {
      const detail = json?.code ?? json?.errorCode ?? json?.message ?? json?.error ?? '';
      const err = new Error(`${vendor} ${method} ${path} → HTTP ${res.status} ${detail}`.trim());
      err.status = res.status;
      err.vendor = vendor;
      err.detail = json;
      throw err;
    }
    return { dryrun: false, status: res.status, json };
  }

  return {
    vendor,
    send,
    requests,
    get dryRun() { return dryRun; },
    syntheticId: () => `dryrun_${requests.length}`,
  };
}
