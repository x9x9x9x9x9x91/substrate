---
type: dashboard
dashboard: charts
created: 2026-07-23
---
Charts over the release database and the [[Holdings]] sheet.

```chart
source: release
x: status
y: count
kind: bar
title: Releases by status
```

```chart
source: {{Holdings}}
x: asset
y: sum:value_usd
kind: bar
title: Value per asset
```
