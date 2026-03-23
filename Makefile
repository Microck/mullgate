PNPM := pnpm

.PHONY: install build lint format format-check typecheck test coverage release-check

install:
	$(PNPM) install --frozen-lockfile

build:
	$(PNPM) build

lint:
	$(PNPM) lint

format:
	$(PNPM) format

format-check:
	$(PNPM) format:check

typecheck:
	$(PNPM) typecheck

test:
	$(PNPM) test -- --run

coverage:
	$(PNPM) test:coverage

release-check:
	$(PNPM) lint
	$(PNPM) typecheck
	$(PNPM) test -- --run
	$(PNPM) verify:install-smoke
	$(PNPM) verify:m003-install-path -- --check-only
