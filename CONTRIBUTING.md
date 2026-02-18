# Contributing to ClawRoute

Thanks for your interest in contributing! 🦀

## Getting Started

```bash
git clone https://github.com/atharv404/ClawRoute
cd ClawRoute
npm install
cp .env.example .env   # Add your API keys
npm run build
npm test
```

## Development Workflow

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feat/your-feature`
3. **Make changes** — keep them focused and small
4. **Run tests**: `npm test`
5. **Build**: `npm run build` (must pass with no TypeScript errors)
6. **Submit a PR** against `main`

## Code Style

- TypeScript strict mode — no `any` types
- JSDoc comments on all exported functions
- Keep functions small and single-purpose
- No external dependencies unless absolutely necessary (privacy-first)

## What We Welcome

- 🐛 Bug fixes
- 📖 Documentation improvements
- 🤖 New model entries in `src/models.ts`
- ⚡ Performance improvements to the classifier
- 🔌 New provider support in `src/executor.ts`

## What to Avoid

- Adding telemetry or external API calls in the classification path
- Breaking the OpenAI-compatible proxy interface
- Adding dependencies that compromise the privacy-first design

## Testing

```bash
npm test              # Run all tests
npm test -- --watch   # Watch mode
```

Tests live in `test/`. Please add tests for any new functionality.

## Reporting Issues

Use the GitHub issue templates for [bug reports](https://github.com/atharv404/ClawRoute/issues/new?template=bug_report.md) and [feature requests](https://github.com/atharv404/ClawRoute/issues/new?template=feature_request.md).

## Questions?

Open a [GitHub Discussion](https://github.com/atharv404/ClawRoute/discussions) or drop a comment on the relevant issue.
