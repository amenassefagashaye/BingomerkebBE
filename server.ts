// ----------------- Configuration -----------------
const PORT = 8080;
const ADMIN_PASSWORD = "Merkeb2123Asse1219";
const JWT_SECRET = "bingo-game-secret-key-2024";

// ----------------- Interfaces -----------------
interface User {
  id: string;
  username: string;
  password: string;
  deviceId: string;
  isAdmin: boolean;
  createdAt: Date;
  lastLogin: Date;
  package: Package | null;
  approved: boolean;
  blocked: boolean;
}

interface Package {
  type: "basic" | "premium" | "enterprise";
  price: number;
  expiryDate: Date;
  locked: boolean;
}

interface Device {
  id: string;
  deviceId: string;
  approved: boolean;
  blocked: boolean;
  package: Package | null;
  lastLogin: Date;
}

// ----------------- In-memory storage -----------------
const clients = new Set<WebSocket>();
const devices: Map<string, Device> = new Map(); // deviceId → Device

// ----------------- WebSocket handler -----------------
async function handleWs(sock: WebSocket) {
  clients.add(sock);

  try {
    for await (const ev of sock) {
      if (typeof ev === "string") {
        const data = JSON.parse(ev);

        if (data.type === "checkDevice") {
          const device = devices.get(data.deviceId);

          if (!device) {
            // First time device
            const newDevice: Device = {
              id: crypto.randomUUID(),
              deviceId: data.deviceId,
              approved: false,
              blocked: false,
              package: null,
              lastLogin: new Date(),
            };
            devices.set(data.deviceId, newDevice);
            sock.send(JSON.stringify({ status: "pending", message: "Waiting admin approval" }));
          } else if (device.blocked || !device.approved || !device.package || device.package.locked) {
            sock.send(JSON.stringify({ status: "blocked", message: "Access denied / package finished" }));
          } else {
            sock.send(JSON.stringify({ status: "allowed", package: device.package }));
          }
        }

        // Add more message types here (admin commands, bingo numbers, etc.)
      }
    }
  } catch (err) {
    console.error("WebSocket error:", err);
  } finally {
    clients.delete(sock);
  }
}

// ----------------- HTTP Upgrade handler -----------------
async function handler(req: Request): Promise<Response> {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("This server only supports WebSocket requests", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  handleWs(socket);
  return response;
}

// ----------------- Start the server -----------------
console.log(`✅ Deno Bingo WebSocket server running on ws://localhost:${PORT}`);
await Deno.serve(handler, { port: PORT });
