# Security

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/ashergarland/agent-tool-platform/security/advisories/new).
Please do not open a public issue for anything that could be exploited before a fix exists.

Include the affected version or commit, the impact you believe it has, and the smallest
reproduction you can produce. You should expect an acknowledgement within a few days.

## Scope

This repository is a library. It ships no running service, no deployed infrastructure, and no
published package, so there is nothing here for an attacker to reach directly. What matters is that
a defect here is inherited by every capability that consumes it.

The properties most worth reporting a break in:

- **Credential handling.** API keys are compared as fixed-width keyed HMAC digests, so neither key
  length nor key content is observable through timing. Credentials never appear in logs, errors, or
  principal identifiers; a non-reversible fingerprint is used instead. Low-entropy keys are refused
  at configuration time.
- **Error disclosure.** Caller-visible messages and details are bounded, and an unmapped exception
  becomes a generic `internal_error` whose original text stays server-side. Stacks, causes, and
  absolute paths never reach a transport.
- **Filesystem containment.** Paths are canonicalized before containment is checked, so a symlink
  whose target escapes the configured root is rejected rather than followed.
- **Subprocess execution.** Children are spawned without a shell, with an environment built from an
  allowlist rather than filtered from the parent, so application secrets cannot be inherited.
  Output, wall-clock time, and admission are all bounded. This primitive is deliberately not
  reachable from any tool.
- **Readiness disclosure.** `/ready` is public, so its output is bounded and must not carry secrets,
  paths, resource identifiers, or raw provider errors.
- **Error disclosure bounds.** Caller-visible details are bounded recursively — entries, array
  lengths, string lengths, nesting depth, and a total node budget — and circular references are
  replaced rather than followed, so no detail structure can produce an unbounded response body.
- **Proxy trust.** `TRUST_PROXY` must describe the real topology. Because a proxy appends to
  `X-Forwarded-For`, trusting the whole chain lets a caller prepend an address and choose its own
  pre-auth abuse bucket. Deployments set a bounded hop count instead.
- **Telemetry.** The telemetry contract carries no prompts, source, arguments, results, paths,
  filenames, resource identifiers, or credentials, and measurements are sanitized before reaching a
  sink.

## Known limitations

- **Rate limiting is per replica.** State is in-process, so two replicas each admit the configured
  maximum. It is a fair-use and abuse control, not a distributed quota.
- **`TRUST_PROXY` must match the deployment.** The pre-auth abuse budget is keyed by client address.
  The default (`false`) means every caller behind an ingress shares one bucket, which is a
  deliberate fail-safe rather than a false per-client budget. Set a bounded hop count matching the
  number of trusted proxies; setting `true` would let a caller choose its own bucket.
- **`AUTH_MODE=disabled` exists for local and stdio use.** Production configuration refuses it.

## Automated checks

Every pull request and a weekly schedule run dependency auditing, secret scanning, and CodeQL. See
[`.github/workflows/security.yml`](.github/workflows/security.yml).
