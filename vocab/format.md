# Vocabulary Library Format

Each vocabulary file is a `.json` file following this schema.

## Schema

```json
{
  "id": "unique-id-for-this-wordlist",
  "name": "Human-readable name",
  "level": "A1 | A2 | B1 | B2 | C1 | C2 | mixed",
  "source": "Where this list comes from",
  "description": "Optional longer description",
  "words": [
    {
      "word": "the word or phrase",
      "pos": ["noun", "verb", "adj"],
      "examples": ["Optional example sentence 1.", "Optional example sentence 2."]
    }
  ]
}
```

## Field rules

- `id`: kebab-case, unique across all vocab files. Prefer `<source>-<level>-<year>` style.
- `level`: CEFR level string; use `"mixed"` when the list spans multiple levels.
- `pos`: list of part-of-speech abbreviations extracted from the source. Common values:
  - `n` = noun, `v` = verb, `adj` = adjective, `adv` = adverb
  - `det` = determiner, `prep` = preposition, `conj` = conjunction
  - `pron` = pronoun, `exclam` = exclamation, `av` = auxiliary verb
  - Leave empty `[]` when not specified.
- `examples`: verbatim example sentences/phrases from the source. Omit bullet markers.

## File naming

Name each file after its `id`, e.g. `a2-key-2020.json`.

## Adding a new wordlist

1. Extract vocabulary (manually or via a script in this folder).
2. Save as `vocab/<id>.json` following the schema above.
3. Optionally add a `parse_<source>.py` script here for future re-extraction.
