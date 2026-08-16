# Minimal capability fixture

A private fixture used to prove the platform runtime end to end. It is **not** a product tool
server, it is never published, and it must never grow imitation behaviour from a real capability.

It stores short notes in memory. That is the smallest domain that still exercises everything the
platform has to get right:

| Fixture element                     | Platform behaviour it proves                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `list_notes` (read tool)            | Registry validation, routing rendering, read annotations, HTTP and MCP invocation. |
| `put_note` (write tool)             | Write annotations, `x-openai-isConsequential`, the generic mutation gate.          |
| `wait_for_cancellation` (read tool) | Cancellation on disconnect, application drain, and request deadlines.              |
| `broken_output` (read tool)         | Registry output validation, and that the offending value never reaches a caller.   |
| `NoteStore` service                 | Capability-owned services, generic over the capability type.                       |
| Readiness contributor               | Readiness aggregation and the 503 path.                                            |
| Lifecycle hooks                     | `start` and `stop` running at the right points.                                    |
| `GET /notes/stats`                  | A protected extension route inheriting every platform guard.                       |
| `MINIMAL_*` env schema              | Capability configuration composition and cross-field validation.                   |
| Telemetry estimator                 | The capability measurement seam merging into baseline invocation telemetry.        |

If you are looking for how a real capability is written, read this fixture's source — it is
deliberately the shortest complete example — and then the repository
[README](../../README.md).
