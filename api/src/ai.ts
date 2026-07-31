import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { db } from './db.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';
const MAX_QUERY_LENGTH = 500;
const MAX_REQUESTS_PER_MINUTE = 10;

type RateWindow = {
  startedAt: number;
  count: number;
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
};

type SearchPlan = {
  searchQuery: string;
  explanation: string;
};

const rateWindows = new Map<string, RateWindow>();

function consumeRateLimit(userId: string): boolean {
  const now = Date.now();
  const current = rateWindows.get(userId);

  if (!current || now - current.startedAt >= 60_000) {
    rateWindows.set(userId, { startedAt: now, count: 1 });
    return true;
  }

  if (current.count >= MAX_REQUESTS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

function cleanText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function parseSearchPlan(content: string, fallbackQuery: string): SearchPlan {
  const withoutFence = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(withoutFence) as Partial<SearchPlan>;
    const searchQuery = cleanText(typeof parsed.searchQuery === 'string' ? parsed.searchQuery : '', 200);
    const explanation = cleanText(typeof parsed.explanation === 'string' ? parsed.explanation : '', 240);

    return {
      searchQuery: searchQuery || fallbackQuery,
      explanation: explanation || 'Converted your request into a library search.',
    };
  } catch {
    return {
      searchQuery: fallbackQuery,
      explanation: 'AI could not refine the request, so the original wording was used.',
    };
  }
}

function openRouterError(status: number): { status: number; message: string } {
  switch (status) {
    case 401:
      return { status: 400, message: 'The OpenRouter API key is invalid. Update it in Settings → Integrations.' };
    case 402:
      return { status: 402, message: 'The OpenRouter account does not have enough credit for this request.' };
    case 429:
      return { status: 429, message: 'OpenRouter is rate limiting requests. Please try again shortly.' };
    case 503:
      return { status: 503, message: 'No compatible OpenRouter provider is currently available.' };
    default:
      return { status: 502, message: 'OpenRouter could not process the AI search request.' };
  }
}

export const aiPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/ai/search', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const rawQuery = (req.body as { query?: unknown } | null)?.query;
    if (typeof rawQuery !== 'string') {
      return reply.code(400).send({ ok: false, error: 'A search request is required.' });
    }

    const query = cleanText(rawQuery, MAX_QUERY_LENGTH + 1);
    if (!query) {
      return reply.code(400).send({ ok: false, error: 'A search request is required.' });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return reply.code(400).send({ ok: false, error: `Search requests are limited to ${MAX_QUERY_LENGTH} characters.` });
    }

    const keyResult = await db().query<{ openrouter_api_key: string | null }>(
      'SELECT openrouter_api_key FROM user_preferences WHERE user_id = $1',
      [req.user.userId]
    );
    const apiKey = keyResult.rows[0]?.openrouter_api_key?.trim();
    if (!apiKey) {
      return reply.code(400).send({
        ok: false,
        error: 'OpenRouter is not configured. Add an API key in Settings → Integrations.',
      });
    }

    if (!consumeRateLimit(req.user.userId)) {
      reply.header('Retry-After', '60');
      return reply.code(429).send({ ok: false, error: 'Too many AI searches. Please wait a minute and try again.' });
    }

    const model = process.env.AI_SEARCH_MODEL?.trim() || DEFAULT_MODEL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'MVBar AI Search',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 180,
          provider: {
            require_parameters: true,
            data_collection: 'deny',
          },
          messages: [
            {
              role: 'system',
              content: [
                'Convert a natural-language music request into a concise MVBar library search query.',
                'MVBar search understands artist, title, album and genre words; country names and aliases;',
                'specific years; and decades written as 50s through 2020s.',
                'Preserve named artists, albums and songs exactly. Remove conversational filler.',
                'Do not invent artists, titles, metadata or facts. Do not answer the request as a chat assistant.',
                'Examples:',
                '"find me some Polish rock from the eighties" -> "Polish rock 80s"',
                '"songs by Massive Attack for a quiet evening" -> "Massive Attack chill"',
                '"play Blue Monday" -> "Blue Monday".',
              ].join(' '),
            },
            { role: 'user', content: query },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'mvbar_search_plan',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  searchQuery: {
                    type: 'string',
                    description: 'A concise query for the MVBar library search engine.',
                  },
                  explanation: {
                    type: 'string',
                    description: 'A brief explanation of how the request was interpreted.',
                  },
                },
                required: ['searchQuery', 'explanation'],
                additionalProperties: false,
              },
            },
          },
        }),
      });

      if (!response.ok) {
        const mapped = openRouterError(response.status);
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          if (retryAfter) reply.header('Retry-After', retryAfter);
        }
        return reply.code(mapped.status).send({ ok: false, error: mapped.message });
      }

      const data = await response.json() as OpenRouterResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        return reply.code(502).send({ ok: false, error: 'OpenRouter returned an empty AI search response.' });
      }

      const plan = parseSearchPlan(content, query);
      return {
        ok: true,
        model,
        originalQuery: query,
        searchQuery: plan.searchQuery,
        explanation: plan.explanation,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return reply.code(504).send({ ok: false, error: 'The AI search request timed out.' });
      }

      app.log.error({ err: error }, 'AI search request failed');
      return reply.code(502).send({ ok: false, error: 'The AI search service could not be reached.' });
    } finally {
      clearTimeout(timeout);
    }
  });
});
