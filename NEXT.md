# NEXT: import-export v2 (`v2/import-export`), 2026-11-18

Stopped for the usage limit. All work is committed on this branch and has not been pushed. The full gate has not been run.

## Done (tested against framework `fix/release-0.2` f658430, a local tarball installed with `--no-save`)
- File layer: streaming CSV parser and writer; DTD-free XML tokenizer (no XXE or entity expansion); ZIP reader with zip-bomb guards and a streaming ZIP writer; XLSX reader and streaming writer. No runtime dependencies besides the framework peer.
- Formula-injection guard on exported text cells (`'` prefix), reversed on import.
- Model layer (`src/model`): importable columns are fillable minus system, tenant, hidden and secret columns (`allowHidden` opts a column in). Exportable columns are everything except hidden, secret and tenant columns.
- Typed coercion with lowercase issue codes and catalog messages (`src/messages.ts`).
- Import engine (`src/import`):
  - automatic or explicit mapping, saved mappings;
  - dry run (real writes, always rolled back);
  - commit with `skip` (per-chunk transactions, row savepoints, resumable) or `rollback` (one transaction);
  - upsert by key or primary key (lookup only);
  - duplicate-key detection within the file;
  - tenant-scoped reference checks;
  - access (`systemAccess`, `actorAccess`, `accessFromPermissions`) with create/update filters re-checked after each write.
- Export engine (`src/export`): keyset paging, bounded memory, view filter, formula-safe cells.
- Job store (`src/jobs.ts`) over the ORM, plus the migration template (`src/migration.ts`).
- Service (`src/service.ts`):
  - upload to storage with size and format checks;
  - inspect, dry run, start, resume (claim token, SHA-256 check);
  - failure records;
  - export to disk, download.
- Tests: csv, xlsx (zip, xml, fuzz), import, service. All of them were green in single-file runs (agent-reported, not re-run as a full gate).

## Next
1. Tenancy suite (`test/tenancy.test.ts`, `openDatabase({ tenancy: true })`): isolation of data, jobs and references between two tenants.
2. Memory-bound test (200k rows through `readRows` + `prepareRow`; a large export) and a CSV edge-case pass (BOM, quoting).
3. `src/commands.ts`:
   - `import <model> <file> [--dry-run] [--mapping] [--upsert-by] [--on-error] [--tenant]`;
   - `export <model> [--format] [--columns] [--output] [--tenant]`;
   - `import:resume`, `import:status`.
   Each command boots the app with `loadApplication(root)` + `app.boot()` + `app.run()` and loads `config/import-export.ts`. Keep the boot step injectable so it can be tested.
4. `src/installer.ts` (`defineInstaller` from `@strutvane/framework/devkit`): writes `config/import-export.ts` and `database/migrations/<stamp>_create_import_export_tables.ts` (with `t.tenant()` when `config/tenancy.ts` is enabled). It must be idempotent.
5. `src/index.ts` exports, README, CHANGELOG, a changeset (minor, pre `next`, so `changeset version` gives 0.2.0-next.0), and the RELEASE-READINESS rows.
6. Full gate `npm run ci` 3× with timeouts. Watch coverage on `src/service.ts` and `src/jobs.ts`.

## Decisions for the project lead
- XLSX is read and written by our own code on `node:zlib` (no ExcelJS or SheetJS: SheetJS on npm has unpatched CVEs, and ExcelJS is stale and carries a heavy dependency tree). There is no ZIP64, so files are limited to 4 GiB.
- The tooling manifest has no `import-export` target yet. The synced files were copied verbatim from `canonical/`; add the target in strutvane-tooling.
- The lockfile has no framework entry until the framework is on npm (same as ui).
