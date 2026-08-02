---
type: dashboard
dashboard: metrics
cards:
- label: Total value
  bind: '{{Holdings.total}}'
  format: usd
- label: ETFs
  bind: '{{Holdings.etf}}'
  format: usd
- label: Crypto
  bind: '{{Holdings.crypto}}'
  format: usd
created: 2026-07-23
---
Metrics cards over the [[Holdings]] sheet — each card binds to a named summary.
