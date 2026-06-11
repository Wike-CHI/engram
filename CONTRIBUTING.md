# Contributing to Engram

Thanks for your interest! Engram is open-source and community-driven.

## Development Setup

```bash
git clone https://github.com/Wike-CHI/engram.git
cd engram
npm install
npm test
```

## Project Structure

```
engram/
├── src/
│   ├── types/            # Core TypeScript interfaces
│   ├── stores/           # Memory storage engines
│   ├── providers/        # MemoryProvider implementations
│   ├── embedding/        # Embedding engine
│   ├── extraction/       # Memory extraction
│   ├── working/          # Working memory manager
│   ├── plugin/           # Active Memory Plugin
│   ├── core/             # Orchestration engine
│   └── adapters/         # Framework adapters
├── examples/             # Usage examples
├── docs/                 # Documentation
└── test/                 # Tests
```

## Testing

```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
```

All code must include tests. We aim for 80%+ coverage on core modules.

## Pull Request Process

1. Fork the repo and create a feature branch
2. Write tests for your changes
3. Run `npm test` — all tests must pass
4. Submit a PR with a clear description of the changes

## Code Style

- TypeScript strict mode
- No external runtime dependencies (devDependencies are OK)
- Async/await over raw promises
- Public APIs should be well-documented with JSDoc

## Adding a New Provider

1. Implement the `MemoryProvider` interface
2. Add comprehensive tests
3. Export from `src/providers/`
4. Add to `src/index.ts` exports
5. Document in README

## Adding a New Framework Adapter

1. Create `src/adapters/<framework>.ts`
2. Implement the `FrameworkAdapter` interface (or work with PluginContext directly)
3. Add tests
4. Add an example in `examples/`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
