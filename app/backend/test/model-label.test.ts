// The header's model name before the folder's menu arrives (md.js modelLabel), run in a vm as a classic script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(import.meta.dirname, '..', '..', 'web', 'js', 'md.js'), 'utf8') + '\n;globalThis.modelLabel = modelLabel;', ctx);
const modelLabel = (ctx as unknown as { modelLabel: (id: unknown) => string }).modelLabel;

test('model ids read as names', () => {
  const cases: [unknown, string][] = [
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['eu.anthropic.claude-haiku-5-5', 'Claude Haiku 5.5'],
    ['us.anthropic.claude-opus-5-5-v1:0', 'Claude Opus 5.5'],
    ['global.anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['anthropic.claude-haiku-5-5', 'Claude Haiku 5.5'],
    ['claude-opus-5-5[1m]', 'Claude Opus 5.5 (1M context)'],
    ['eu.anthropic.claude-sonnet-5-5[1M]', 'Claude Sonnet 5.5 (1M context)'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['claude-opus-4-1@20250805', 'Claude Opus 4.1'],
    ['claude-3-5-sonnet-20241022', 'Claude Sonnet 3.5'],
    ['claude-opus-5', 'Claude Opus 5'],
    ['arn:aws:bedrock:eu-west-1:123:inference-profile/eu.anthropic.claude-opus-5-5', 'Claude Opus 5.5'],
    ['haiku', 'Claude Haiku'],
    ['sonnet[1m]', 'Claude Sonnet (1M context)'],
  ];
  for (const [id, want] of cases) assert.equal(modelLabel(id), want, String(id));
});

test('no id reads Default, an unknown one stays as it is', () => {
  assert.equal(modelLabel(undefined), 'Default');
  assert.equal(modelLabel(''), 'Default');
  assert.equal(modelLabel('gpt-x'), 'gpt-x');
  assert.equal(modelLabel('my-proxy-model'), 'my-proxy-model');
});
