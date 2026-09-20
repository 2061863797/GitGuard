/**
 * src/analysis/semantic/typesafe-provider.ts
 * TypeSafeSystemOneProvider implementing the official TypeSafe System One / Jev API.
 * Communicates with POST https://api.typesafe.ai/v1/systemone using the questions map
 * and answers map schema. Provides observable, transparent fallback and exponential retry.
 */

import type { EvaluationContext } from '../../types/context.js';
import type {
  DecisionProvider,
  SemanticQuestion,
  SemanticDecision,
  ProviderMetadata,
  SemanticRunReport,
} from '../../types/provider.js';
import { ProviderError } from '../../types/errors.js';
import { DeterministicMockProvider } from './mock-provider.js';

/**
 * Configuration options for TypeSafeSystemOneProvider.
 */
export interface TypeSafeProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fallbackProvider?: DecisionProvider;
  strict?: boolean;
  maxRetries?: number;
  retryBackoffMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * TypeSafe System One API question definition.
 */
interface TypeSafeQuestionPayload {
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  criteria?: Record<string, string> | Array<{ name: string; description: string; score?: number }>;
}

/**
 * TypeSafe System One API answer item definition.
 */
interface TypeSafeAnswerItem {
  type?: 'noul' | 'choice' | 'score';
  noul?: number;
  probability?: number;
  choice?: string;
  value?: string;
  score?: number;
  confidence?: number;
  rationale?: string;
  probabilities?: Record<string, number>;
}

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper to construct criteria for choice primitive.
 */
function buildChoiceCriteria(
  choices?: string[] | Array<{ value: string; description?: string }>
): Record<string, string> {
  const criteria: Record<string, string> = {};
  if (!choices || !Array.isArray(choices)) return criteria;

  for (const c of choices) {
    if (typeof c === 'string') {
      criteria[c] = c;
    } else if (c && typeof c === 'object') {
      criteria[c.value] = c.description || c.value;
    }
  }
  return criteria;
}

/**
 * Helper to construct criteria for score primitive.
 */
function buildScoreCriteria(
  levels?: Array<{ name: string; description: string; score?: number }>
): Array<{ name: string; description: string; score?: number }> {
  if (!levels || !Array.isArray(levels)) return [];
  return levels.map((lvl) => ({
    name: lvl.name,
    description: lvl.description,
    score: lvl.score,
  }));
}

/**
 * System One / Jev decision provider with official schema alignment,
 * 429/529 exponential retry, and observable fallback state.
 */
export class TypeSafeSystemOneProvider implements DecisionProvider {
  public readonly name: string = 'typesafe';

  private apiKey?: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private fallbackProvider: DecisionProvider;
  private strict: boolean;
  private maxRetries: number;
  private retryBackoffMs: number;
  private fetchFn: typeof fetch;

  constructor(options?: TypeSafeProviderOptions) {
    this.apiKey =
      options && 'apiKey' in options
        ? options.apiKey
        : (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY);
    this.baseUrl =
      options?.baseUrl ||
      process.env.TYPESAFE_BASE_URL ||
      'https://api.typesafe.ai/v1';
    // Use official recommended alias 'jev-latest' as default model
    this.model = options?.model || 'jev-latest';
    this.timeoutMs = options?.timeoutMs ?? 15000;
    this.fallbackProvider =
      options?.fallbackProvider ?? new DeterministicMockProvider();
    this.strict = options?.strict ?? false;
    this.maxRetries = options?.maxRetries ?? 2;
    this.retryBackoffMs = options?.retryBackoffMs ?? 50;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  /**
   * Returns whether the TypeSafe provider has credentials configured.
   */
  public async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Evaluates semantic questions via TypeSafe System One API,
   * returning explicit decisions with observability metadata.
   */
  public async evaluate(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticDecision[]> {
    const report = await this.evaluateWithReport(context, questions);
    return report.decisions;
  }

  /**
   * Evaluates semantic questions and returns a full run report including
   * provider metadata (effectiveProvider, fallback status, reason, latency).
   */
  public async evaluateWithReport(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticRunReport> {
    // 1. Check API Key presence
    if (!this.apiKey || this.apiKey.trim() === '') {
      if (this.strict) {
        throw new ProviderError(
          'TypeSafe API key is not configured and strict mode is enabled',
          this.name
        );
      }
      return this.delegateToFallback(
        context,
        questions,
        'MISSING_API_KEY: TYPESAFE_API_KEY is unset or empty'
      );
    }

    const startTime = Date.now();

    // 2. Call official TypeSafe System One endpoint with retry
    try {
      const { decisions, effectiveModel } = await this.callSystemOneApi(context, questions);
      const latencyMs = Date.now() - startTime;

      const metadata: ProviderMetadata = {
        requestedProvider: this.name,
        effectiveProvider: this.name,
        requestedModel: this.model,
        effectiveModel,
        fallback: false,
        latencyMs,
        questionsCount: questions.length,
      };

      // Attach metadata to each decision for tracing
      for (const d of decisions) {
        d.metadata = metadata;
      }

      return { decisions, metadata };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      if (this.strict) {
        throw new ProviderError(
          `TypeSafe System One API request failed: ${message}`,
          this.name
        );
      }

      return this.delegateToFallback(
        context,
        questions,
        `API_ERROR (${message})`,
        latencyMs
      );
    }
  }

  /**
   * Delegates evaluation to the fallback provider and attaches observable fallback metadata.
   */
  private async delegateToFallback(
    context: EvaluationContext,
    questions: SemanticQuestion[],
    reason: string,
    latencyMs = 0
  ): Promise<SemanticRunReport> {
    const fallbackDecisions = await this.fallbackProvider.evaluate(context, questions);
    const metadata: ProviderMetadata = {
      requestedProvider: this.name,
      effectiveProvider: this.fallbackProvider.name,
      requestedModel: this.model,
      effectiveModel: `${this.fallbackProvider.name}-heuristic`,
      fallback: true,
      fallbackReason: reason,
      latencyMs,
      questionsCount: questions.length,
    };

    for (const d of fallbackDecisions) {
      d.metadata = metadata;
    }

    return {
      decisions: fallbackDecisions,
      metadata,
    };
  }

  /**
   * Dispatches evaluation batch to the official TypeSafe System One endpoint.
   * Path: POST /v1/systemone (or normalized relative to baseUrl).
   */
  private async callSystemOneApi(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<{ decisions: SemanticDecision[]; effectiveModel: string }> {
    // Normalization: append /systemone if not already present
    const base = this.baseUrl.replace(/\/+$/, '');
    const endpoint = base.endsWith('/systemone')
      ? base
      : base.endsWith('/v1')
        ? `${base}/systemone`
        : `${base}/systemone`;

    // 1. Build questions map per official System One specification
    const questionsMap: Record<string, TypeSafeQuestionPayload> = {};
    for (const q of questions) {
      if (q.type === 'boolean') {
        questionsMap[q.id] = {
          type: 'noul',
          instructions: q.prompt,
        };
      } else if (q.type === 'choice') {
        questionsMap[q.id] = {
          type: 'choice',
          instructions: q.prompt,
          criteria: buildChoiceCriteria(q.choices),
        };
      } else if (q.type === 'score') {
        questionsMap[q.id] = {
          type: 'score',
          instructions: q.prompt,
          criteria: buildScoreCriteria(q.levels),
        };
      }
    }

    // 2. Build state payload
    const payload = {
      model: this.model,
      state: {
        task: context.task?.task || '',
        keywords: context.task?.keywords || [],
        files: (context.diff?.files || []).map((f) => ({
          path: f.newPath,
          oldPath: f.oldPath,
          status: f.status,
          binary: f.binary,
          additions: f.additions,
          deletions: f.deletions,
        })),
        diff: context.diff?.raw ? context.diff.raw.slice(0, 15000) : '',
        insertions: context.diff?.insertions ?? 0,
        deletions: context.diff?.deletions ?? 0,
        instructions: (context.instructions || []).map((i) => ({
          sourcePath: i.sourcePath,
          scope: i.scope,
          content: i.content.slice(0, 2000),
        })),
        metadata: {
          branch: context.repository?.branch,
          headSha: context.repository?.headSha,
        },
      },
      questions: questionsMap,
    };

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'GitGuard/0.2.0',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        // Handle rate limiting (429) and overload (529) with exponential backoff
        if (response.status === 429 || response.status === 529) {
          if (attempt < this.maxRetries) {
            let backoff = this.retryBackoffMs * Math.pow(2, attempt);
            const retryAfterHeader = response.headers?.get?.('retry-after');
            if (retryAfterHeader) {
              const seconds = parseFloat(retryAfterHeader);
              if (!isNaN(seconds) && seconds > 0) {
                backoff = Math.min(seconds * 1000, 30000);
              }
            }
            attempt++;
            await sleep(backoff);
            continue;
          }
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          const errorMsg = `HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`;
          // 5xx server errors (500, 502, 503, 504) are transient and retryable
          if (response.status >= 500 && attempt < this.maxRetries) {
            const backoff = this.retryBackoffMs * Math.pow(2, attempt);
            attempt++;
            await sleep(backoff);
            continue;
          }
          throw new Error(errorMsg);
        }

        const data = (await response.json()) as {
          model?: string;
          answers?: Record<string, TypeSafeAnswerItem>;
          decisions?: Array<{
            id: string;
            probability?: number;
            value?: string;
            score?: number;
            confidence?: number;
            rationale?: string;
          }>;
        };

        const effectiveModel = data.model || this.model;

        // Support official answers map schema
        if (data.answers && typeof data.answers === 'object') {
          const decisions: SemanticDecision[] = questions.map((q) => {
            const ans = data.answers![q.id];
            if (!ans) {
              return {
                id: q.id,
                probability: q.type === 'boolean' ? 0.5 : undefined,
                score: q.type === 'score' ? 0.5 : undefined,
                value: q.type === 'choice' ? 'unknown' : undefined,
                confidence: 0.5,
                provider: this.name,
                rationale: 'Question omitted in System One answer map; defaulted',
              };
            }

            const prob = ans.noul ?? ans.probability;
            const val = ans.choice ?? ans.value;
            const score = ans.score;
            const conf = ans.confidence ?? 0.9;

            return {
              id: q.id,
              probability: prob,
              value: val,
              score,
              confidence: conf,
              provider: this.name,
              rationale: ans.rationale,
            };
          });

          return { decisions, effectiveModel };
        }

        // Backward compatibility with decisions array if returned by mock servers
        if (Array.isArray(data.decisions)) {
          const resultMap = new Map(data.decisions.map((d) => [d.id, d]));
          const decisions: SemanticDecision[] = questions.map((q) => {
            const item = resultMap.get(q.id);
            if (!item) {
              return {
                id: q.id,
                probability: q.type === 'boolean' ? 0.5 : undefined,
                score: q.type === 'score' ? 0.5 : undefined,
                value: q.type === 'choice' ? 'unknown' : undefined,
                confidence: 0.5,
                provider: this.name,
                rationale: 'Question omitted in provider response; defaulted',
              };
            }
            return {
              id: item.id,
              probability: item.probability,
              value: item.value,
              score: item.score,
              confidence: item.confidence ?? 0.9,
              provider: this.name,
              rationale: item.rationale,
            };
          });
          return { decisions, effectiveModel };
        }

        throw new Error('Malformed System One response: missing answers map');
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Retry transient network errors (timeouts, aborts, connection reset), skip deterministic 4xx client errors
        const isNonRetryableClientError = /HTTP 4\d\d/.test(lastError.message);
        if (!isNonRetryableClientError && attempt < this.maxRetries) {
          const backoff = this.retryBackoffMs * Math.pow(2, attempt);
          attempt++;
          await sleep(backoff);
          continue;
        }
        break;
      } finally {
        clearTimeout(timeoutTimer);
      }
    }

    throw lastError || new Error('TypeSafe System One request failed after retries');
  }
}
