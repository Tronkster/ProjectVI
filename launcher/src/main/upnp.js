// Asks the home router to forward a port to this PC (UPnP IGD), so friends can reach a server hosted from the
// launcher. Only when the player turns it on, and the mapping is removed when hosting stops. Many routers have
// UPnP off; then the player forwards the port by hand, and the launcher says so.
//
// 1. SSDP: a multicast M-SEARCH for an Internet Gateway Device; the router answers with the URL of its description.
// 2. The description lists a WANIPConnection (or WANPPPConnection) service and its control URL.
// 3. SOAP calls to that URL: AddPortMapping, DeletePortMapping, GetExternalIPAddress.
//
// No Electron imports, so this can be tested against a stand-in router.

const dgram = require("node:dgram");
const os = require("node:os");

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SERVICES = ["urn:schemas-upnp-org:service:WANIPConnection:2", "urn:schemas-upnp-org:service:WANIPConnection:1", "urn:schemas-upnp-org:service:WANPPPConnection:1"];
const DESCRIPTION_LIMIT = 256 * 1024;

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const tag = (xml, name) => new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, "i").exec(xml)?.[1]?.trim() ?? null;

// Finds the router. Resolves with { controlUrl, serviceType, localAddress }, or rejects with a message for people.
async function discover({ timeoutMs = 3000, ssdpAddress = SSDP_ADDRESS, ssdpPort = SSDP_PORT, fetchImpl = fetch } = {}) {
  const location = await new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("No router answered a UPnP search. UPnP may be turned off on the router."));
    }, timeoutMs);
    socket.on("message", (buf) => {
      const text = buf.toString("utf8");
      if (!/^HTTP\/1\.1 200/i.test(text)) return;
      const loc = /^location:\s*(\S+)/im.exec(text)?.[1];
      if (!loc || !/^http:\/\//i.test(loc)) return;
      clearTimeout(timer);
      socket.close();
      resolve(loc);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`UPnP search failed: ${err.message}`));
    });
    socket.bind(0, () => {
      const search = [
        "M-SEARCH * HTTP/1.1",
        `HOST: ${ssdpAddress}:${ssdpPort}`,
        'MAN: "ssdp:discover"',
        "MX: 2",
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        "",
        ""
      ].join("\r\n");
      socket.send(search, ssdpPort, ssdpAddress);
    });
  });

  const res = await fetchImpl(location, { signal: AbortSignal.timeout(5000) });
  const xml = (await res.text()).slice(0, DESCRIPTION_LIMIT);
  for (const serviceType of SERVICES) {
    const at = xml.indexOf(`<serviceType>${serviceType}</serviceType>`);
    if (at < 0) continue;
    const block = xml.slice(at, xml.indexOf("</service>", at));
    const control = tag(block, "controlURL");
    if (!control) continue;
    const controlUrl = new URL(control, location).href;
    const gateway = new URL(location).hostname;
    return { controlUrl, serviceType, localAddress: localAddressFor(gateway) };
  }
  throw new Error("The router answered but doesn't offer port forwarding over UPnP.");
}

// This PC's IPv4 address on the router's network: the interface whose subnet contains the gateway.
function localAddressFor(gateway, interfaces = os.networkInterfaces()) {
  const toInt = (ip) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  const g = toInt(gateway);
  let fallback = null;
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      fallback ??= i.address;
      const mask = toInt(i.netmask);
      if ((toInt(i.address) & mask) === (g & mask)) return i.address;
    }
  }
  return fallback ?? "127.0.0.1";
}

async function soap(gateway, action, args, fetchImpl = fetch) {
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${gateway.serviceType}">${Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join("")}</u:${action}></s:Body>
</s:Envelope>`;
  const res = await fetchImpl(gateway.controlUrl, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${gateway.serviceType}#${action}"` },
    body,
    signal: AbortSignal.timeout(5000)
  });
  const text = (await res.text()).slice(0, DESCRIPTION_LIMIT);
  if (!res.ok) {
    const code = tag(text, "errorCode");
    const description = tag(text, "errorDescription");
    throw new Error(`The router refused ${action}${code ? ` (${code}${description ? `: ${description}` : ""})` : ` (HTTP ${res.status})`}.`);
  }
  return text;
}

// Forwards port `port` for `protocol` ("TCP" or "UDP") to this PC. leaseSeconds 0 means until removed.
function addPortMapping(gateway, { port, protocol, description = "ProjectVI server", leaseSeconds = 0 }, fetchImpl) {
  return soap(gateway, "AddPortMapping", {
    NewRemoteHost: "",
    NewExternalPort: port,
    NewProtocol: protocol,
    NewInternalPort: port,
    NewInternalClient: gateway.localAddress,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: leaseSeconds
  }, fetchImpl);
}

function deletePortMapping(gateway, { port, protocol }, fetchImpl) {
  return soap(gateway, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: port, NewProtocol: protocol }, fetchImpl);
}

async function externalAddress(gateway, fetchImpl) {
  const text = await soap(gateway, "GetExternalIPAddress", {}, fetchImpl);
  const ip = tag(text, "NewExternalIPAddress");
  return ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
}

// Opens TCP and UDP `port` (the game server needs both). Returns { gateway, externalIp } or throws.
async function openPort(port, options = {}) {
  const gateway = await discover(options);
  await addPortMapping(gateway, { port, protocol: "TCP", leaseSeconds: options.leaseSeconds ?? 0 }, options.fetchImpl);
  await addPortMapping(gateway, { port, protocol: "UDP", leaseSeconds: options.leaseSeconds ?? 0 }, options.fetchImpl);
  let externalIp = null;
  try {
    externalIp = await externalAddress(gateway, options.fetchImpl);
  } catch {
    // some routers don't answer this; the port is open anyway
  }
  return { gateway, externalIp };
}

async function closePort(gateway, port, fetchImpl) {
  for (const protocol of ["TCP", "UDP"]) {
    try {
      await deletePortMapping(gateway, { port, protocol }, fetchImpl);
    } catch {
      // already gone, or the router restarted
    }
  }
}

module.exports = { discover, addPortMapping, deletePortMapping, externalAddress, openPort, closePort, localAddressFor };
