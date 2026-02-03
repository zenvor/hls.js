# Repository Guidelines

## Project Structure & Module Organization

Core playback logic lives in `src/` (TypeScript/JavaScript modules). Unit tests are in `tests/unit/`; functional/integration tests live in `tests/functional/` with the main runner at `tests/functional/auto/setup.js`. Demo assets and pages are in `demo/`. API docs are maintained under `docs/`, with generated artifacts in `api-extractor/`. Build and tooling configuration is in `rollup.config.js`, `tsconfig*.json`, `karma.conf.js`, and `build-config.js`.

## Build, Test, and Development Commands

- `npm run build`: Bundle the library and generate type definitions.
- `npm run dev` or `npm run start`: Watch build plus a local demo server.
- `npm run build:watch`: Rollup watch for full + demo builds.
- `npm run lint`: ESLint on `src/` and `tests/`.
- `npm run prettier`: Format the repo with Prettier.
- `npm run type-check`: TypeScript no-emit validation.
- `npm run test`: Run unit + functional tests.
- `npm run sanity-check`: Full lint, format check, build, docs, and tests (recommended before PRs).

## Coding Style & Naming Conventions

Follow `.editorconfig`: 2-space indentation, LF, trim trailing whitespace. Prettier enforces single quotes (see `.prettierrc`). Prefer camelCase for variables/functions, PascalCase for classes/types, and keep naming aligned with existing modules. Run `npm run lint` and `npm run prettier` before staging.

## Testing Guidelines

Unit tests run via Karma (`npm run test:unit`, watch mode: `npm run test:unit:watch`). Functional tests run via Mocha (`npm run test:func`, light build: `npm run test:func:light`). Add tests alongside related files in `tests/unit/` or `tests/functional/` and cover new parsing, loading, or playback logic.

## Commit & Pull Request Guidelines

Recent history mixes Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`) with descriptive sentence-style messages and optional scopes (e.g., `fix(remux): ...`). Prefer `type: summary` with an optional scope and include PR/issue numbers when relevant, such as `(#1234)`. Use a topic branch (not `master`), run `npm run prettier` before staging, and ensure `npm run sanity-check` plus `npm run test:func` pass before opening a PR. Keep PRs focused and describe the playback impact and test coverage.

## Environment & Configuration

Use the Node.js version in `.node-version` (currently 22.21.1). Demo development serves from `demo/` on a local port via `npm run dev`.
