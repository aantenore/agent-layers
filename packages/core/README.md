# @agent-layers/core

Ports, adapter registry, composition pipelines and stack config for [agent-layers](https://github.com/aantenore/agent-layers).
Zero runtime dependencies.

The core defines one port per layer of an agent. Adapters map a standard or a technology onto a port; a stack config
(`agent-layers.json`) picks one adapter per slot, per profile; `compose` turns the config into a running stack.

```bash
npm install @agent-layers/core @agent-layers/adapter-mock-model @agent-layers/adapter-basic-runtime
```

```ts
import { compose, loadConfig } from '@agent-layers/core';

const stack = await compose(await loadConfig('agent-layers.json', { profile: 'prototype' }));
try {
  const run = await (await stack.agent('assistant')).run('Hello');
  console.log(run.status, run.output);
} finally {
  await stack.close();
}
```

The JSON Schema of the stack config ships with the package: `@agent-layers/core/schema.json`, or
`./node_modules/@agent-layers/core/schema/agent-layers.schema.json` as `$schema` in the config file.

Start a project with [`@agent-layers/cli`](https://www.npmjs.com/package/@agent-layers/cli)
(`npx @agent-layers/cli init my-agent`). Concepts, ports and the adapter catalog are in the
[documentation](https://github.com/aantenore/agent-layers#readme).

Requires Node >= 22.18. License: MIT.
