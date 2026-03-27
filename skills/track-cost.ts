/**
 * track-cost.ts — Real-time cost tracking skill for NanoClaw Web3 Agency
 *
 * Hooks into NanoClaw's token-usage events, accumulates spend per model,
 * and fires a Discord warning when the configured threshold is crossed.
 *
 * Usage:
 *   import { CostTracker } from './track-cost';
 *   const tracker = new CostTracker();
 *   tracker.register();
 */

// ---------------------------------------------------------------------------
// OpenRouter pricing table (USD per 1M tokens, as of mid-2025)
// Update these when OpenRouter publishes new rates.
// ---------------------------------------------------------------------------
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "openrouter/anthropic/claude-4.6-opus": { input: 15.0, output: 75.0 },
  "openrouter/anthropic/claude-4.6-sonnet": { input: 3.0, output: 15.0 },
  "openrouter/xai/grok-4.2": { input: 5.0, output: 15.0 },
};

const DEFAULT_PRICING = { input: 3.0, output: 15.0 };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface TokenUsageEvent {
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestamp?: Date;
}

export interface CostRecord {
  model: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: Date;
}

export interface CostSummary {
  totalCostUsd: number;
  byModel: Record<string, number>;
  byRole: Record<string, number>;
  recordCount: number;
  since: Date;
}

// ---------------------------------------------------------------------------
// CostTracker class
// ---------------------------------------------------------------------------
export class CostTracker {
  private records: CostRecord[] = [];
  private warningFired = false;
  private thresholdUsd: number;
  private discordWebhookUrl: string | undefined;
  private startedAt: Date;

  constructor() {
    this.thresholdUsd = parseFloat(
      process.env.COST_WARNING_THRESHOLD_USD ?? "5"
    );
    this.discordWebhookUrl = process.env.DISCORD_COST_WEBHOOK_URL;
    this.startedAt = new Date();
  }

  /**
   * Register this tracker with NanoClaw's event system.
   * Called automatically by entrypoint.sh via --register flag.
   */
  register(): void {
    // NanoClaw emits 'tokenUsage' events on its global process object.
    // Fallback to a no-op if running outside NanoClaw (e.g., during tests).
    const emitter =
      (globalThis as unknown as { nanoclaw?: { on: Function } }).nanoclaw ??
      process;

    if ("on" in emitter && typeof emitter.on === "function") {
      emitter.on("tokenUsage", (event: TokenUsageEvent) =>
        this.record(event)
      );
      console.log("[cost-tracker] Registered on tokenUsage event emitter.");
    } else {
      console.warn("[cost-tracker] No compatible event emitter found — running in standalone mode.");
    }

    // Also expose as a CLI entry point
    if (process.argv.includes("--register")) {
      console.log(
        `[cost-tracker] Active. Threshold: $${this.thresholdUsd.toFixed(2)} USD`
      );
    }
  }

  /**
   * Record a token usage event and update running totals.
   */
  record(event: TokenUsageEvent): CostRecord {
    const pricing = MODEL_PRICING[event.model] ?? DEFAULT_PRICING;
    const costUsd =
      (event.inputTokens / 1_000_000) * pricing.input +
      (event.outputTokens / 1_000_000) * pricing.output;

    const record: CostRecord = {
      model: event.model,
      role: event.role,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      costUsd,
      timestamp: event.timestamp ?? new Date(),
    };

    this.records.push(record);
    this.log(record);
    this.checkThreshold();

    return record;
  }

  /**
   * Return a summary of all costs since the tracker started.
   */
  summary(): CostSummary {
    const byModel: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    let totalCostUsd = 0;

    for (const r of this.records) {
      byModel[r.model] = (byModel[r.model] ?? 0) + r.costUsd;
      byRole[r.role] = (byRole[r.role] ?? 0) + r.costUsd;
      totalCostUsd += r.costUsd;
    }

    return {
      totalCostUsd,
      byModel,
      byRole,
      recordCount: this.records.length,
      since: this.startedAt,
    };
  }

  /**
   * Reset accumulated costs (e.g., at start of a new billing period).
   */
  reset(): void {
    this.records = [];
    this.warningFired = false;
    this.startedAt = new Date();
    console.log("[cost-tracker] Cost records reset.");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private log(record: CostRecord): void {
    const total = this.summary().totalCostUsd;
    console.log(
      `[cost-tracker] ${record.role} (${record.model}) ` +
        `in=${record.inputTokens} out=${record.outputTokens} ` +
        `cost=$${record.costUsd.toFixed(4)} | session_total=$${total.toFixed(4)}`
    );
  }

  private checkThreshold(): void {
    const { totalCostUsd } = this.summary();

    if (!this.warningFired && totalCostUsd >= this.thresholdUsd) {
      this.warningFired = true;
      const message =
        `⚠️ **Cost Warning** — Project **${process.env.PROJECT_NAME ?? "unknown"}** ` +
        `has spent **$${totalCostUsd.toFixed(2)} USD** this session ` +
        `(threshold: $${this.thresholdUsd.toFixed(2)} USD). ` +
        `Check the model routing config if this seems high.`;

      console.warn(`[cost-tracker] THRESHOLD EXCEEDED: ${message}`);
      this.postDiscordWarning(message).catch((err) =>
        console.error("[cost-tracker] Discord notification failed:", err)
      );
    }
  }

  private async postDiscordWarning(message: string): Promise<void> {
    if (!this.discordWebhookUrl) {
      // Fallback: log to stdout; the PM agent's Discord bot will relay it
      console.warn("[cost-tracker] No DISCORD_COST_WEBHOOK_URL set — warning logged only.");
      return;
    }

    const payload = JSON.stringify({
      content: message,
      username: "NanoClaw Cost Tracker",
    });

    const url = new URL(this.discordWebhookUrl);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? await import("https") : await import("http");

    await new Promise<void>((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = lib.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Discord webhook returned ${res.statusCode}`));
        }
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point (called by entrypoint.sh with --register)
// ---------------------------------------------------------------------------
if (require.main === module) {
  const tracker = new CostTracker();
  tracker.register();
}
