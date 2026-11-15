# Local agent instructions

## Documentation maintenance

Keep documentation up to date in the same change as the implementation. When
changing public APIs, behavior, configuration, or development workflows, update
the relevant documentation:

- `README.md`: overview, requirements, installation, quick start, and links.
- `docs/models.md`: bootstrap, manifests, model methods, typing, cross-model
  references, logging, database grants, and runtime architecture.
- `docs/queries.md`: filtering, projections, aggregates, joins, deletion, and
  relation loading and writes.
- `docs/revisions.md`: revision workflows, edit conflicts, and transactions.
- `docs/multilingual-text.md`: schemas, language providers, escaping, cleanup,
  and rendering responsibilities.
- `CONTRIBUTING.md`: development setup, test database configuration, checks,
  and the source directory map.

Keep the README concise and link to the topic guides for details. Give each
behavior one authoritative explanation and link to it instead of duplicating
the contract across pages. Distinguish guarantees made by rev-dal from
conventions or helpers supplied by consuming applications.

Check examples against the implementation and types. Verify affected relative
links and heading anchors after moving or renaming documentation. Keep new
documentation included in the package through `package.json`'s `files` list.
Update `TODO.md` when implementing an item listed there.
