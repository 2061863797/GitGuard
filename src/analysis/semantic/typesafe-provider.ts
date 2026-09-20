/**
 * src/analysis/semantic/typesafe-provider.ts
 * TypeSafeSystemOneProvider implementing System One / Jev probabilistic evaluations.
 * Provides transparent, automatic fallback to DeterministicMockProvider when credentials
 * are absent or when network requests fail.
 */

import type { EvaluationContext } from '../../types/context.js';
import type {
  DecisionProvider,
  SemanticQuestion,
  SemanticDecision,
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
  fetchFn?: typeof fetch;
}

/**
 * System One / Jev decision provider with automatic fallback.
 */
export class TypeSafeSystemOneProvider implements DecisionProvider {
  public readonly name: string = 'typesafe';

  private apiKey?: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private fallbackProvider: DecisionProvider;
  private strict: boolean;
  private fetchFn: typeof fetch;

  constructor(options?: TypeSafeProviderOptions) {
    this.apiKey =
      options?.apiKey ||
      process.env.TYPESAFE_API_KEY ||
      process.env.JEV_API_KEY;
    this.baseUrl =
      options?.baseUrl ||
      process.env.TYPESAFE_BASE_URL ||
      'https://api.typesafe.ai/v1';
    this.model = options?.model || 'jev-1';
    this.timeoutMs = options?.timeoutMs ?? 15000;
    this.fallbackProvider =
      options?.fallbackProvider ?? new DeterministicMockProvider();
    this.strict = options?.strict ?? false;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  /**
   * Returns whether the TypeSafe provider has valid credentials available.
   */
  public async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Evaluates semantic questions via TypeSafe System One API,
   * automatically falling back to DeterministicMockProvider if unavailable.
   */
  public async evaluate(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticDecision[]> {
    // If no API key configured, transparently delegate to fallback mock provider
    if (!this.apiKey || this.apiKey.trim() === '') {
      if (this.strict) {
        throw new ProviderError(
          'TypeSafe API key is not configured and strict mode is enabled',
          this.name
        );
      }
      return this.fallbackProvider.evaluate(context, questions);
    }

    try {
      return await this.callTypeSafeApi(context, questions);
    } catch (err: unknown) {
      if (this.strict) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ProviderError(
          `TypeSafe System One API request failed: ${message}`,
          this.name
        );
      }

      // Transparent fallback on API or network error
      return this.fallbackProvider.evaluate(context, questions);
    }
  }

  /**
   * Dispatches evaluation batch to TypeSafe System One API endpoint.
   */
  private async callTypeSafeApi(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticDecision[]> {
    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/evaluations`;

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
      questions: questions.map((q) => ({
        id: q.id,
        primitive: q.type === 'boolean' ? 'noul' : q.type,
        prompt: q.prompt,
        choices: q.choices,
        levels: q.levels,
      })),
    };

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'GitGuard/0.1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutTimer);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ''}`
      );
    }

    const data = (await response.json()) as {
      decisions?: Array<{
        id: string;
        probability?: number;
        value?: string;
        score?: number;
        confidence?: number;
        rationale?: string;
      }>;
    };

    if (!data.decisions || !Array.isArray(data.decisions)) {
      throw new Error('Malformed API response: missing decisions array');
    }

    const resultMap = new Map(data.decisions.map((d) => [d.id, d]));

    // Map back into the exact questions order
    return questions.map((q) => {
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
  }
}
