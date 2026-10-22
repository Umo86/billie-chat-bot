import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { aiProvider } from "@/lib/config";
import type { PromptEmail, PromptPassage } from "./prompts";
import { fakeStructured } from "./fake";

/**
 * One way to ask Claude for structured JSON, with the reliability rules in
 * one place: SDK retries with backoff (2), a 45-second timeout, then one try
 * on the fallback model, refusals and cut-off replies reported as errors,
 * and token usage returned for the daily cap and Reports.
 */
export type StructuredCall = {
  purpose: "answer" | "email_tag" | "email_draft";
  model: string;
  fallbackModel?: string;
  /** Instructions: who Billie is and the rules. */
  system: string;
  /** Knowledge passages, sent as a cached block (identical across questions when small). */
  knowledge?: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  /** For the stand-in provider only: the inputs it answers from. Ignored by Claude. */
  fake: FakeContext;
};

export type FakeContext =
  | { purpose: "answer"; question: string; passages: PromptPassage[]; alwaysHuman: string[] }
  | { purpose: "email_tag"; email: PromptEmail; alwaysHuman: string[] }
  | { purpose: "email_draft"; email: PromptEmail; passages: PromptPassage[]; signature: string };

export type Usage = { inputTokens: number; outputTokens: number; cachedTokens: number };

export type StructuredResult = { json: unknown; model: string; usage: Usage; latencyMs: number };

export type AiErrorCode =
  | "not_configured"
  | "unavailable"
  | "refused"
  | "invalid_output"
  | "cap_reached";

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: 45_000,
  });
  return client;
}

/** Errors worth one more try on the other model (overload, outage, network); not bad requests or keys. */
export function worthFallback(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const s = err.status ?? 0;
    return s === 404 || s === 408 || s === 429 || s >= 500;
  }
  return false;
}

async function callAnthropic(call: StructuredCall, model: string): Promise<StructuredResult> {
  const started = Date.now();
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: call.system }];
  if (call.knowledge) {
    system.push({ type: "text", text: call.knowledge, cache_control: { type: "ephemeral" } });
  }
  const res = await anthropic().messages.create({
    model,
    max_tokens: call.maxTokens,
    system,
    messages: [{ role: "user", content: call.user }],
    output_config: { format: { type: "json_schema", schema: call.schema } },
  });
  if (res.stop_reason === "refusal") throw new AiError("refused", "Claude declined to answer");
  if (res.stop_reason === "max_tokens") throw new AiError("invalid_output", "The reply was cut off");
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError("invalid_output", "The reply wasn't valid JSON");
  }
  return {
    json,
    model: res.model ?? model,
    usage: {
      inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
      cachedTokens: res.usage.cache_read_input_tokens ?? 0,
    },
    latencyMs: Date.now() - started,
  };
}

export async function structured(call: StructuredCall): Promise<StructuredResult> {
  const provider = aiProvider();
  if (provider === "fake") {
    const started = Date.now();
    return {
      json: fakeStructured(call.fake),
      model: "stand-in",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      latencyMs: Date.now() - started,
    };
  }
  if (provider === "none") {
    throw new AiError("not_configured", "ANTHROPIC_API_KEY is not set");
  }
  try {
    return await callAnthropic(call, call.model);
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (call.fallbackModel && call.fallbackModel !== call.model && worthFallback(err)) {
      console.warn(`Claude ${call.model} failed (${describe(err)}); trying ${call.fallbackModel}`);
      try {
        return await callAnthropic(call, call.fallbackModel);
      } catch (err2) {
        if (err2 instanceof AiError) throw err2;
        throw new AiError("unavailable", describe(err2));
      }
    }
    throw new AiError("unavailable", describe(err));
  }
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.status ?? "network"} ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
