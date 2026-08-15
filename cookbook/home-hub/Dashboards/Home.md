---
type: dashboard
dashboard: hub
created: 2026-07-23
---
## Now

> [!note] Studio
> Reference pass on [[Night Circuit]], then it ships.
> [!warn] Deadline
> Repress decision for [[Slow Bloom EP]] due end of month.
> [!idea] Later
> [[Fern Static]] — try the field recordings as a bed under everything.

## Money

```cards
- label: Total value
  bind: "{{Holdings.total}}"
  format: usd
  emph: true
- label: Crypto
  bind: "{{Holdings.crypto}}"
  format: usd
```

```chart
source: {{Holdings}}
x: bucket
y: sum:value_usd
kind: bar
title: Value by bucket
```

## In flight

```view
type: release
query: status:mastering,sketch
view: table
```

## People

```view
type: contact
view: table
```
