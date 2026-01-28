import assert from 'node:assert/strict';
import test from 'node:test';

import { ValidationError } from '../src/lib/errors.js';
import mlString from '../src/lib/ml-string.js';

test('mlString.getSchema rejects HTML by default (strict mode)', () => {
  const schema = mlString.getSchema();

  assert.throws(
    () => {
      schema.validate({ en: '<p>Hello</p>' }, 'ml');
    },
    (error: unknown) => error instanceof ValidationError && /contains HTML tags/.test(error.message)
  );
});

test('mlString.getSchema allows HTML when allowHTML is true', () => {
  const schema = mlString.getSchema({ allowHTML: true });

  assert.doesNotThrow(() => {
    schema.validate({ en: '<p>Hello</p>' }, 'ml');
  });
});

test('mlString.getSchema rejects HTML when allowHTML is false', () => {
  const schema = mlString.getSchema({ allowHTML: false });

  assert.throws(
    () => {
      schema.validate({ en: '<em>Not allowed</em>' }, 'ml');
    },
    (error: unknown) => error instanceof ValidationError && /contains HTML tags/.test(error.message)
  );
});

test('mlString plain text schema enforces plain text for arrays', () => {
  const schema = mlString.getSafeTextSchema({ array: true });

  assert.doesNotThrow(() => {
    schema.validate({ en: ['One', 'Two'] }, 'ml');
  });

  assert.throws(
    () => {
      schema.validate({ en: ['Okay', '<b>nope</b>'] }, 'ml');
    },
    (error: unknown) => error instanceof ValidationError && /contains HTML tags/.test(error.message)
  );
});

test('mlString HTML schema permits HTML content', () => {
  const schema = mlString.getHTMLSchema();

  assert.doesNotThrow(() => {
    schema.validate({ en: '<section><p>Allowed</p></section>' }, 'ml');
  });
});

test('mlString rich text schema validates text/html pairing', () => {
  const schema = mlString.getRichTextSchema();

  assert.doesNotThrow(() => {
    schema.validate({
      text: { en: 'Markdown source' },
      html: { en: '<p>Rendered HTML</p>' },
    });
  });

  assert.throws(
    () => {
      schema.validate({
        text: { en: '<strong>bad</strong>' },
      });
    },
    (error: unknown) => error instanceof ValidationError && /contains HTML tags/.test(error.message)
  );

  assert.throws(
    () => {
      schema.validate({
        text: { en: 'Okay' },
        html: { en: '<p>Ok</p>' },
        preview: { en: 'Nope' },
      });
    },
    (error: unknown) => error instanceof ValidationError && /unsupported keys/.test(error.message)
  );
});

test('mlString.resolve uses precomputed fallbacks', () => {
  const baseMatch = mlString.resolve('pt-PT', {
    pt: 'Portuguese',
    en: 'English',
    ar: 'Arabic',
  });
  assert.deepStrictEqual(baseMatch, { str: 'Portuguese', lang: 'pt' });

  const undMatch = mlString.resolve('fr', {
    und: 'Default',
    en: 'English',
  });
  assert.deepStrictEqual(undMatch, { str: 'Default', lang: 'und' });

  const scriptMatch = mlString.resolve('mk', {
    uk: 'Ukrainian',
    de: 'Deutsch',
  });
  assert.deepStrictEqual(scriptMatch, { str: 'Ukrainian', lang: 'uk' });
});
