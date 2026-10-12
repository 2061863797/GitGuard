/**
 * src/analysis/semantic/typesafe-provider.ts
 * TypeSafeSystemOneProvider implementing the official TypeSafe System One / Jev API.
 * Communicates with POST https://api.typesafe.ai/v1/systemone using the questions map
 * and answers map schema. Fails closed (no fallback) and retries transient errors.
 */

import type { EvaluationContext } from '../../types/context.js';
import { GITGUARD_VERSION } from '../../version.js';
import type {
  DecisionProvider,
  SemanticQuestion,
  SemanticDecision,
  ProviderMetadata,
  SemanticRunReport,
} from '../../types/provider.js';
import { ProviderError, SecurityViolationError, ConfigurationError } from '../../types/errors.js';

/**
 * Configuration options for TypeSafeSystemOneProvider.
 */
export interface TypeSafeProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * TypeSafe System One API question definition (noul = calibrated yes/no probability).
 */
interface TypeSafeQuestionPayload {
  type: 'noul';
  instructions: string;
}

/**
 * TypeSafe System One API answer item definition.
 */
interface TypeSafeAnswerItem {
  noul?: number;
  probability?: number;
  confidence?: number;
  rationale?: string;
}

function assertValidAnswer(question: SemanticQuestion, answer: unknown): asserts answer is TypeSafeAnswerItem {
  const invalid = (reason: string): never => {
    throw new Error(`Malformed System One answer for ${question.id}: ${reason}`);
  };
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) invalid('expected an object');
  const item = answer as TypeSafeAnswerItem;
  if (item.confidence !== undefined &&
      (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) {
    invalid('confidence must be between 0 and 1');
  }
  const probability = item.noul ?? item.probability;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    invalid('probability must be between 0 and 1');
  }
}

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * System One / Jev decision provider with official schema alignment and
 * 429/529 exponential retry. Missing keys and failed requests raise ProviderError.
 */
export class TypeSafeSystemOneProvider implements DecisionProvider {
  public readonly name: string = 'typesafe';

  private apiKey?: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
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
      'https://api.typesafe.ai';

    try {
      const url = new URL(this.baseUrl);
      const isHttp = url.protocol === 'http:';
      const isHttps = url.protocol === 'https:';
      const host = url.hostname.toLowerCase();
      const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';

      if (!isHttps && !(isHttp && isLoopback)) {
        throw new SecurityViolationError(
          `Insecure HTTP baseUrl is forbidden for remote host '${host}'. TypeSafe API credentials and code context require HTTPS.`
        );
      }
    } catch (err: any) {
      if (err instanceof SecurityViolationError) throw err;
      throw new ConfigurationError(
        `Invalid TypeSafe baseUrl provided: "${this.baseUrl}". Must be a valid absolute URL (e.g. https://api.typesafe.ai/v1).`
      );
    }

    // Use official recommended alias 'jev-latest' as default model
    this.model = options?.model || 'jev-latest';
    this.timeoutMs = options?.timeoutMs ?? 15000;
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
   * Evaluates semantic questions and returns a run report with provider metadata.
   */
  public async evaluateWithReport(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticRunReport> {
    if (!this.apiKey || this.apiKey.trim() === '') {
      throw new ProviderError(
        'TYPESAFE_API_KEY is not set. Semantic questions require the TypeSafe API; set the key or ask no questions.',
        this.name
      );
    }

    const startTime = Date.now();
    try {
      const { decisions, effectiveModel } = await this.callSystemOneApi(context, questions);
      const metadata: ProviderMetadata = {
        provider: this.name,
        requestedModel: this.model,
        effectiveModel,
        latencyMs: Date.now() - startTime,
        questionsCount: questions.length,
      };
      for (const d of decisions) {
        d.metadata = metadata;
      }
      return { decisions, metadata };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError(`TypeSafe System One API request failed: ${message}`, this.name);
    }
  }

  /**
   * Dispatches evaluation batch to the official TypeSafe System One endpoint.
   * Path: POST /v1/systemone (or normalized relative to baseUrl).
   */
  private async callSystemOneApi(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<{ decisions: SemanticDecision[]; effectiveModel: string }> {
    // Canonical endpoint resolution for TypeSafe System One
    const base = this.baseUrl.replace(/\/+$/, '');
    let endpoint: string;
    if (base.endsWith('/v1/systemone')) {
      endpoint = base;
    } else if (base.endsWith('/systemone')) {
      endpoint = base;
    } else if (base.endsWith('/v1')) {
      endpoint = `${base}/systemone`;
    } else {
      endpoint = `${base}/v1/systemone`;
    }

    // 1. Build questions map per official System One specification
    const questionsMap: Record<string, TypeSafeQuestionPayload> = {};
    for (const q of questions) {
      questionsMap[q.id] = { type: 'noul', instructions: q.prompt };
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
        diff: context.diff?.raw || '',
        insertions: context.diff?.insertions ?? 0,
        surroundingCode: (context.files || []).flatMap((f) =>
          (f.spans || []).map((s) => ({
            path: f.path,
            startLine: s.startLine,
            endLine: s.endLine,
            code: s.code,
          }))
        ),
        relatedTests: (context.relatedTests || []).map((t) => ({
          testPath: t.testPath,
          relatedSourcePath: t.relatedSourcePath,
          modifiedInDiff: t.modifiedInDiff,
          contentSnippet: t.contentSnippet ? t.contentSnippet.slice(0, 2000) : '',
        })),
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
            'User-Agent': `GitGuard/${GITGUARD_VERSION}`,
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
          decisions?: Array<TypeSafeAnswerItem & { id: string }>;
        };

        const effectiveModel = data.model || this.model;

        // Accept the official answers map and the legacy decisions array only when every answer is valid.
        let answers: Record<string, TypeSafeAnswerItem>;
        if (data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers)) {
          answers = data.answers;
        } else if (Array.isArray(data.decisions)) {
          answers = Object.fromEntries(data.decisions.map((decision) => [decision.id, decision]));
        } else {
          throw new Error('Malformed System One response: missing answers map');
        }
        for (const question of questions) {
          if (!Object.hasOwn(answers, question.id)) {
            throw new Error(`System One response missing answer for required question: ${question.id}`);
          }
          assertValidAnswer(question, answers[question.id]);
        }

        const decisions: SemanticDecision[] = questions.map((q) => {
          const ans = answers[q.id]!;
          return {
            id: q.id,
            probability: (ans.noul ?? ans.probability)!,
            confidence: ans.confidence,
            provider: this.name,
            rationale: ans.rationale,
          };
        });

        return { decisions, effectiveModel };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Retry transient network errors, not deterministic HTTP or response-schema errors.
        const isNonRetryableClientError = /HTTP 4\d\d|Malformed System One|System One response missing answer/.test(lastError.message);
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
