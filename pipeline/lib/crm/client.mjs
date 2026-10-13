// Shared plumbing for every CRM adapter: dry-run by default, credential check at the
// moment of use, and a request log you can assert on.
//
// The dry run is the point. A writeback layer that can only be exercised with live
// credentials is a writeback layer nobody tests.

export function createClient({ vendor, baseUrl, token, dryRun = true, log = () => {}, auth = 'bearer' }) {
  const requests = [];
  const written = { companies: 0, people: 0, list_entries: 0 };

  async function send(method, path, body, extraHeaders) {
    const url = /^https?:/.test(path) ? path : `${baseUrl}${path}`;
    requests.push({ method, url, body });

    if (dryRun) {
      log(`${method} ${path}`);
      return { dryrun: true, json: null };
    }
    if (!token) throw new Error(`${vendor}: token is not set — see .env.example`);

    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (auth === 'bearer') headers.Authorization = `Bearer ${token}`;
    else if (auth === 'hubspot') headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

    if (!res.ok) {
      const detail = json?.code ?? json?.errorCode ?? json?.message ?? '';
      const err = new Error(`${vendor} ${method} ${path} → HTTP ${res.status} ${detail}`.trim());
      err.status = res.status;
      err.vendor = vendor;
      err.detail = json;
      throw err;
    }
    return { dryrun: false, json };
  }

  return {
    vendor,
    send,
    requests,
    written,
    get dryRun() { return dryRun; },
    syntheticId: () => `dryrun_${requests.length}`,
    receipt: () => ({ vendor, dry_run: dryRun, written: { ...written }, requests: requests.length }),
  };
}
