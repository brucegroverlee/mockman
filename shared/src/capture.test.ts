import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAPTURE_BODY_LIMIT, isCapturableContentType, shouldCaptureResponse } from './capture.ts';

test('text payloads a mock could plausibly be edited from are capturable', () => {
  for (const type of [
    'application/json',
    'application/json; charset=utf-8',
    'application/vnd.api+json',
    'application/graphql-response+json',
    'text/plain',
    'text/html; charset=utf-8',
    'application/xml',
    'text/javascript',
    'application/x-www-form-urlencoded',
  ]) {
    assert.equal(isCapturableContentType(type), true, type);
  }
});

test('binary and opaque payloads are not', () => {
  for (const type of [
    'image/png',
    'font/woff2',
    'video/mp4',
    'audio/mpeg',
    'application/octet-stream',
    'application/pdf',
    'application/wasm',
  ]) {
    assert.equal(isCapturableContentType(type), false, type);
  }
});

test('a response that does not say what it is, is left alone', () => {
  assert.equal(isCapturableContentType(undefined), false);
  assert.equal(isCapturableContentType(''), false);
});

test('the content type is matched however the server cased it', () => {
  assert.equal(shouldCaptureResponse({ 'Content-Type': 'Application/JSON' }), true);
  assert.equal(shouldCaptureResponse({ 'CONTENT-TYPE': 'application/json' }), true);
});

test('a declared length over the cap is rejected before anything is buffered', () => {
  const headers = {
    'content-type': 'application/json',
    'content-length': String(CAPTURE_BODY_LIMIT + 1),
  };
  assert.equal(shouldCaptureResponse(headers), false);
});

test('a length at the cap is still worth keeping', () => {
  assert.equal(
    shouldCaptureResponse({
      'content-type': 'application/json',
      'content-length': String(CAPTURE_BODY_LIMIT),
    }),
    true,
  );
});

test('a missing or unparseable length does not disqualify a response', () => {
  // Absent for anything chunked or compressed, which is most JSON APIs, so the
  // real bound is enforced by the reader as the body arrives.
  assert.equal(shouldCaptureResponse({ 'content-type': 'application/json' }), true);
  assert.equal(
    shouldCaptureResponse({ 'content-type': 'application/json', 'content-length': 'weird' }),
    true,
  );
});

test('a stream is never captured, however textual it claims to be', () => {
  // `text/event-stream` would otherwise pass the `text/` rule, and a stream has
  // no end: buffering one to measure it grows for as long as the page is open.
  assert.equal(isCapturableContentType('text/event-stream'), false);
  assert.equal(isCapturableContentType('text/event-stream; charset=utf-8'), false);
  assert.equal(isCapturableContentType('multipart/x-mixed-replace; boundary=frame'), false);
});
