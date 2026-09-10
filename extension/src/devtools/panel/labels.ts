/** Human-readable strings shared by more than one component. */

import type { BodyMatchMode, HttpMethod, InactiveReason } from '@network-mock/shared';

export const METHODS: (HttpMethod | '*')[] = [
  '*',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

export const REASON_TEXT: Record<InactiveReason, string> = {
  'workspace-disabled': 'Mocking is switched off',
  'tab-not-targeted': 'This tab is not being mocked',
  'folder-disabled': 'A folder above it is disabled',
  'mock-disabled': 'This mock is disabled',
  'tag-disabled': 'A tag on it is disabled',
};

export const BODY_MODE_LABEL: Record<BodyMatchMode, string> = {
  contains: 'contains',
  equals: 'equals',
  regex: 'matches regex',
  'json-subset': 'JSON contains',
};

export const BODY_MODE_HINT: Record<BodyMatchMode, string> = {
  contains: 'Fires when the request body contains this text anywhere.',
  equals: 'Fires when the request body is exactly this, ignoring leading and trailing space.',
  regex: 'Fires when this unanchored JavaScript regular expression matches the request body.',
  'json-subset':
    'Fires when the request body is JSON containing every key and value written here. Extra keys in the request are ignored, so this survives timestamps and correlation ids.',
};

/** Reason phrases for the statuses worth naming in a picker. */
export const COMMON_STATUSES: [number, string][] = [
  [200, 'OK'],
  [201, 'Created'],
  [204, 'No Content'],
  [301, 'Moved Permanently'],
  [302, 'Found'],
  [304, 'Not Modified'],
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [409, 'Conflict'],
  [422, 'Unprocessable Entity'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
  [504, 'Gateway Timeout'],
];

export function statusClass(status: number): string {
  if (status >= 500) return 's-5xx';
  if (status >= 400) return 's-4xx';
  if (status >= 300) return 's-3xx';
  if (status >= 200) return 's-2xx';
  return 's-1xx';
}
