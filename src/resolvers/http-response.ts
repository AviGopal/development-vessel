import type { ResolverResult } from '../resolvers/types.js';

/**
 * Fetch https://httpbin.org/status/404 and return the page title text.
 * The pointer type is 'http_response'.
 */
export async function resolveHttpResponse(pointer: { type: string }): Promise<ResolverResult> {
  if (pointer.type !== 'http_response') {
    return { shape: 'http_response', body: 'Invalid pointer type' };
  }

  const url = 'https://httpbin.org/status/404';
  const response = await fetch(url);
  const html = await response.text();
  // Extract <title>...</title> from the HTML
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? 'No title found';
  return { shape: 'http_response', body: title };
}