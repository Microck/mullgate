# PR 17 Idea Audit

Status of each idea from `nightshift-idea-generator.md` after auditing current `main` and this branch.

## Implemented in this branch

- `H-03` - Added an env-gated real-runtime E2E flow in `test/e2e/full-runtime.test.ts`. It exercises `setup -> proxy start -> proxy status -> proxy doctor -> proxy stop` when `MULLGATE_E2E=1` and live credentials are provided.
- `H-07` - Added `mullgate proxy stop`.
- `M-01` - Added `mullgate proxy restart`.
- `M-02` - `proxy start` now opportunistically refreshes stale relay cache data before rendering runtime artifacts when a fresh relay fetch succeeds.
- `M-03` - Added `mullgate proxy start --dry-run`.
- `M-04` - Deduplicated `WritableTextSink` into `src/cli-output.ts`.
- `M-06` - Added coverage thresholds in `vitest.config.ts`.
- `M-09` - Added explicit runtime remediation text to start/stop failure surfaces.
- `M-11` - Added `mullgate completions <bash|zsh|fish>`.
- `L-02` - Added architecture and data-flow guidance to `CONTRIBUTING.md`.
- `L-03` - Enabled build source maps in `tsconfig.build.json`.
- `L-04` - Added `mullgate version`.
- `L-05` - Added `mullgate proxy logs`.
- `L-07` - Switched relay listing to aligned table output.
- `D-01` - Added a lightweight interactive terminal walkthrough on the docs homepage.
- `D-02` - Enabled the docs search trigger in the docs layout options.

## Already implemented on main

- `M-07` - The no-op `sanitizeText()` issue was already fixed by merged PR `#23`.

## Rejected after audit

- `H-01` - Splitting `start.ts` right now would be mostly churn. The branch already adds user-facing runtime controls and tests; a large no-behavior refactor was not justified in the same patch.
- `H-02` - Config-at-rest encryption was rejected for now. Without a stable key-management story for unattended CLI use, it would trade plaintext-on-disk for brittle operator workflows and false confidence.
- `H-04` - A shared `Result<T, E>` library was rejected in this pass. It is a broad internal-style rewrite with low operator value compared to the concrete runtime/workflow gaps addressed here.
- `H-05` - Full structured logging with verbosity tiers and JSON output was rejected for now. It needs a repo-wide output contract redesign, not a piecemeal command patch.
- `H-06` - Splitting `setup-runner.ts` was rejected in this pass for the same reason as `H-01`: broad churn without a pressing user-facing bug.
- `M-05` - Automatic config migrations were rejected because Mullgate intentionally treats unsupported configs as stale local state and fails fast with explicit recovery steps.
- `M-08` - A separate `config diff` surface was rejected for now. Existing `config show`, `config get`, and the refreshed artifact diagnostics cover the current operator need better than another editing DSL.
- `M-10` - DNS-over-HTTPS and an insecure TLS bypass flag were rejected. The fetch path already uses strict TLS defaults, and adding a skip-verify escape hatch would be a security regression.
- `L-01` - Blanket JSDoc on all exported symbols was rejected as low-signal churn.
- `L-06` - Extra pnpm-store caching was rejected. CI already uses `actions/setup-node` with `cache: pnpm`, which is sufficient for this repo.
- `L-08` - Non-TTY progress indicators were rejected for now. They add output noise and a new reporting contract without fixing a current operator problem.
