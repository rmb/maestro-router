# ADR-0004 · License: Apache 2.0

## Status

Accepted · 2026-05-21

## Context

Maestro is open source. The license choice affects what downstream users
and contributors can do, what patent protections exist, and how Maestro
can be combined with other projects.

## Decision

**Apache License, Version 2.0** with copyright line
`Copyright 2026 Maestro Contributors`.

## Rationale

- **Explicit patent grant**: Apache 2.0 includes a patent license from
  contributors. MIT does not. For a project that may eventually integrate
  with multiple vendor SDKs (Anthropic, AWS, OpenAI), the explicit patent
  grant matters.
- **Standard for infrastructure OSS**: Kubernetes, TensorFlow, Bazel,
  Spark, Cassandra, Kafka — Apache 2.0 is the default for infrastructure
  projects. Maestro is infrastructure (sits between user and LLM).
- **Contributor-friendly**: No Contributor License Agreement (CLA)
  required. Apache 2.0's contribution clause handles intellectual property
  flow without separate paperwork.
- **Permissive enough**: Allows commercial use, modification, distribution,
  patent use, private use. The only requirements are attribution, license
  reproduction, and statement of changes.

## Alternatives considered

- **MIT** — shorter, more popular for small libraries. Lacks the patent
  grant.
- **BSD-3-Clause** — similar to MIT plus a non-endorsement clause. Lacks
  patent grant.
- **MPL-2.0** — weak copyleft per file. Overkill for a CLI tool;
  contributor friction higher.
- **GPL-3** — strong copyleft. Restricts how downstream proprietary
  projects can integrate. Wrong choice for a routing utility meant to be
  embedded in commercial workflows.

## Consequences

- Every source file under `src/` includes the SPDX header:
  `// Copyright 2026 Maestro Contributors. SPDX-License-Identifier: Apache-2.0`
- `LICENSE` file contains the full Apache 2.0 text.
- `NOTICE` file credits external patterns (PostHog, Microsoft CCE, CCR,
  RTK) per Apache convention.
- Contributors implicitly accept the Apache 2.0 grant when they open a PR
  (per Apache 2.0 §5).
