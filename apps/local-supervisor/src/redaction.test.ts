import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REDACTED_VALUE, redactJson, redactText } from './redaction';

test('redacts common provider credentials and sensitive structured fields', () => {
	const text = 'glpat-abcdefghij0123456789 xoxb-1234567890-abcdefghij npm_abcdefghij0123456789';
	const redactedText = redactText(text);
	assert.equal(redactedText.value.includes('glpat-abcdefghij0123456789'), false);
	assert.equal(redactedText.value.includes('xoxb-1234567890-abcdefghij'), false);
	assert.equal(redactedText.value.includes('npm_abcdefghij0123456789'), false);

	const redactedJson = redactJson({ privateKey: 'private-key-material', clientSecret: 'client-secret-material', refresh_token: 'refresh-token-material' });
	assert.deepEqual(redactedJson.value, { privateKey: REDACTED_VALUE, clientSecret: REDACTED_VALUE, refresh_token: REDACTED_VALUE });
	assert.equal(redactedJson.replacements, 3);
});