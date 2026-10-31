# @agent-layers/adapter-terminal-channel

Maps **terminal (stdin/stdout)** → **ChannelPort** (layer `interface`). Tier: prototype.

Chat with the stack's agents in a terminal, for development and demos. Each non-empty line is sent to the current
agent as a run of one session, and the output is printed. A run that does not complete prints `[<status>] <reason.code> (<reason.by>)`
(`[stopped] guard_block (pii)`, `[failed] error`); the code and the instance come from the structured reason, nothing is
parsed, and its detail is not shown. `[waiting]` is a distinct state: the run stopped for an answer
(`needs_input`, `needs_auth`) and what the agent said so far is printed below it. Errors print `[error] <code>` and never
end the session; error text is not shown. Lines are handled one at a time, in order. The
session ends on `/exit`, end of input or `close()`; the handle's `done` promise resolves when it does. `/agents` lists
the agents and `/agent <name>` switches to another one. From code, `createTerminalChannel(options, { input, output })`
takes any readable and writable stream.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `agent` | string | first agent of the stack | Agent to talk to at start |
| `prompt` | string | `> ` | Prompt printed before each line |
| `banner` | boolean | `true` | Print `Talking to <agent>. /agents, /agent <name>, /exit.` at start |

```json
{ "layers": { "channels": [{ "adapter": "terminal-channel", "options": { "agent": "support", "prompt": "you> " } }] } }
```
