# @agent-layers/conformance

Conformance suites for the [agent-layers](https://github.com/aantenore/agent-layers) ports: one suite per port that
proves an adapter behaves as the port contract says. The JSON Schemas of the spec ship in `schemas/`.

```bash
npm install --save-dev @agent-layers/conformance @agent-layers/core
```

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('adapter passes conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { deny: ['forbidden'] },
    fixtures: { block: [{ stage: 'input', text: 'this is forbidden' }] },
  });
  assert.deepEqual(report.failures, []);
});
```

`checkAdapter` validates the descriptor (layer, port, version, options schema, limits), creates the adapter with the
given options and runs the suite of its port. `conformance(port, impl, fixtures)` runs one suite on an instance.

How to write an adapter: [CONTRIBUTING.md](https://github.com/aantenore/agent-layers/blob/main/CONTRIBUTING.md).

Requires Node >= 22.18. License: MIT.
