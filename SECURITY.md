# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** ([new advisory](https://github.com/aantenore/agent-layers/security/advisories/new)).
Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include the affected package and version, a description of the impact, and steps or a minimal configuration that
reproduce it. You will get an acknowledgement within 7 days. Fixes are released as a new version of the affected
packages and disclosed through a GitHub security advisory, crediting the reporter unless they prefer otherwise.

## Supported versions

Only the latest published version of each `@agent-layers/*` package receives security fixes.

## Scope

The packages in this repository: `packages/*`, `adapters/*` and `runtimes/*`. The reference setups under
`reference/` and `examples/` use development credentials (`change-me`, `dev-token`, test users of the Keycloak
realm) and are not meant to be exposed on a network as they are. Vulnerabilities in third-party services those setups
start belong to the respective projects.
