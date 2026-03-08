import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { 
  WebSocket, 
  isWebSocketCloseEvent, 
  WebSocketMessage 
} from "https://deno.land/std@0.208.0/ws/mod.ts";

// Configuration
const PORT = 8080;
const ADMIN_PASSWORD = "Merkeb2123Asse1219";
const JWT_SECRET = "bingo-game-secret-key-2024";
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute

// Interfaces
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
  userId: string;
  approved: boolean;
  blocked: boolean;
  lastSeen: Date;
}

interface GameState {
  calledNumbers: Set<number>;
  remainingNumbers: number[];
  lastCalledNumber: number | null;
  gameActive: boolean;
  gameStarted: boolean;
  currentRound: number;
  totalRounds: number;
  gameValue: number;
  selectedBoards: Map<string, Set<number>>; // userId -> Set of board numbers
  winners: Winner[];
  calledHistory: number[];
}

interface Winner {
  board: number;
  userId: string;
  amount: number;
  pattern: number[];
  timestamp: Date;
}

interface FinancialStats {
  totalRevenue: number;
  totalPayouts: number;
  profit: number;
  ticketPrice: number;
  prizeAmount: number;
}

interface Session {
  token: string;
  userId: string;
  deviceId: string;
  createdAt: Date;
  expiresAt: Date;
}

interface RateLimit {
  count: number;
  resetAt: Date;
}

// In-memory storage (replace with database in production)
const users = new Map<string, User>();
const sessions = new Map<string, Session>();
const devices = new Map<string, Device>();
const gameState: GameState = {
  calledNumbers: new Set<number>(),
  remainingNumbers: Array.from({ length: 75 }, (_, i) => i + 1),
  lastCalledNumber: null,
  gameActive: false,
  gameStarted: false,
  currentRound: 1,
  totalRounds: 4,
  gameValue: 100,
  selectedBoards: new Map<string, Set<number>>(),
  winners: [],
  calledHistory: []
};

const financialStats: FinancialStats = {
  totalRevenue: 0,
  totalPayouts: 0,
  profit: 0,
  ticketPrice: 100,
  prizeAmount: 0
};

const activityLog: string[] = [];
const rateLimits = new Map<string, RateLimit>();

// Create default admin user
const adminUser: User = {
  id: crypto.randomUUID(),
  username: "admin",
  password: await hashPassword(ADMIN_PASSWORD),
  deviceId: "admin-device",
  isAdmin: true,
  createdAt: new Date(),
  lastLogin: new Date(),
  package: null,
  approved: true,
  blocked: false
};
users.set(adminUser.id, adminUser);

// Helper functions
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + JWT_SECRET);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, "0")).join("");
}

function checkRateLimit(clientId: string): boolean {
  const now = new Date();
  const limit = rateLimits.get(clientId);
  
  if (!limit || now > limit.resetAt) {
    rateLimits.set(clientId, {
      count: 1,
      resetAt: new Date(now.getTime() + RATE_LIMIT_WINDOW)
    });
    return true;
  }
  
  if (limit.count >= RATE_LIMIT_MAX) {
    return false;
  }
  
  limit.count++;
  return true;
}

function validateToken(token: string): Session | null {
  return sessions.get(token) || null;
}

function addToActivityLog(message: string, userId?: string) {
  const logEntry = `[${new Date().toISOString()}] ${userId ? `User:${userId} ` : ""}${message}`;
  activityLog.unshift(logEntry);
  if (activityLog.length > 1000) activityLog.pop();
}

function checkPackageValidity(userId: string): boolean {
  const user = users.get(userId);
  if (!user || !user.package) return false;
  if (user.package.locked) return false;
  if (new Date() > user.package.expiryDate) return false;
  return true;
}

function checkDeviceApproval(deviceId: string): boolean {
  const device = devices.get(deviceId);
  return device ? device.approved && !device.blocked : false;
}

// Game logic functions
function generateRandomNumber(): number | null {
  if (gameState.remainingNumbers.length === 0) return null;
  
  const index = Math.floor(Math.random() * gameState.remainingNumbers.length);
  const number = gameState.remainingNumbers[index];
  gameState.remainingNumbers.splice(index, 1);
  gameState.calledNumbers.add(number);
  gameState.lastCalledNumber = number;
  gameState.calledHistory.push(number);
  
  return number;
}

function getNumberLetter(number: number): string {
  if (number <= 15) return "B";
  if (number <= 30) return "I";
  if (number <= 45) return "N";
  if (number <= 60) return "G";
  return "O";
}

function checkBoardWinner(boardNumbers: number[], pattern: number[]): boolean {
  for (const idx of pattern) {
    if (idx === 12) continue; // FREE space
    const num = boardNumbers[idx];
    if (!gameState.calledNumbers.has(num)) {
      return false;
    }
  }
  return true;
}

function calculateWinAmount(userId: string): number {
  const userBoards = gameState.selectedBoards.get(userId)?.size || 0;
  const base = (gameState.gameValue * userBoards) / gameState.totalRounds;
  return Math.round(base * 0.8);
}

// WebSocket handler
async function handleWebSocket(socket: WebSocket, deviceId: string) {
  const clientId = deviceId;
  let currentUser: User | null = null;
  let session: Session | null = null;
  
  addToActivityLog(`New WebSocket connection from device: ${deviceId}`);
  
  try {
    for await (const event of socket) {
      // Rate limiting
      if (!checkRateLimit(clientId)) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Rate limit exceeded. Please try again later."
        }));
        continue;
      }
      
      if (isWebSocketCloseEvent(event)) {
        addToActivityLog(`WebSocket closed for device: ${deviceId}`);
        break;
      }
      
      if (typeof event === "string") {
        try {
          const data = JSON.parse(event);
          await handleMessage(socket, data, currentUser, session);
        } catch (e) {
          console.error("Error parsing message:", e);
          await socket.send(JSON.stringify({
            type: "error",
            message: "Invalid message format"
          }));
        }
      }
    }
  } catch (error) {
    console.error("WebSocket error:", error);
  } finally {
    // Cleanup
    if (session) {
      sessions.delete(session.token);
    }
  }
}

async function handleMessage(
  socket: WebSocket,
  data: any,
  currentUser: User | null,
  session: Session | null
) {
  // Authentication messages
  if (data.type === "auth") {
    session = validateToken(data.token);
    if (session) {
      currentUser = users.get(session.userId) || null;
      await socket.send(JSON.stringify({
        type: "auth_success",
        token: session.token,
        isAdmin: currentUser?.isAdmin || false
      }));
    } else {
      await socket.send(JSON.stringify({
        type: "auth_error",
        message: "Invalid token"
      }));
    }
    return;
  }
  
  if (data.type === "login") {
    const { username, password, deviceId } = data;
    
    // Find user
    const user = Array.from(users.values()).find(
      u => u.username === username
    );
    
    if (!user) {
      await socket.send(JSON.stringify({
        type: "auth_error",
        message: "User not found"
      }));
      return;
    }
    
    const hashedPassword = await hashPassword(password);
    if (hashedPassword !== user.password) {
      await socket.send(JSON.stringify({
        type: "auth_error",
        message: "Invalid password"
      }));
      return;
    }
    
    // Check device approval
    if (!checkDeviceApproval(deviceId)) {
      await socket.send(JSON.stringify({
        type: "auth_error",
        message: "Device not approved or blocked"
      }));
      return;
    }
    
    // Check package validity
    if (!checkPackageValidity(user.id)) {
      await socket.send(JSON.stringify({
        type: "auth_error",
        message: "Package expired or locked"
      }));
      return;
    }
    
    // Create session
    const token = generateToken();
    const newSession: Session = {
      token,
      userId: user.id,
      deviceId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
    };
    sessions.set(token, newSession);
    
    user.lastLogin = new Date();
    
    addToActivityLog(`User ${user.username} logged in from device ${deviceId}`, user.id);
    
    await socket.send(JSON.stringify({
      type: "auth_success",
      token,
      isAdmin: user.isAdmin || false
    }));
    
    // Send current game state
    await socket.send(JSON.stringify({
      type: "game_state",
      state: {
        calledNumbers: Array.from(gameState.calledNumbers),
        remainingNumbers: gameState.remainingNumbers,
        lastCalledNumber: gameState.lastCalledNumber,
        gameActive: gameState.gameActive,
        gameStarted: gameState.gameStarted,
        currentRound: gameState.currentRound,
        totalRounds: gameState.totalRounds,
        gameValue: gameState.gameValue
      }
    }));
    
    return;
  }
  
  // Require authentication for all other messages
  if (!session || !currentUser) {
    await socket.send(JSON.stringify({
      type: "error",
      message: "Not authenticated"
    }));
    return;
  }
  
  // Handle different message types
  switch (data.type) {
    case "board_selection":
      if (data.boards) {
        gameState.selectedBoards.set(currentUser.id, new Set(data.boards));
        addToActivityLog(`User selected ${data.boards.length} boards`, currentUser.id);
      }
      break;
      
    case "get_next_number":
      if (!gameState.gameActive || !gameState.gameStarted) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Game not active"
        }));
        return;
      }
      
      const number = generateRandomNumber();
      if (number) {
        const letter = getNumberLetter(number);
        
        // Broadcast to all connected clients
        await broadcastToAll({
          type: "number_called",
          number,
          letter
        });
      }
      break;
      
    case "call_letter":
      if (!gameState.gameActive || !gameState.gameStarted) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Game not active"
        }));
        return;
      }
      
      // Get a number from the specified letter range
      let min = 1, max = 15;
      if (data.letter === "I") { min = 16; max = 30; }
      else if (data.letter === "N") { min = 31; max = 45; }
      else if (data.letter === "G") { min = 46; max = 60; }
      else if (data.letter === "O") { min = 61; max = 75; }
      
      const available = gameState.remainingNumbers.filter(n => n >= min && n <= max);
      if (available.length > 0) {
        const idx = Math.floor(Math.random() * available.length);
        const num = available[idx];
        gameState.remainingNumbers = gameState.remainingNumbers.filter(n => n !== num);
        gameState.calledNumbers.add(num);
        gameState.lastCalledNumber = num;
        gameState.calledHistory.push(num);
        
        await broadcastToAll({
          type: "number_called",
          number: num,
          letter: data.letter
        });
      }
      break;
      
    case "check_winner":
      const boardNum = data.board;
      const userBoards = gameState.selectedBoards.get(currentUser.id);
      
      if (!userBoards || !userBoards.has(boardNum)) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Board not selected"
        }));
        return;
      }
      
      // TODO: Implement pattern checking
      // For now, simulate winner check
      const winAmount = calculateWinAmount(currentUser.id);
      
      if (Math.random() > 0.7) { // Simulated winner
        const winner: Winner = {
          board: boardNum,
          userId: currentUser.id,
          amount: winAmount,
          pattern: [0, 1, 2, 3, 4], // Example pattern
          timestamp: new Date()
        };
        gameState.winners.push(winner);
        financialStats.totalPayouts += winAmount;
        financialStats.profit = financialStats.totalRevenue - financialStats.totalPayouts;
        
        addToActivityLog(`Winner found: Board ${boardNum} won ${winAmount} ETB`, currentUser.id);
        
        await broadcastToAll({
          type: "winner_found",
          board: boardNum,
          amount: winAmount,
          pattern: [0, 1, 2, 3, 4]
        });
      } else {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Not a winner"
        }));
      }
      break;
      
    case "game_control":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      switch (data.action) {
        case "start":
          gameState.gameActive = true;
          gameState.gameStarted = true;
          addToActivityLog("Game started by admin", currentUser.id);
          await broadcastToAll({
            type: "game_state",
            state: { gameActive: true, gameStarted: true }
          });
          break;
          
        case "stop":
          gameState.gameActive = false;
          addToActivityLog("Game stopped by admin", currentUser.id);
          await broadcastToAll({
            type: "game_state",
            state: { gameActive: false }
          });
          break;
          
        case "reset":
          gameState.calledNumbers.clear();
          gameState.remainingNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
          gameState.lastCalledNumber = null;
          gameState.gameActive = false;
          gameState.gameStarted = false;
          gameState.currentRound = 1;
          gameState.calledHistory = [];
          addToActivityLog("Game reset by admin", currentUser.id);
          await broadcastToAll({
            type: "game_state",
            state: {
              calledNumbers: [],
              remainingNumbers: gameState.remainingNumbers,
              lastCalledNumber: null,
              gameActive: false,
              gameStarted: false,
              currentRound: 1
            }
          });
          break;
      }
      break;
      
    case "admin_command":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      addToActivityLog(`Admin command: ${data.command}`, currentUser.id);
      await socket.send(JSON.stringify({
        type: "admin_command_result",
        message: `Command '${data.command}' executed`
      }));
      break;
      
    case "assign_package":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      const targetUser = Array.from(users.values()).find(u => u.deviceId === data.deviceId);
      if (targetUser) {
        targetUser.package = {
          type: data.packageType,
          price: data.packageType === "basic" ? 100 : data.packageType === "premium" ? 500 : 2000,
          expiryDate: new Date(data.expiryDate),
          locked: false
        };
        addToActivityLog(`Package assigned to ${data.deviceId}`, currentUser.id);
        await socket.send(JSON.stringify({
          type: "package_assigned",
          deviceId: data.deviceId
        }));
      }
      break;
      
    case "extend_package":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      const extendUser = Array.from(users.values()).find(u => u.deviceId === data.deviceId);
      if (extendUser && extendUser.package) {
        extendUser.package.expiryDate = new Date(data.expiryDate);
        addToActivityLog(`Package extended for ${data.deviceId}`, currentUser.id);
        await socket.send(JSON.stringify({
          type: "package_assigned",
          deviceId: data.deviceId
        }));
      }
      break;
      
    case "lock_package":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      const lockUser = Array.from(users.values()).find(u => u.deviceId === data.deviceId);
      if (lockUser && lockUser.package) {
        lockUser.package.locked = true;
        addToActivityLog(`Package locked for ${data.deviceId}`, currentUser.id);
        await socket.send(JSON.stringify({
          type: "device_status",
          deviceId: data.deviceId,
          status: "blocked"
        }));
      }
      break;
      
    case "approve_device":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      let device = devices.get(data.deviceId);
      if (!device) {
        device = {
          id: data.deviceId,
          userId: "",
          approved: true,
          blocked: false,
          lastSeen: new Date()
        };
        devices.set(data.deviceId, device);
      } else {
        device.approved = true;
        device.blocked = false;
      }
      
      addToActivityLog(`Device approved: ${data.deviceId}`, currentUser.id);
      await broadcastToAll({
        type: "device_status",
        deviceId: data.deviceId,
        status: "approved"
      });
      break;
      
    case "block_device":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      const blockDevice = devices.get(data.deviceId);
      if (blockDevice) {
        blockDevice.blocked = true;
      }
      
      addToActivityLog(`Device blocked: ${data.deviceId}`, currentUser.id);
      await broadcastToAll({
        type: "device_status",
        deviceId: data.deviceId,
        status: "blocked"
      });
      break;
      
    case "update_financials":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      if (data.ticketPrice) financialStats.ticketPrice = data.ticketPrice;
      if (data.prizeAmount) financialStats.prizeAmount = data.prizeAmount;
      
      addToActivityLog("Financials updated", currentUser.id);
      await broadcastToAll({
        type: "financial_update",
        totalRevenue: financialStats.totalRevenue,
        totalPayouts: financialStats.totalPayouts,
        profit: financialStats.profit
      });
      break;
      
    case "get_packages":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      // Send package list
      const packageList = Array.from(users.values())
        .filter(u => u.package)
        .map(u => ({
          deviceId: u.deviceId,
          package: u.package
        }));
      
      // You can implement sending package list here
      break;
      
    case "set_game_value":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      gameState.gameValue = data.value;
      await broadcastToAll({
        type: "game_state",
        state: { gameValue: gameState.gameValue }
      });
      break;
      
    case "set_rounds":
      if (!currentUser.isAdmin) {
        await socket.send(JSON.stringify({
          type: "error",
          message: "Admin access required"
        }));
        return;
      }
      
      gameState.totalRounds = data.rounds;
      await broadcastToAll({
        type: "game_state",
        state: { totalRounds: gameState.totalRounds }
      });
      break;
      
    case "shuffle":
      addToActivityLog("Numbers shuffled", currentUser.id);
      await broadcastToAll({
        type: "shuffle_started"
      });
      break;
      
    default:
      await socket.send(JSON.stringify({
        type: "error",
        message: "Unknown message type"
      }));
  }
}

// Broadcast to all connected clients
const clients = new Set<WebSocket>();

async function broadcastToAll(message: any) {
  const messageStr = JSON.stringify(message);
  const deadClients = new Set<WebSocket>();
  
  for (const client of clients) {
    try {
      await client.send(messageStr);
    } catch {
      deadClients.add(client);
    }
  }
  
  // Remove dead clients
  for (const dead of deadClients) {
    clients.delete(dead);
  }
}

// HTTP server
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  // WebSocket upgrade
  if (url.pathname === "/ws") {
    const deviceId = url.searchParams.get("deviceId") || "unknown";
    
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    
    const { socket, response } = Deno.upgradeWebSocket(req);
    const ws = socket as any; // Type workaround
    
    clients.add(ws);
    
    ws.onopen = () => {
      console.log(`WebSocket opened for device: ${deviceId}`);
    };
    
    ws.onmessage = async (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const data = JSON.parse(event.data);
          await handleMessage(ws, data, null, null);
        } catch (e) {
          console.error("Error handling message:", e);
        }
      }
    };
    
    ws.onclose = () => {
      clients.delete(ws);
      console.log(`WebSocket closed for device: ${deviceId}`);
    };
    
    ws.onerror = (error: Event) => {
      console.error("WebSocket error:", error);
      clients.delete(ws);
    };
    
    return response;
  }
  
  // Admin dashboard (simple HTML)
  if (url.pathname === "/admin" && url.searchParams.has("true")) {
    const adminHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bingo Admin Dashboard</title>
        <style>
          body { font-family: Arial; background: #111; color: #fff; padding: 20px; }
          .container { max-width: 1200px; margin: 0 auto; }
          h1 { color: goldenrod; }
          .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 20px 0; }
          .stat-card { background: #222; border: 2px solid goldenrod; padding: 20px; border-radius: 10px; }
          .stat-value { font-size: 2rem; color: #10b981; }
          .log { background: #222; border: 2px solid #3b82f6; padding: 10px; height: 300px; overflow-y: auto; font-family: monospace; }
          .log-entry { border-bottom: 1px solid #333; padding: 5px; }
          button { background: #3b82f6; color: white; border: none; padding: 10px 20px; margin: 5px; cursor: pointer; border-radius: 5px; }
          button:hover { background: #2563eb; }
          input, select { padding: 10px; margin: 5px; background: #333; border: 1px solid #666; color: white; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Bingo Admin Dashboard</h1>
          
          <div class="stats">
            <div class="stat-card">
              <h3>Total Revenue</h3>
              <div class="stat-value" id="revenue">0 ETB</div>
            </div>
            <div class="stat-card">
              <h3>Total Payouts</h3>
              <div class="stat-value" id="payouts">0 ETB</div>
            </div>
            <div class="stat-card">
              <h3>Profit</h3>
              <div class="stat-value" id="profit">0 ETB</div>
            </div>
          </div>
          
          <div>
            <h3>Game Control</h3>
            <button onclick="sendCommand('start')">Start Game</button>
            <button onclick="sendCommand('stop')">Stop Game</button>
            <button onclick="sendCommand('reset')">Reset Game</button>
          </div>
          
          <div>
            <h3>Activity Log</h3>
            <div class="log" id="log"></div>
          </div>
        </div>
        
        <script>
          const ws = new WebSocket('ws://' + location.host + '/ws?deviceId=admin-' + Math.random());
          
          ws.onopen = () => {
            console.log('Connected to admin WebSocket');
          };
          
          ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'financial_update') {
              document.getElementById('revenue').textContent = data.totalRevenue + ' ETB';
              document.getElementById('payouts').textContent = data.totalPayouts + ' ETB';
              document.getElementById('profit').textContent = data.profit + ' ETB';
            }
          };
          
          function sendCommand(cmd) {
            ws.send(JSON.stringify({
              type: 'admin_command',
              command: cmd
            }));
          }
        </script>
      </body>
      </html>
    `;
    
    return new Response(adminHtml, {
      headers: { "Content-Type": "text/html" }
    });
  }
  
  // Health check
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      connections: clients.size,
      users: users.size,
      gameActive: gameState.gameActive
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  
  // Default response
  return new Response("Bingo Game Server", { status: 200 });
}

// Start server
console.log(`Bingo WebSocket server running on port ${PORT}`);
await serve(handler, { port: PORT });