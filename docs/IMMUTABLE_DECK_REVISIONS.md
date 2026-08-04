# Immutable Deck Revision Recovery

## Purpose

Deck updates must never destroy a previously installed source package. K&S, Spiegel, and every future source use this same contract: each distinct checksum is stored as an immutable revision, while a separate head record identifies the currently active revision. An application-supplied seed differs only in how its first revision arrives.

## API

- `GET /api/decks` lists active deck heads.
- `GET /api/decks/:deckId` downloads the active package.
- `GET /api/decks/:deckId/revisions` lists preserved revisions and identifies the active checksum.
- `GET /api/decks/:deckId/revisions/:checksum` downloads a specific preserved revision.
- `POST /api/decks/:deckId/restore` with `{ "checksum": "..." }` changes the active head to an existing preserved revision.
- `PUT /api/decks/:deckId` creates a new immutable revision when the checksum is new, then makes it active.
- `DELETE /api/decks/:deckId` explicitly deletes the deck, all revisions, and compatibility records.

## Safety behavior

- Uploading the same active checksum is idempotent.
- Changed content using the same version is rejected.
- Missing revision chunks fail closed rather than returning partial JSON.
- Restoring a revision moves the active pointer and does not delete newer revisions.
- Compatibility tables remain synchronized so an application rollback does not point metadata at different package content.
- Migration `0005_immutable_deck_revisions.sql` backfills existing metadata, chunks, and active heads in one transaction.

## Production checkpoint

Do not apply migration `0005` until the development branch passes unit tests, guardrails, and a Cloudflare dry run. Before applying it remotely, export or otherwise confirm recoverability of the current D1 database. The migration is additive and preserves the legacy package tables.
