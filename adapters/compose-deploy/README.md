# @agent-layers/adapter-compose-deploy

Maps **Compose Specification** → **DeployPort** (layer `infra`). Tier: prototype, production.

Starts the services of a stack with `docker compose`. A service that names a `layer` and no `image` uses that layer's
reference compose file (`reference/<layer id>/compose.yml`); a layer
without a file is skipped and shown as a `# no compose file for layer ...` step in the plan. Services with an `image`
go into a generated file, `.agent-layers/compose.generated.yml`. Secret references become `NAME: ${NAME}`, so values
are read from the env file or the environment and are never written to the file. Each compose file runs as its own
`docker compose` command, so relative paths inside a reference file keep resolving against its folder. `plan` has no
side effects; `up` and `down` run the commands and throw with Compose's error output on a non-zero exit.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `root` | string | config directory | Directory commands run in and paths resolve against |
| `projectName` | string | `agent-layers` | Compose project name (`-p`) |
| `envFile` | string | `.env` if present in `root` | Env file passed with `--env-file` |
| `files` | object | none | Compose file per layer id, overriding the search |
| `searchDirs` | string[] | `["reference"]` | Directories searched for layer compose files |
| `command` | string[] | `["docker", "compose"]` | Compose command |
| `wait` | boolean | `true` | Add `--wait` to `up` |
| `healthIntervalS` | integer | `5` | Seconds between health checks of the generated services |
| `healthTimeoutS` | integer | `3` | Seconds a health check may take |
| `healthRetries` | integer | `12` | Failed health checks before a service counts as unhealthy |
| `errorOutputChars` | integer | `500` | Characters of the command output kept in the error message when Compose fails |

Limits accept `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{
  "layers": {
    "deploy": {
      "adapter": "compose-deploy",
      "options": { "projectName": "my-agent", "files": { "knowledge": "infra/qdrant.yml" } }
    }
  }
}
```
