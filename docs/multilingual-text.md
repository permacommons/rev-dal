# Multilingual text

[README](../README.md) · [Models](models.md) · [Queries](queries.md)

The DAL provides runtime-validated multilingual string schemas via `mlString` (imported from `rev-dal/lib/ml-string`). These distinguish text fields that reject tag-like input from fields that allow HTML. They do not escape entities or sanitize HTML.

## Storage Format

The intended application convention is to store entity-escaped text (e.g.,
`My &amp; Co`, `I &lt;3 JS`). Callers must perform this escaping before passing
values to the DAL. Validation accepts both `A & B` and `A &amp; B` unchanged;
it neither enforces nor produces an entity-escaped representation.

- User types `A & B` → caller escapes it to `A &amp; B` → DAL stores `{ en: "A &amp; B" }`
- To preserve literal `I <3 JS`, the caller must escape it to `I &lt;3 JS` before validation; the unescaped input is rejected by the tag-stripping check.
- To remove external markup, callers may explicitly use `stripHTML()` before escaping and storing the result. Validation itself rejects markup rather than removing it.
- For plain text contexts (emails, exports), decode entities with `decodeHTML()` from the `entities` package when the application follows the escaped-storage convention.

## Schema Methods

**Text with tag rejection** – For labels, titles, names, descriptions

```ts
import mlString from 'rev-dal/lib/ml-string';

const thingManifest = {
  hasRevisions: true as const,
  schema: {
    label: mlString.getSafeTextSchema({ maxLength: 256 }),
    aliases: mlString.getSafeTextSchema({ array: true, maxLength: 256 }),
  },
  // ... other fields
} as const satisfies ModelManifest;
```

Throws `ValidationError` whenever `striptags(value) !== value`, including for
some literal angle-bracket text such as `I <3 JS`. This check does not decode
entities: `&lt;b&gt;Title&lt;/b&gt;` passes unchanged. Strings that pass validation
are returned unchanged, including raw ampersands and quotes. Passing validation
alone does not guarantee safe insertion into an HTML text or attribute context.
The same check applies to each string when `array: true`.

**HTML Content** – For cached rendered markdown output

```ts
const reviewManifest = {
  hasRevisions: true as const,
  schema: {
    html: mlString.getHTMLSchema(),
  },
  // ... other fields
} as const satisfies ModelManifest;
```

Permits full HTML markup without sanitizing it. Use only for content sanitized by the caller.

**Rich Text (Nested)** – For fields storing both markdown source and cached HTML

```ts
const teamManifest = {
  hasRevisions: true as const,
  schema: {
    description: mlString.getRichTextSchema(),
    // Expects: { text: { en: "markdown" }, html: { en: "<p>HTML</p>" } }
  },
  // ... other fields
} as const satisfies ModelManifest;
```

Validates nested structure: `text` uses the same tag-rejection check as
`getSafeTextSchema()`, and `html` may contain tags. Neither branch transforms
entities or sanitizes content.

## Template Rendering

```handlebars
{{!-- Plain text (entity-escaped at storage) --}}
<h1>{{mlSafeText review.title}}</h1>
<meta content="{{mlSafeText thing.label false}}" />

{{!-- Pre-rendered HTML --}}
<div>{{{mlHTML review.html}}}</div>
<div>{{{mlHTML team.description.html}}}</div>
```

These are application-provided helpers, not exports of rev-dal. In the consuming
applications they support language fallbacks and optional language indicators.
Rendering must account for the storage convention and output context, including
attribute quoting; DAL validation alone is not an HTML escaping guarantee.

## Security Model

Responsibilities when using the escaped-storage convention:

1. **Application input handling** – Adapters/forms escape text entities before writes and sanitize HTML content separately.
2. **DAL validation** – Text schemas reject values changed by `striptags`; HTML schemas allow markup. Neither escapes entities.
3. **Application rendering** – Templates/helpers handle text and sanitized HTML according to their storage format and output context.
4. **Application user feedback** – Middleware may convert validation errors to localized messages; rev-dal does not supply this middleware.

## Helper Methods

```ts
// Resolve translation with fallbacks
const resolved = mlString.resolve('de', thing.label);
// Returns: { str: "Label text", lang: "en" }

// Resolve with metadata (preferred languages + available languages)
const resolvedWithMetadata = mlString.resolveWithMetadata(['de', 'en'], thing.label);

// Strip HTML from external data
const cleaned = mlString.stripHTML({ en: '<b>Bold</b> text' });
// Returns: { en: 'Bold text' }

// Build JSONB query predicates
const query = mlString.buildQuery('label', 'en', searchTerm, 'ILIKE');
// Returns: "label->>'en' ILIKE $1"
```

`stripHTML()` decodes entities first, then strips tags, and does not re-escape
the result. For example, both `<b>Title</b>` and
`&lt;b&gt;Title&lt;/b&gt;` become `Title`: escaped literal markup is removed too.
`A &amp; B` becomes `A & B`, and `I <3 JS` becomes `I ` under the stripping
library's rules. It is therefore a lossy cleanup helper, not a way to preserve
arbitrary literal text. Escape its output before storage if your application
uses the escaped-storage convention. `stripHTMLFromArray()` applies this helper
to each multilingual object; `stripHTMLFromArrayValues()` uses the same
decode-then-strip order for each string in multilingual array values.

## Language Provider

`mlString` relies on a language provider with these methods:

```ts
interface DalLanguageProvider {
  getValidLanguagesAndUndetermined(): string[];
  getFallbacks(lang: string): string[];
}
```

If you don't call `setLanguageProvider`, rev-dal uses a superset of the language
lists currently used in lib.reviews and agpwiki. Apps that require strict language
validation should set their own provider.
