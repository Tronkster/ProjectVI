// Reads a resource's resource.toml.
//
//   client_files = ["client.lua", "ui/*"]      files sent to players
//   [dotnet]
//   server = ["bin/server/*.dll"]              C# assemblies run on the server
//   client = ["bin/client/*.dll"]              C# assemblies run on players' PCs (also sent to them)

const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("smol-toml");

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

function readResourceMeta(dir) {
  const file = path.join(dir, "resource.toml");
  if (!fs.existsSync(file)) return { clientFiles: [], dotnet: { server: [], client: [] } };
  const raw = parse(fs.readFileSync(file, "utf8"));
  const dotnet = raw.dotnet && typeof raw.dotnet === "object" ? raw.dotnet : {};
  return {
    description: typeof raw.description === "string" ? raw.description : "",
    version: typeof raw.version === "string" ? raw.version : "",
    clientFiles: strings(raw.client_files),
    dotnet: { server: strings(dotnet.server), client: strings(dotnet.client) }
  };
}

module.exports = { readResourceMeta };
