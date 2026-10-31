"""Exposes an OpenAPI 3 document as an MCP server (streamable HTTP) with FastMCP."""

import json
import os

from fastmcp import FastMCP

with open(os.environ.get("OPENAPI_SPEC", "/app/openapi.json"), encoding="utf-8") as f:
    spec = json.load(f)

# The API is reached by its address inside the compose network, not the one in the spec.
spec["servers"] = [{"url": os.environ["UPSTREAM_URL"]}]

mcp = FastMCP.from_openapi(spec, name=os.environ.get("MCP_NAME", "httpbin"))

if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), path="/mcp")
