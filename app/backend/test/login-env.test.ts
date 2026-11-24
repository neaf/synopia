import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, fallbackPath, loadLoginEnv, mergeEnv, parseEnv0, LOGIN_ENV_FLAG } from '../src/login-env.ts';
import { batEnv } from '../src/preview.ts';

// Made-up `env -0` output, with noise a login shell may print before the marker.
const sample = [
  'Welcome to the shell\nPATH=/noise/before/marker',
  '__SYNOPIA_ENV_BEGIN__',
  'PATH=/opt/homebrew/bin:/home/u/.asdf/shims:/usr/bin:/bin',
  'MANPATH=/opt/homebrew/share/man:',
  'HOMEBREW_PREFIX=/opt/homebrew',
  'LANG=en_GB.UTF-8',
  'LC_ALL=en_GB.UTF-8',
  'LC_CTYPE=UTF-8',
  'SSH_AUTH_SOCK=/tmp/agent.sock',
  'ASDF_DATA_DIR=/home/u/.asdf',
  'GITHUB_TOKEN=made-up-secret',
  'AWS_SECRET_ACCESS_KEY=made-up',
  'LCX=no',
  'PS1=multi\nline=prompt',
  '=bare',
  '',
].join('\0');

test('login env: only the allow-list, after the marker', () => {
  assert.deepEqual(parseEnv0(sample), {
    PATH: '/opt/homebrew/bin:/home/u/.asdf/shims:/usr/bin:/bin',
    MANPATH: '/opt/homebrew/share/man:',
    HOMEBREW_PREFIX: '/opt/homebrew',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'en_GB.UTF-8',
    LC_CTYPE: 'UTF-8',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    ASDF_DATA_DIR: '/home/u/.asdf',
  });
  assert.equal(allowed('TOKEN'), false);
  assert.equal(allowed('LC_MESSAGES'), true);
  assert.deepEqual(parseEnv0('PATH=/a\0HOME=/h\0'), { PATH: '/a' }); // no marker: the whole output
});

test('login env: merge keeps the current PATH folders the login one lacks', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/extra', HOME: '/h', LANG: 'C' };
  mergeEnv(env, { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'en_GB.UTF-8' });
  assert.deepEqual(env, { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/extra', HOME: '/h', LANG: 'en_GB.UTF-8' });
});

test('login env: the fallback prepends Homebrew, the asdf shims and the node folder once', () => {
  assert.equal(fallbackPath({ PATH: '/usr/bin:/bin:/usr/local/bin' }, '/n/bin', '/home/u'),
    '/opt/homebrew/bin:/home/u/.asdf/shims:/n/bin:/usr/bin:/bin:/usr/local/bin');
  assert.equal(fallbackPath({ ASDF_DATA_DIR: '/d' }, '/n/bin', '/home/u'), '/opt/homebrew/bin:/usr/local/bin:/d/shims:/n/bin');
});

test('login env: load merges, falls back on failure, and runs once', async () => {
  const events: string[] = [];
  const log = (e: string, f?: Record<string, unknown>) => events.push(`${e} ${f?.how}`);
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
  let shellSeen = '';
  assert.equal(await loadLoginEnv({ env, log, capture: async (sh) => { shellSeen = sh; return sample; } }), 'login');
  assert.equal(shellSeen, '/bin/zsh');
  assert.equal(env.PATH, '/opt/homebrew/bin:/home/u/.asdf/shims:/usr/bin:/bin');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env[LOGIN_ENV_FLAG], '1');
  assert.equal(await loadLoginEnv({ env, log, capture: async () => { throw new Error('not called'); } }), 'skipped');

  const bare: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/home/u' };
  assert.equal(await loadLoginEnv({ env: bare, log, capture: async () => null, nodeDir: '/n/bin' }), 'fallback');
  assert.match(bare.PATH ?? '', /^\/opt\/homebrew\/bin:\/usr\/local\/bin:.*\/\.asdf\/shims:\/n\/bin:\/usr\/bin:\/bin$/);
  assert.deepEqual(events, ['env.login login', 'env.login fallback']);
});

test('preview: bat always runs with COLORTERM=truecolor', () => {
  assert.equal(batEnv({ PATH: '/x' }).COLORTERM, 'truecolor');
  assert.equal(batEnv({ COLORTERM: '' }).COLORTERM, 'truecolor');
});
