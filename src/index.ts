interface Env {
  DOWNLOAD_COUNTER: DurableObjectNamespace;
}

interface GitHubAsset {
  name: string;
  download_count: number;
}

interface GitHubRelease {
  assets: GitHubAsset[];
}

interface DonationTransaction {
  amount: number | string;
  destination: string;
  hash: string;
  source: string;
  status: string;
  timestamp: string;
}

interface Donation {
  amount: number;
  hash: string;
  identity: string;
  timestamp: string;
}

interface SupportProgress {
  receivedQu: number;
  priceUsdt: number;
  receivedUsd: number;
  target: number;
  percent: number;
  label: string;
}

interface SupportData {
  progress: SupportProgress;
  donations: Donation[];
}

const releasesApi = "https://api.github.com/repos/glyphq/wallet/releases";
const installerPattern = /\.(?:exe|msi|dmg|appimage|deb|rpm)$/i;
const rateWindowMs = 10 * 60 * 1000;
const rateLimit = 10;
const donationIdentity = "MQKMCXZJKKJBRAWMRRRJMVRLVKHBLSQGPEFHKLZKNFRYVFQENKXEELQAPPEK";
const legacyDonationIdentity = "XIKAQZMFGQSALEMMJRATPPRESWTBXQVCOHTHCZWDGFXVBMCAHBCRUICFOQBI";
const donationTarget = 2000;
const baselineDownloads = 492;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

const today = () => new Date().toISOString().slice(0, 10);

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...headers },
  });

const progressLabel = (percent: number) => {
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
};

const fetchSupportData = async (): Promise<SupportData> => {
  const [transactionsResponse, priceResponse] = await Promise.all([
    fetch(`https://api.glyphq.org/v1/identities/${donationIdentity}/transactions?limit=200`),
    fetch("https://api.glyphq.org/v1/prices/latest"),
  ]);
  if (!transactionsResponse.ok || !priceResponse.ok) {
    throw new Error("Glyph API request failed");
  }

  const transactions = (await transactionsResponse.json()) as { data?: DonationTransaction[] };
  const price = (await priceResponse.json()) as { data?: { price_usdt?: number } };
  const donations = (transactions.data ?? [])
    .filter(
      (transaction) =>
        transaction.destination === donationIdentity && transaction.status === "success",
    )
    .map((transaction) => ({
      amount: Number(transaction.amount),
      hash: transaction.hash,
      identity: transaction.source,
      timestamp: transaction.timestamp,
    }))
    .filter((donation) => Number.isFinite(donation.amount) && donation.amount > 0);

  const receivedQu = donations
    .filter((donation) => donation.identity !== legacyDonationIdentity)
    .reduce((sum, donation) => sum + donation.amount, 0);
  const priceUsdt = Number(price.data?.price_usdt ?? 0);
  if (!Number.isFinite(receivedQu) || !Number.isFinite(priceUsdt)) {
    throw new Error("Glyph API returned invalid donation data");
  }

  const receivedUsd = receivedQu * priceUsdt;
  const percent = donationTarget > 0 ? Math.min(100, (receivedUsd / donationTarget) * 100) : 0;

  return {
    progress: {
      receivedQu,
      priceUsdt,
      receivedUsd,
      target: donationTarget,
      percent,
      label: progressLabel(percent),
    },
    donations,
  };
};

const supportTtl = (value: string | null) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 120;
  return Math.min(900, Math.max(60, Math.floor(parsed)));
};

const fetchHistoricalDownloads = async (): Promise<number> => {
  let total = 0;

  for (let page = 1; ; page += 1) {
    const response = await fetch(`${releasesApi}?per_page=100&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "glyphq-analytics",
      },
    });
    if (!response.ok) throw new Error(`GitHub releases request failed (${response.status})`);

    const releases = (await response.json()) as GitHubRelease[];
    for (const release of releases) {
      for (const asset of release.assets) {
        if (installerPattern.test(asset.name)) total += asset.download_count;
      }
    }
    if (releases.length < 100) break;
  }

  return total;
};

export class DownloadCounter {
  private state: DurableObjectState;
  private total = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectState) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<number>("total");
      if (typeof stored === "number") {
        this.total = stored;
        return;
      }

      try {
        this.total = await fetchHistoricalDownloads();
      } catch {
        this.total = baselineDownloads;
      }
      await state.storage.put("total", this.total);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const run = this.queue.then(() => this.handle(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/api(?=\/)/, "");

    if (pathname === "/support" || pathname === "/support/") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

      const ttl = supportTtl(url.searchParams.get("ttl"));
      const key = `support:${ttl}`;
      const cached = await this.state.storage.get<{ at: number; data: SupportData }>(key);
      if (cached && Date.now() - cached.at < ttl * 1000) return json(cached.data);

      try {
        const data = await fetchSupportData();
        await this.state.storage.put(key, { at: Date.now(), data });
        return json(data);
      } catch {
        return json({ error: "Donation data unavailable" }, 502);
      }
    }

    if (request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const rateKey = `rate:${ip}`;
      const now = Date.now();
      const record = await this.state.storage.get<{ count: number; reset: number }>(rateKey);

      if (record && record.reset > now) {
        if (record.count >= rateLimit) {
          return new Response(JSON.stringify({ error: "Too many download events" }), {
            status: 429,
            headers: {
              ...corsHeaders,
              "Retry-After": String(Math.ceil((record.reset - now) / 1000)),
            },
          });
        }
        await this.state.storage.put(rateKey, { count: record.count + 1, reset: record.reset });
      } else {
        await this.state.storage.put(rateKey, { count: 1, reset: now + rateWindowMs });
      }

      this.total += 1;
      await this.state.storage.put("total", this.total);
      return json({ count: this.total });
    }

    if (request.method === "GET") {
      return json({ count: this.total, since: today() });
    }

    return json({ error: "Method not allowed" }, 405);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/api(?=\/)/, "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (pathname === "/support" || pathname === "/support/") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const id = env.DOWNLOAD_COUNTER.idFromName("global");
      return env.DOWNLOAD_COUNTER.get(id).fetch(request);
    }

    if (pathname === "/downloads" || pathname === "/downloads/") {
      const id = env.DOWNLOAD_COUNTER.idFromName("global");
      return env.DOWNLOAD_COUNTER.get(id).fetch(request);
    }

    if (pathname === "/") {
      return json({
        ok: true,
        endpoints: ["GET /downloads", "POST /downloads", "GET /support?ttl=120"],
      });
    }

    return json({ error: "Not found" }, 404);
  },
};
