import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import type { ExtendedSamplingOptions } from '../lib/sampling-params.js';
import { proxyFetch } from '../lib/proxy.js';
import { providerTimeoutMs, streamStallTimeoutMs } from '../lib/provider-timeout.js';
import { extractThinkTagsFromStream } from '../lib/think-tags.js';

/** A provider HTTP error carrying the upstream status and, when the response
 *  included a Retry-After header, the parsed delay so the router can bench the
 *  key for at least that long. */
export interface ProviderHttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

/** Upper bound on a provider-supplied back-off. A malformed or hostile
 *  `Retry-After` (e.g. 99999999999) would otherwise bench a key effectively
 *  forever, since the value feeds the cooldown expiry directly. A day is longer
 *  than any real free-tier reset window, so clamping cannot mask a genuine hint. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 *  millisecond delay, clamped to MAX_RETRY_AFTER_MS. Returns undefined when
 *  absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.min(Math.max(0, when - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

/** Build an error for a non-OK upstream response, capturing the status and any
 *  Retry-After hint. Used by every provider adapter so the proxy can honor a
 *  provider's explicit back-off when it sets the cooldown. */
export function providerHttpError(res: Response, message: string): ProviderHttpError {
  const err = new Error(message) as ProviderHttpError;
  err.status = res.status;
  const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after'));
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

// Extended sampling knobs (top_k, seed, penalties, logit_bias, logprobs,
// response_format…) ride along via ExtendedSamplingOptions; adapters forward
// them per the platform policy in lib/sampling-params.ts.
export interface CompletionOptions extends ExtendedSamplingOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  /** Per-call HTTP timeout override. Not part of the OpenAI wire format (it is
   * stripped before the request body is built); used by the probe script so
   * NVIDIA's 15-60s serverless cold starts don't read as failures. */
  timeoutMs?: number;
  /** Abort signal for the gateway's OWN client (request socket closed). The
   * proxy surfaces thread it here so a disconnect cancels the upstream fetch
   * AND any in-progress body/stream read — tokens stop burning and the
   * in-flight lease frees immediately instead of when the read happens to
   * finish. Composed with the per-attempt timeout in fetchWithTimeout; never
   * serialized into the request body. */
  signal?: AbortSignal;
}

/** Per-call abort/timeout wiring for fetchWithTimeout. */
export interface ProviderFetchOptions {
  /** Client-disconnect signal, composed with the per-attempt timeout via
   * AbortSignal.any. Unlike the timeout it is never disarmed at headers, so it
   * also aborts body reads and stream iteration through undici. */
  signal?: AbortSignal;
  /** What the per-attempt timeout bounds:
   *  - 'headers' (default, historical): the abort timer dies the moment
   *    response HEADERS arrive — right for streams, whose body legitimately
   *    outlives any fixed deadline (readSseStream's stall watchdog owns
   *    mid-stream hangs, the client signal owns "nobody is listening").
   *  - 'request': the deadline stays armed across the body read too, so a 200
   *    whose body never finishes aborts at timeoutMs instead of hanging
   *    res.json() forever. Use for non-streaming calls, which read the whole
   *    body as one unit. */
  timeoutBounds?: 'headers' | 'request';
}

export interface KeyValidationFailure {
  valid: false;
  /** Provider-supplied reason suitable for health logs and the local keys UI. */
  error: string;
}

export type KeyValidationResult = boolean | KeyValidationFailure;

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;
  /** Providers whose free tier needs no API key (e.g. Kilo's anonymous gateway).
   * When true, the gateway stores a sentinel key row so routing still considers
   * the platform "configured", and the provider omits the Authorization header
   * on outgoing requests. Defaults to false; set by subclasses. */
  keyless = false;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult>;

  /**
   * Turn a conventional 401/403 validation response into a diagnostic result.
   * Providers still return a simple boolean when no useful error body exists,
   * but preserving the upstream message here lets the health service persist
   * and display the reason instead of reducing every failure to "invalid".
   */
  protected async validationResult(res: Response): Promise<KeyValidationResult> {
    if (res.status !== 401 && res.status !== 403) return true;

    let body: any = null;
    try {
      if (typeof (res as any).json === 'function') body = await res.json();
    } catch {
      // A status and provider name are still more useful than no reason.
    }

    const detail = [
      body?.error?.message,
      body?.errors?.[0]?.message,
      body?.message,
      body?.detail,
      body?.title,
      res.statusText,
    ].find((value) => typeof value === 'string' && value.trim().length > 0);

    return {
      valid: false,
      error: `${this.name} key validation failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    };
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    // Adapters that don't pass a timeout inherit the platform's env override
    // (PROVIDER_TIMEOUT_<PLATFORM>, issue #547) over the historical 15s.
    timeoutMs = providerTimeoutMs(this.platform, 15000),
    fetchOpts?: ProviderFetchOptions,
  ): Promise<Response> {
    const signals: AbortSignal[] = [];
    if (fetchOpts?.signal) signals.push(fetchOpts.signal);

    // timeoutMs <= 0 means "no timeout" (PROVIDER_TIMEOUT_<PLATFORM>=0).
    // setTimeout(abort, 0) would abort every request on the next macrotask.
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      signals.push(controller.signal);
      if (fetchOpts?.timeoutBounds === 'request') {
        // Whole-request deadline: stays armed across the body read, so a 200
        // whose body never finishes aborts res.json() at timeoutMs instead of
        // hanging forever. Never cleared — firing after the response is fully
        // consumed is a no-op — and unref'd so a spent request's leftover
        // deadline can't hold the process open.
        timer.unref?.();
      } else {
        // Historical header-only deadline: disarmed the moment response
        // HEADERS arrive (see finally). Streams need this — an SSE body
        // legitimately outlives any fixed deadline, and mid-stream hangs are
        // owned by the stall watchdog (readSseStream) + the client signal.
        headerTimer = timer;
      }
    }

    // Compose the per-attempt timeout with the client-disconnect signal.
    // Unlike the timeout, the client signal is never disarmed: undici ties it
    // to the whole request, so a disconnect also aborts body reads and stream
    // iteration, rejecting them with the marked reason from newClientAbortError.
    const signal = signals.length === 0
      ? init.signal ?? undefined
      : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      // requestType='chat' + timeoutMs makes the AbortError message read
      // `<platform>, chat, 15s` for triage from the requests.error column.
      return await proxyFetch(url, signal ? { ...init, signal } : init, this.platform, 'chat', timeoutMs);
    } finally {
      if (headerTimer !== undefined) clearTimeout(headerTimer);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * One reader.read() bounded by the mid-stream inactivity watchdog (#553).
   * Shared by readSseStream and adapters that parse their own wire format
   * (google.ts) so every stream gets the same stall semantics:
   * PROVIDER_STREAM_STALL_TIMEOUT_MS, default 90s, 0 disables. Client-abort
   * rejections pass through untouched — undici errors the body with the
   * request signal's reason, so a disconnect surfaces here as the marked
   * error from newClientAbortError, not as a stall.
   */
  protected async readWithStallTimeout<T>(
    read: () => Promise<T>,
    inactivityTimeoutMs: number,
  ): Promise<T> {
    if (inactivityTimeoutMs <= 0) return read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${this.name} stream stalled: no data for ${inactivityTimeoutMs}ms (timeout)`)),
          inactivityTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Shared SSE reader for OpenAI-wire streaming endpoints (#231 audit).
   *
   * Hardened against the upstream failure modes observed live:
   *  - Inactivity timeout: fetchWithTimeout's abort timer dies the moment
   *    response HEADERS arrive, so a provider that stalls mid-body used to
   *    hang the client forever. Each read now has its own deadline.
   *  - Abrupt EOF: a stream that ends without `[DONE]` AND without any
   *    `finish_reason` is a truncated generation, not a completion. It used
   *    to end the generator silently (truncation logged as success); it now
   *    throws a retryable error so the proxy can fail over or report it.
   *    Providers that skip `[DONE]` but do send a terminal finish_reason
   *    (several compat shims) still complete normally.
   *
   * Malformed data lines are skipped, matching previous behavior.
   *
   * The frames additionally pass through the inline `<think>` extractor
   * (lib/think-tags.ts): DeepSeek-style models that serialize their reasoning
   * trace INTO delta.content as a leading `<think>…</think>` block get it
   * moved to delta.reasoning_content, so downstream surfaces never render
   * thinking as answer text. Streams without the tag are forwarded verbatim.
   */
  protected async *readSseStream(
    res: Response,
    inactivityTimeoutMs?: number,
  ): AsyncGenerator<ChatCompletionChunk> {
    yield* extractThinkTagsFromStream(this.readSseFrames(res, inactivityTimeoutMs));
  }

  private async *readSseFrames(
    res: Response,
    // The 90s default was hardcoded and silently truncated slow streams — the
    // gateway ended them with an error frame plus a clean [DONE] that OpenAI
    // SDK clients swallow, so responses "just stopped" (issue #553). Operators
    // proxying slow free tiers can now raise it (or 0 to disable) via
    // PROVIDER_STREAM_STALL_TIMEOUT_MS.
    inactivityTimeoutMs = streamStallTimeoutMs(),
  ): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let sawFinishReason = false;

    try {
      while (true) {
        const { done, value } = await this.readWithStallTimeout(() => reader.read(), inactivityTimeoutMs);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          try {
            const chunk = JSON.parse(data) as ChatCompletionChunk;
            if (chunk.choices?.some(c => c.finish_reason != null)) sawFinishReason = true;
            yield chunk;
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    if (!sawFinishReason) {
      throw new Error(`${this.name} stream ended unexpectedly (no [DONE], no finish_reason) — connection reset or truncated upstream`);
    }
  }
}
