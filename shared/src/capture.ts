/**
 * The policy for keeping a real response body around so "mock it" can pre-fill
 * from it.
 *
 * It lives in `shared` because two contexts have to agree on it exactly: the
 * page-world interceptor decides whether to capture, and the service worker
 * decides how much to keep. A drifting duplicate would show up as a "mock it"
 * button that promises a body and then hands over an empty one.
 *
 * The rules are deliberately conservative. Capturing means buffering bytes the
 * page did not ask us to buffer, in a service worker that outlives the page, so
 * anything that is not plainly a text payload someone might paste into a mock is
 * left alone.
 */

/**
 * The largest body worth keeping, per request.
 *
 * Not a truncation limit — a half a JSON document is not a usable starting point
 * for a mock, it is a syntax error waiting to be discovered later. Anything over
 * this is skipped entirely and the row reports no body, which is at least
 * honest.
 */
export const CAPTURE_BODY_LIMIT = 512 * 1024;

/**
 * Content types worth capturing.
 *
 * Anything a human could reasonably edit in the panel's payload editor: JSON
 * (including the `+json` suffix family and GraphQL), anything `text/*`, XML,
 * JavaScript and form encodings. Images, fonts, media and `octet-stream` are
 * excluded — they cannot be mocked usefully from a text editor and they are
 * exactly the responses large enough to make buffering hurt.
 *
 * An **empty or missing** content type is not captured. A response that declines
 * to say what it is is not one we want to buffer on spec.
 */
export function isCapturableContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();

  // Excluded ahead of everything else, because `text/event-stream` would
  // otherwise sail through on the `text/` rule. A stream has no end to wait for:
  // buffering one to see how big it gets is a memory leak that grows for as long
  // as the page stays open. The panel mocks SSE from a body you write, not from a
  // recording of one.
  if (type.includes('event-stream') || type.startsWith('multipart/')) return false;

  return (
    type.includes('json') ||
    type.includes('graphql') ||
    type.startsWith('text/') ||
    type.includes('xml') ||
    type.includes('javascript') ||
    type.includes('ecmascript') ||
    type.includes('x-www-form-urlencoded')
  );
}

/**
 * Whether a response is worth capturing, judged from its headers alone.
 *
 * `content-length` is checked here so an oversized body is rejected *before* it
 * is buffered rather than after. It is frequently absent (any chunked or
 * compressed response), which is why the length is checked again once the text
 * is actually in hand.
 */
export function shouldCaptureResponse(headers: Record<string, string>): boolean {
  const lookup = (name: string): string | undefined => {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) return value;
    }
    return undefined;
  };

  if (!isCapturableContentType(lookup('content-type'))) return false;

  const declared = Number(lookup('content-length'));
  return !(Number.isFinite(declared) && declared > CAPTURE_BODY_LIMIT);
}
