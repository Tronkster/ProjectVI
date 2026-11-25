const { test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const http = require("node:http");
const { openPort, closePort, localAddressFor } = require("../src/main/upnp");

// A stand-in router: answers SSDP searches and SOAP calls, and keeps the port mappings it was given.
async function startRouter({ refuse = false, service = "urn:schemas-upnp-org:service:WANIPConnection:1" } = {}) {
  const mappings = new Map(); // "UDP:30120" -> client
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/desc.xml") {
        res.end(`<?xml version="1.0"?><root><device><serviceList>
          <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3</controlURL></service>
          <service><serviceType>${service}</serviceType><controlURL>/ctl/IPConn</controlURL></service>
        </serviceList></device></root>`);
        return;
      }
      const action = /SOAPAction: "[^#]+#(\w+)"/i.exec(`SOAPAction: ${req.headers.soapaction}`)?.[1];
      calls.push({ action, path: req.url, body });
      if (refuse && action === "AddPortMapping") {
        res.statusCode = 500;
        res.end("<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>");
        return;
      }
      const get = (name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1];
      if (action === "AddPortMapping") mappings.set(`${get("NewProtocol")}:${get("NewExternalPort")}`, get("NewInternalClient"));
      if (action === "DeletePortMapping") mappings.delete(`${get("NewProtocol")}:${get("NewExternalPort")}`);
      const extra = action === "GetExternalIPAddress" ? "<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>" : "";
      res.end(`<s:Envelope><s:Body><u:${action}Response>${extra}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const httpPort = server.address().port;
  const ssdp = dgram.createSocket("udp4");
  ssdp.on("message", (msg, rinfo) => {
    if (!/M-SEARCH/.test(msg.toString())) return;
    ssdp.send(`HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://127.0.0.1:${httpPort}/desc.xml\r\n\r\n`, rinfo.port, rinfo.address);
  });
  await new Promise((r) => ssdp.bind(0, "127.0.0.1", r));
  return {
    mappings,
    calls,
    options: { ssdpAddress: "127.0.0.1", ssdpPort: ssdp.address().port, timeoutMs: 1000 },
    close: () => new Promise((r) => ssdp.close(() => server.close(r)))
  };
}

test("opening a port maps TCP and UDP on the router and finds the public address; closing removes both", async () => {
  const router = await startRouter();
  try {
    const { gateway, externalIp } = await openPort(30120, router.options);
    assert.equal(externalIp, "203.0.113.7");
    assert.equal(gateway.controlUrl.endsWith("/ctl/IPConn"), true);
    assert.deepEqual([...router.mappings.keys()].sort(), ["TCP:30120", "UDP:30120"]);
    assert.ok(router.calls.find((c) => c.action === "AddPortMapping").body.includes("<NewPortMappingDescription>ProjectVI server</NewPortMappingDescription>"));
    await closePort(gateway, 30120);
    assert.equal(router.mappings.size, 0);
  } finally {
    await router.close();
  }
});

test("PPP routers work too", async () => {
  const router = await startRouter({ service: "urn:schemas-upnp-org:service:WANPPPConnection:1" });
  try {
    await openPort(30121, router.options);
    assert.equal(router.mappings.size, 2);
  } finally {
    await router.close();
  }
});

test("a router that refuses, or no router at all, gives a reason a player can read", async () => {
  const router = await startRouter({ refuse: true });
  try {
    await assert.rejects(openPort(30120, router.options), /refused AddPortMapping \(718: ConflictInMappingEntry\)/);
  } finally {
    await router.close();
  }
  const silent = dgram.createSocket("udp4");
  await new Promise((r) => silent.bind(0, "127.0.0.1", r));
  try {
    await assert.rejects(openPort(30120, { ssdpAddress: "127.0.0.1", ssdpPort: silent.address().port, timeoutMs: 300 }), /No router answered/);
  } finally {
    silent.close();
  }
});

test("the local address is the one on the router's subnet", () => {
  const interfaces = {
    vpn: [{ family: "IPv4", internal: false, address: "10.8.0.2", netmask: "255.255.255.0" }],
    lan: [{ family: "IPv4", internal: false, address: "192.168.1.23", netmask: "255.255.255.0" }],
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }]
  };
  assert.equal(localAddressFor("192.168.1.1", interfaces), "192.168.1.23");
  assert.equal(localAddressFor("172.16.0.1", interfaces), "10.8.0.2");
});
