import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

// Game constants (Optimized for 2vCPU / 4GB RAM)
const GAME_WIDTH = 6000;
const GAME_HEIGHT = 6000;
const INITIAL_FOOD_COUNT = 2000; // Dense map coverage requested by user
const MAX_FOOD_COUNT = 2500;     // Allow more food on the map
const BASE_SNAKE_SPEED = 5;
const SNAKE_RADIUS = 12;
const FOOD_RADIUS = 6;
const MAX_SEGMENTS = 8000;      // Massive cap for ultra-long Boss snakes
const MAX_PLAYERS = 80;         // Max connections
const NETWORK_TICK_RATE = 20;   // Broadcast at 20fps
const PHYSICS_TICK_RATE = 60;   // Physics at 60fps
const VIEW_RADIUS = 1500;       // Viewport broadcasting radius
const SPATIAL_CELL_SIZE = 200;  // Spatial hash grid cell size

interface Player {
  id: string;
  name: string;
  color: string;
  segments: { x: number; y: number }[];
  angle: number;
  targetAngle?: number;
  score: number;
  isDead: boolean;
  isBoosting: boolean;
  isDashing: boolean;
  dashTimer: number;
  isPoisoned: boolean;
  poisonTimer: number;
  isBot?: boolean;
  activeBuff?: {
    type: "magnet" | "speed" | "invincibility";
    expiresAt: number;
  };
  portalCooldown: number;
  activeEmote?: { emoji: string; timer: number };
  isLeviathan?: boolean;
}

interface Food {
  id: string;
  x: number;
  y: number;
  color: string;
  value: number;
  type: "normal" | "powerup" | "magnet" | "speed" | "invincibility" | "poison";
}

interface BlackHole {
  id: string;
  x: number;
  y: number;
  radius: number;
  state: "warning" | "active" | "imploding";
  timer: number; // in frames
}

interface Wormhole {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  radius: number;
  state: "warning" | "active";
  timer: number; // in frames
}

interface MeteorShower {
  id: string;
  x: number;
  y: number;
  radius: number;
  state: "warning" | "active";
  timer: number; // in frames
}

interface FoodFrenzy {
  id: string;
  state: "active";
  timer: number; // in frames
}

interface LootZone {
  id: string;
  x: number;
  y: number;
  timer: number;
}

// ========== Spatial Hash Grid ==========
// Replaces brute-force O(n*m) collision with O(n*k) where k ≈ nearby entities
class SpatialGrid<T extends { id: string }> {
  private cells = new Map<string, T[]>();
  private entityCell = new Map<string, string>(); // track which cell each entity is in

  private key(x: number, y: number): string {
    return `${Math.floor(x / SPATIAL_CELL_SIZE)},${Math.floor(y / SPATIAL_CELL_SIZE)}`;
  }

  clear() {
    this.cells.clear();
    this.entityCell.clear();
  }

  insert(entity: T, x: number, y: number) {
    const k = this.key(x, y);
    let cell = this.cells.get(k);
    if (!cell) {
      cell = [];
      this.cells.set(k, cell);
    }
    cell.push(entity);
    this.entityCell.set(entity.id, k);
  }

  queryRadius(x: number, y: number, radius: number): T[] {
    const results: T[] = [];
    const minCX = Math.floor((x - radius) / SPATIAL_CELL_SIZE);
    const maxCX = Math.floor((x + radius) / SPATIAL_CELL_SIZE);
    const minCY = Math.floor((y - radius) / SPATIAL_CELL_SIZE);
    const maxCY = Math.floor((y + radius) / SPATIAL_CELL_SIZE);

    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const cell = this.cells.get(`${cx},${cy}`);
        if (cell) {
          for (const entity of cell) {
            results.push(entity);
          }
        }
      }
    }
    return results;
  }
}

// ========== Game State ==========
const players = new Map<string, Player>();
const foods = new Map<string, Food>();
const blackHoles = new Map<string, BlackHole>();
const wormholes = new Map<string, Wormhole>();
const meteorShowers = new Map<string, MeteorShower>();
const lootZones = new Map<string, LootZone>();
let activeFoodFrenzy: FoodFrenzy | null = null;

// Spatial grids — rebuilt every physics tick
const foodGrid = new SpatialGrid<Food>();
const playerGrid = new SpatialGrid<Player>();

// Pre-allocated arrays (avoid Array.from() per tick)
let playersArray: Player[] = [];
let foodsArray: Food[] = [];
let playersDirty = true;
let foodsDirty = true;

function markPlayersDirty() { playersDirty = true; }
function markFoodsDirty() { foodsDirty = true; }

function refreshArrays() {
  if (playersDirty) {
    playersArray = Array.from(players.values());
    playersDirty = false;
  }
  if (foodsDirty) {
    foodsArray = Array.from(foods.values());
    foodsDirty = false;
  }
}

// Helper to generate random color
function getRandomColor() {
  const colors = [
    "#FF5733",
    "#33FF57",
    "#3357FF",
    "#F033FF",
    "#33FFF0",
    "#FFC300",
    "#FF33A8",
    "#FF8C00",
    "#00FA9A",
    "#9370DB",
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Helper to get a safe spawn coordinate away from events
function getSafeSpawnPosition(): { x: number; y: number } {
  let x = Math.random() * GAME_WIDTH;
  let y = Math.random() * GAME_HEIGHT;

  // Try up to 10 times to find a safe spot
  for (let attempts = 0; attempts < 10; attempts++) {
    let isSafe = true;

    // Check Black Holes
    for (const bh of blackHoles.values()) {
      const dx = x - bh.x;
      const dy = y - bh.y;
      if (dx * dx + dy * dy < 640000) { // 800^2, avoid sqrt
        isSafe = false;
        break;
      }
    }

    // Check Meteor Showers
    if (isSafe) {
      for (const ms of meteorShowers.values()) {
        const dx = x - ms.x;
        const dy = y - ms.y;
        if (dx * dx + dy * dy < 640000) {
          isSafe = false;
          break;
        }
      }
    }

    if (isSafe) return { x, y };

    // Try new coordinates
    x = Math.random() * GAME_WIDTH;
    y = Math.random() * GAME_HEIGHT;
  }

  return { x, y }; // Fallback to whatever we have if it's too chaotic
}

// Helper to spawn food
function spawnFood(
  id?: string,
  x?: number,
  y?: number,
  value = 1, // Back to 1 since we have more food now
  type: "normal" | "powerup" | "magnet" | "speed" | "invincibility" | "poison" = "normal",
) {
  const foodId = id || Math.random().toString(36).substring(2, 9);
  let color = getRandomColor();
  if (type === "powerup") color = "#FFFFFF";
  else if (type === "magnet") color = "#33M4G" /* Custom ID logic here just colors for client parsing */;
  else if (type === "speed") color = "#5P33D";
  else if (type === "invincibility") color = "#1NV1N";
  else if (type === "poison") color = "#P01S0N";

  foods.set(foodId, {
    id: foodId,
    x: x ?? Math.random() * GAME_WIDTH,
    y: y ?? Math.random() * GAME_HEIGHT,
    color,
    value,
    type,
  });
  markFoodsDirty();

  // Optimize: prevent endless accumulation but don't arbitrarily wipe the map
  if (foods.size > MAX_FOOD_COUNT) {
    // Only delete 1 at a time randomly to keep it dense but capped
    const keysArray = Array.from(foods.keys());
    const randomKey = keysArray[Math.floor(Math.random() * keysArray.length)];
    foods.delete(randomKey);
    markFoodsDirty();
  }
}

// Initial food
for (let i = 0; i < INITIAL_FOOD_COUNT; i++) {
  spawnFood();
}

// Spawn powerups and buffs — more for better map coverage
for (let i = 0; i < 25; i++) {
  spawnFood(undefined, undefined, undefined, 50, "powerup");
}

for (let i = 0; i < 15; i++) {
  spawnFood(undefined, undefined, undefined, 0, "magnet");
  spawnFood(undefined, undefined, undefined, 0, "speed");
  spawnFood(undefined, undefined, undefined, 0, "invincibility");
}

// Helper to spawn bots
function spawnBot() {
  const safePos = getSafeSpawnPosition();
  const id = `bot_${Math.random().toString(36).substring(2, 9)}`;
  players.set(id, {
    id,
    name: `Bot ${Math.floor(Math.random() * 1000)}`,
    color: getRandomColor(),
    segments: [
      { x: safePos.x, y: safePos.y },
    ],
    angle: Math.random() * Math.PI * 2,
    targetAngle: Math.random() * Math.PI * 2,
    score: 20 + Math.random() * 50,
    isDead: false,
    isBoosting: false,
    isDashing: false,
    dashTimer: 0,
    isPoisoned: false,
    poisonTimer: 0,
    portalCooldown: 0,
    isBot: true,
    botState: {
      timer: 0,
      behavior: "wander"
    }
  } as Player & { botState: any });
  markPlayersDirty();
}

// Initial bots
for (let i = 0; i < 5; i++) {
  spawnBot();
}

function spawnLeviathan() {
  const isAlive = Array.from(players.values()).some((p) => p.isLeviathan);
  if (isAlive) return;

  const id = `leviathan_${Math.random().toString(36).substring(2, 9)}`;
  players.set(id, {
    id,
    name: "🐉 THE LEVIATHAN 🐉",
    color: "#ff4500", // OrangeRed
    segments: [
      { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 },
    ],
    angle: Math.random() * Math.PI * 2,
    targetAngle: Math.random() * Math.PI * 2,
    score: 15000, // Reduced from 50000 to prevent entity array overflow
    isDead: false,
    isBoosting: false,
    isDashing: false,
    dashTimer: 0,
    isPoisoned: false,
    poisonTimer: 0,
    portalCooldown: 0,
    isBot: true,
    isLeviathan: true,
    botState: {
      timer: 0,
      behavior: "wander"
    }
  } as Player & { botState: any });
  markPlayersDirty();

  (global as any).io?.emit("kill_feed", { killer: "SERVER", victim: "THE LEVIATHAN HAS AWOKEN" });
}

// Spawn Leviathan — rare event
function scheduleLeviathan() {
  const nextSpawnTimer = 300000 + Math.random() * 300000; // 5 to 10 minutes
  setTimeout(() => {
    spawnLeviathan();
    scheduleLeviathan();
  }, nextSpawnTimer);
}
scheduleLeviathan();

function spawnBlackHole() {
  if (blackHoles.size === 0) {
    const id = `bh_event`;
    blackHoles.set(id, {
      id,
      x: 800 + Math.random() * (GAME_WIDTH - 1600),
      y: 800 + Math.random() * (GAME_HEIGHT - 1600),
      radius: 60, // visual size of warning marker
      state: "warning",
      timer: 300 // 5 seconds warning at 60fps
    });
  }

  // Schedule the next one between 15 seconds and 2 minutes
  const nextSpawnDelay = 15000 + Math.random() * 120000;
  setTimeout(spawnBlackHole, nextSpawnDelay);
}

function spawnWormhole() {
  if (wormholes.size === 0) {
    const id = `wh_event`;
    wormholes.set(id, {
      id,
      x1: 200 + Math.random() * (GAME_WIDTH - 400),
      y1: 200 + Math.random() * (GAME_HEIGHT - 400),
      x2: 200 + Math.random() * (GAME_WIDTH - 400),
      y2: 200 + Math.random() * (GAME_HEIGHT - 400),
      radius: 80,
      state: "warning",
      timer: 300 // 5 seconds warning 
    });
  }

  // Schedule the next one between 15 seconds and 2 minutes
  const nextSpawnDelay = 15000 + Math.random() * 120000;
  setTimeout(spawnWormhole, nextSpawnDelay);
}

// Initial black holes
setTimeout(spawnBlackHole, 30000); // 30s before first event
setTimeout(spawnWormhole, 30000); // 30s before first event

function spawnMeteorShower() {
  if (meteorShowers.size === 0) {
    const id = `ms_event`;
    meteorShowers.set(id, {
      id,
      x: 800 + Math.random() * (GAME_WIDTH - 1600),
      y: 800 + Math.random() * (GAME_HEIGHT - 1600),
      radius: 400 + Math.random() * 400, // Massive 400-800 radius
      state: "warning",
      timer: 300 // 5 seconds warning 
    });
  }

  // Schedule next between 45s and 2.5m
  const nextSpawnDelay = 45000 + Math.random() * 105000;
  setTimeout(spawnMeteorShower, nextSpawnDelay);
}

function spawnFoodFrenzy() {
  if (!activeFoodFrenzy) {
    activeFoodFrenzy = {
      id: "ff_event",
      state: "active",
      timer: 900 // 15 seconds active duration
    };
  }

  // Schedule next between 1m and 3m
  const nextSpawnDelay = 60000 + Math.random() * 120000;
  setTimeout(spawnFoodFrenzy, nextSpawnDelay);
}

setTimeout(spawnMeteorShower, 45000);
setTimeout(spawnFoodFrenzy, 60000);

// ========== Physics Update (runs at 60fps) ==========
function updatePhysics() {
  refreshArrays();

  const bhArray = Array.from(blackHoles.values());
  const whArray = Array.from(wormholes.values());

  // Update wormholes
  for (const wh of whArray) {
    wh.timer--;
    if (wh.state === "warning" && wh.timer <= 0) {
      wh.state = "active";
      wh.timer = 1200; // 20 seconds active
    } else if (wh.state === "active" && wh.timer <= 0) {
      wormholes.delete(wh.id);
    }
  }

  // Update meteor showers
  const msArray = Array.from(meteorShowers.values());
  for (const ms of msArray) {
    ms.timer--;
    if (ms.state === "warning" && ms.timer <= 0) {
      // BOOM! Explosion happens instantly. Kill any snakes in the zone.
      for (const player of playersArray) {
        if (player.isDead) continue;
        const head = player.segments[0];
        const dx = head.x - ms.x;
        const dy = head.y - ms.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < ms.radius * ms.radius) {
          if (player.isLeviathan) {
            // Boss doesn't die instantly, just loses 25% of its mass/score
            player.score = Math.floor(player.score * 0.75);

            // Drop some mass
            for (let i = 0; i < 20; i++) {
              spawnFood(undefined, player.segments[0].x, player.segments[0].y, 5);
            }
          } else {
            player.isDead = true;
            for (let i = 0; i < player.segments.length; i += 2) {
              spawnFood(undefined, player.segments[i].x, player.segments[i].y, 3);
            }
          }
        }
      }

      // Spawn massive amounts of crystals/powerups
      for (let i = 0; i < 150; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * ms.radius;
        spawnFood(undefined, ms.x + Math.cos(angle) * dist, ms.y + Math.sin(angle) * dist, 5, "powerup");
      }

      // Register as a loot zone for 20 seconds (1200 frames) so clients get directional pointers
      lootZones.set(ms.id, {
        id: ms.id,
        x: ms.x,
        y: ms.y,
        timer: 1200
      });

      // Delete after it explodes
      meteorShowers.delete(ms.id);
    }
  }

  // Update Loot Zones
  for (const lz of lootZones.values()) {
    lz.timer--;
    if (lz.timer <= 0) {
      lootZones.delete(lz.id);
    }
  }

  // Update food frenzy
  if (activeFoodFrenzy) {
    activeFoodFrenzy.timer--;
    if (activeFoodFrenzy.timer <= 0) {
      activeFoodFrenzy = null;
    } else if (activeFoodFrenzy.timer % 5 === 0) {
      // Spawn high-value golden food everywhere rapidly
      for (let i = 0; i < 5; i++) {
        const foodId = Math.random().toString(36).substring(2, 9);
        foods.set(foodId, {
          id: foodId,
          x: Math.random() * GAME_WIDTH,
          y: Math.random() * GAME_HEIGHT,
          color: "#FFD700", // Golden
          value: 5,
          type: "normal"
        });
      }
      markFoodsDirty();
    }
  }

  // Update black holes
  for (const bh of bhArray) {
    bh.timer--;
    if (bh.state === "warning" && bh.timer <= 0) {
      bh.state = "active";
      bh.timer = 600; // 10 seconds active
      bh.radius = 150; // Initial active radius
    } else if (bh.state === "active") {
      bh.radius = Math.min(bh.radius + 0.8, 800); // Grows gradually up to massive 800
      if (bh.timer <= 0) {
        bh.state = "imploding";
        bh.timer = 10;
      }
    } else if (bh.state === "imploding" && bh.timer <= 0) {
      // Explode into massive food!
      for (let i = 0; i < 200; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * bh.radius;
        spawnFood(undefined, bh.x + Math.cos(angle) * dist, bh.y + Math.sin(angle) * dist, 5, "normal");
      }
      blackHoles.delete(bh.id);
    }
  }

  // Rebuild spatial grids for this tick
  foodGrid.clear();
  playerGrid.clear();
  refreshArrays(); // Refresh in case foods/players changed above

  for (const food of foodsArray) {
    foodGrid.insert(food, food.x, food.y);
  }
  for (const player of playersArray) {
    if (!player.isDead && player.segments.length > 0) {
      playerGrid.insert(player, player.segments[0].x, player.segments[0].y);
    }
  }

  // Update positions
  for (const player of playersArray) {
    if (player.isDead) continue;

    const now = Date.now();
    if (player.activeBuff && player.activeBuff.expiresAt < now) {
      player.activeBuff = undefined;
    }

    if (player.activeEmote) {
      player.activeEmote.timer--;
      if (player.activeEmote.timer <= 0) {
        player.activeEmote = undefined;
      }
    }

    // Calculate dynamic stats based on score
    // EXPONENTIAL SCALING: Aggressive growth curve
    // 1k ~ 37px, 10k ~ 92px, 50k ~ 190px
    const radius = 12 + Math.sqrt(player.score) * 0.8;
    // Larger snakes move slightly slower
    const speedScale = Math.max(0.6, 1 - (radius - 12) * 0.01);
    // Leviathan gets a speed bonus to feel more threatening
    const leviathanSpeedBonus = player.isLeviathan ? 1.4 : 1.0;
    const scaledSpeed = BASE_SNAKE_SPEED * speedScale * leviathanSpeedBonus;

    // Bot AI
    if (player.isBot) {
      let panic = false;
      let panicAngle = 0;
      const head = player.segments[0];
      const bot = player as any;

      // Leviathan NEVER panics — it's the apex predator
      if (!player.isLeviathan) {
        // 1. Avoid other snakes (panic mode, overrides everything)
        if (bot.botState.panicCooldown !== undefined && bot.botState.panicCooldown > 0) {
          bot.botState.panicCooldown--;
          panic = true;
          panicAngle = bot.botState.lastPanicAngle;
        } else {
          const nearbyPlayers = playerGrid.queryRadius(head.x, head.y, 200);
          for (const other of nearbyPlayers) {
            if (other.id === player.id || other.isDead) continue;

            for (const segment of other.segments) {
              const dx = segment.x - head.x;
              const dy = segment.y - head.y;
              const distSq = dx * dx + dy * dy;
              const avoidDist = radius * 2 + 50;

              if (distSq < avoidDist * avoidDist) {
                panicAngle = Math.atan2(-dy, -dx);
                panic = true;
                bot.botState.panicCooldown = 15;
                bot.botState.lastPanicAngle = panicAngle;
                break;
              }
            }
            if (panic) break;
          }
        }
      }

      if (panic) {
        player.targetAngle = panicAngle;
        if (player.score > 20) player.isBoosting = true;
      } else {
        // Normal behavior
        bot.botState.timer--;

        if (bot.botState.timer <= 0) {
          const rand = Math.random();
          if (player.isLeviathan) {
            // Leviathan has varied, challenging behaviors
            if (rand < 0.50) {
              bot.botState.behavior = "hunt_player";    // 50% — aggressively chase nearest human
              bot.botState.timer = 180 + Math.random() * 180; // 3-6 seconds of relentless hunting
            } else if (rand < 0.75) {
              bot.botState.behavior = "patrol";          // 25% — roam the map looking for prey
              bot.botState.timer = 120 + Math.random() * 120;
              bot.botState.patrolTarget = {
                x: 500 + Math.random() * (GAME_WIDTH - 1000),
                y: 500 + Math.random() * (GAME_HEIGHT - 1000)
              };
            } else if (rand < 0.90) {
              bot.botState.behavior = "ambush_circle";   // 15% — circle a player to trap them
              bot.botState.timer = 120 + Math.random() * 120;
              bot.botState.circleDir = Math.random() > 0.5 ? 1 : -1;
            } else {
              bot.botState.behavior = "charge";           // 10% — devastating dash charge
              bot.botState.timer = 60 + Math.random() * 60;
            }
          } else if (rand < 0.6) {
            bot.botState.behavior = "hunt";
            bot.botState.timer = 60 + Math.random() * 120;
          } else if (rand < 0.8 && player.score > 100) {
            bot.botState.behavior = "circle";
            bot.botState.timer = 120 + Math.random() * 180;
            bot.botState.circleDir = Math.random() > 0.5 ? 1 : -1;
          } else {
            bot.botState.behavior = "wander";
            bot.botState.timer = 30 + Math.random() * 60;
            player.targetAngle = player.angle + (Math.random() - 0.5) * Math.PI;
          }
        }

        if (bot.botState.behavior === "hunt_player") {
          let targetPlayer: Player | null = null;
          let bestDistSq = Infinity;

          for (const other of playersArray) {
            if (other.isDead || other.id === player.id || other.isBot) continue;
            const dx = other.segments[0].x - head.x;
            const dy = other.segments[0].y - head.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < bestDistSq && distSq < 9000000) {
              bestDistSq = distSq;
              targetPlayer = other;
            }
          }

          if (targetPlayer) {
            const targetHead = targetPlayer.segments[0];
            const dx = targetHead.x - head.x;
            const dy = targetHead.y - head.y;

            // Predictive aiming: aim ahead of where the target is going
            if (player.isLeviathan && targetPlayer.segments.length > 1) {
              const targetPrev = targetPlayer.segments[1];
              const velX = (targetHead.x - targetPrev.x) * 8; // Predict 8 frames ahead
              const velY = (targetHead.y - targetPrev.y) * 8;
              player.targetAngle = Math.atan2(dy + velY, dx + velX);
            } else {
              player.targetAngle = Math.atan2(dy, dx);
            }

            const dist = Math.sqrt(bestDistSq);
            // Leviathan is more aggressive — boosts from further away
            player.isBoosting = player.isLeviathan ? dist < 1500 : dist < 800;

            // Leviathan spawns traps more aggressively
            if (player.isLeviathan && Math.random() < 0.015 && wormholes.size < 3) {
              const whId = `wh_${Math.random().toString(36).substring(2, 9)}`;
              wormholes.set(whId, {
                id: whId,
                x1: targetHead.x + (Math.random() - 0.5) * 200,
                y1: targetHead.y + (Math.random() - 0.5) * 200,
                x2: head.x,
                y2: head.y,
                radius: 80,
                state: "warning",
                timer: 90 // Faster deployment
              });
            } else if (!player.isLeviathan && Math.random() < 0.01 && wormholes.size < 3) {
              const whId = `wh_${Math.random().toString(36).substring(2, 9)}`;
              wormholes.set(whId, {
                id: whId,
                x1: targetHead.x,
                y1: targetHead.y,
                x2: head.x,
                y2: head.y,
                radius: 80,
                state: "warning",
                timer: 120
              });
            }
          } else {
            player.isBoosting = false;
            bot.botState.behavior = player.isLeviathan ? "patrol" : "wander";
            if (player.isLeviathan) {
              bot.botState.patrolTarget = {
                x: 500 + Math.random() * (GAME_WIDTH - 1000),
                y: 500 + Math.random() * (GAME_HEIGHT - 1000)
              };
              bot.botState.timer = 120;
            }
          }
        } else if (player.isLeviathan && bot.botState.behavior === "patrol") {
          // Roam around the map looking for prey
          const target = bot.botState.patrolTarget;
          if (target) {
            const dx = target.x - head.x;
            const dy = target.y - head.y;
            const distSq = dx * dx + dy * dy;
            player.targetAngle = Math.atan2(dy, dx);
            player.isBoosting = false; // Conserve energy while patrolling

            // If close to patrol point, pick new one
            if (distSq < 90000) { // 300^2
              bot.botState.patrolTarget = {
                x: 500 + Math.random() * (GAME_WIDTH - 1000),
                y: 500 + Math.random() * (GAME_HEIGHT - 1000)
              };
            }

            // If a player is spotted during patrol, switch to hunt
            for (const other of playersArray) {
              if (other.isDead || other.id === player.id || other.isBot) continue;
              const pdx = other.segments[0].x - head.x;
              const pdy = other.segments[0].y - head.y;
              if (pdx * pdx + pdy * pdy < 4000000) { // 2000px detection range
                bot.botState.behavior = "hunt_player";
                bot.botState.timer = 180 + Math.random() * 120;
                break;
              }
            }
          }
        } else if (player.isLeviathan && bot.botState.behavior === "ambush_circle") {
          // Circle around the nearest player to trap them
          let nearestPlayer: Player | null = null;
          let nearestDistSq = Infinity;
          for (const other of playersArray) {
            if (other.isDead || other.id === player.id || other.isBot) continue;
            const dx = other.segments[0].x - head.x;
            const dy = other.segments[0].y - head.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < nearestDistSq) {
              nearestDistSq = distSq;
              nearestPlayer = other;
            }
          }

          if (nearestPlayer && nearestDistSq < 4000000) {
            // Circle around the target
            const dx = nearestPlayer.segments[0].x - head.x;
            const dy = nearestPlayer.segments[0].y - head.y;
            const angleToTarget = Math.atan2(dy, dx);
            // Perpendicular orbit + slight pull inward for spiral trap
            player.targetAngle = angleToTarget + (Math.PI / 2 * bot.botState.circleDir) - 0.15 * bot.botState.circleDir;
            player.isBoosting = true; // Fast circling
          } else {
            // No target nearby, switch to patrol
            bot.botState.behavior = "patrol";
            bot.botState.patrolTarget = {
              x: 500 + Math.random() * (GAME_WIDTH - 1000),
              y: 500 + Math.random() * (GAME_HEIGHT - 1000)
            };
            bot.botState.timer = 120;
          }
        } else if (player.isLeviathan && bot.botState.behavior === "charge") {
          // Pick nearest player and DASH at them
          let targetPlayer: Player | null = null;
          let bestDistSq = Infinity;
          for (const other of playersArray) {
            if (other.isDead || other.id === player.id || other.isBot) continue;
            const dx = other.segments[0].x - head.x;
            const dy = other.segments[0].y - head.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              targetPlayer = other;
            }
          }

          if (targetPlayer && bestDistSq < 9000000) {
            const dx = targetPlayer.segments[0].x - head.x;
            const dy = targetPlayer.segments[0].y - head.y;
            player.targetAngle = Math.atan2(dy, dx);
            player.isBoosting = true;

            // Trigger dash if close enough and not on cooldown
            if (bestDistSq < 640000 && !player.isDashing && player.dashTimer <= 0) {
              player.isDashing = true;
              player.dashTimer = 30;
            }
          } else {
            bot.botState.behavior = "hunt_player";
            bot.botState.timer = 120;
          }
        } else if (bot.botState.behavior === "hunt") {
          // Use spatial grid to find nearby food instead of iterating all
          const nearbyFoods = foodGrid.queryRadius(head.x, head.y, 1200);
          let targetFood: Food | null = null;
          let bestScore = -Infinity;
          let targetDistSq = 0;

          for (const food of nearbyFoods) {
            const dx = food.x - head.x;
            const dy = food.y - head.y;
            const distSq = dx * dx + dy * dy;

            let foodScore = (food.value * 50) - Math.sqrt(distSq);
            if (food.type === "magnet" || food.type === "speed" || food.type === "invincibility") {
              foodScore += 2000;
            }

            if (foodScore > bestScore && distSq < 1440000) {
              bestScore = foodScore;
              targetFood = food;
              targetDistSq = distSq;
            }
          }

          if (targetFood) {
            player.targetAngle = Math.atan2(targetFood.y - head.y, targetFood.x - head.x);
            if (targetDistSq < 40000 && (player.score > 50 || targetFood.value > 5)) {
              player.isBoosting = true;
            } else {
              player.isBoosting = false;
            }
          } else {
            player.isBoosting = false;
          }
        } else if (bot.botState.behavior === "circle") {
          player.isBoosting = false;
          player.targetAngle = player.angle + (0.05 * bot.botState.circleDir);
        } else {
          player.isBoosting = false;
        }

        // Avoid walls (Override normal behavior if too close)
        const margin = 200;
        if (head.x < margin) player.targetAngle = 0;
        else if (head.x > GAME_WIDTH - margin) player.targetAngle = Math.PI;
        else if (head.y < margin) player.targetAngle = Math.PI / 2;
        else if (head.y > GAME_HEIGHT - margin) player.targetAngle = -Math.PI / 2;
      }
    }

    // Smooth turn — Leviathan turns faster for fluid serpentine movement
    if (player.targetAngle !== undefined) {
      let diff = player.targetAngle - player.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;

      // Leviathan turns 2.5x faster — feels like a massive serpent gliding through the arena
      const baseTurnSpeed = player.isLeviathan ? 0.15 * 2.5 : 0.15;
      const turnSpeed = baseTurnSpeed * speedScale;

      let turnAmount = Math.sign(diff) * turnSpeed;
      if (player.isPoisoned) {
        turnAmount *= -1;
      }

      if (Math.abs(diff) < turnSpeed && !player.isPoisoned) {
        player.angle = player.targetAngle;
      } else {
        player.angle += turnAmount;
      }
    }

    let currentSpeed = scaledSpeed;

    // Speed buff makes base speed faster
    if (player.activeBuff?.type === "speed") {
      currentSpeed = scaledSpeed * 1.8;
    }

    if (player.isDashing) {
      player.dashTimer--;
      if (player.dashTimer <= 0) {
        player.isDashing = false;
      }
      currentSpeed = scaledSpeed * 3.5;
    } else if (player.isBoosting && player.score > 15) {
      currentSpeed = scaledSpeed * 2.2;
      if (player.activeBuff?.type !== "speed") {
        player.score -= 0.2;
      }

      // Randomly drop food behind while boosting
      if (Math.random() < 0.2) {
        const tail = player.segments[player.segments.length - 1];
        spawnFood(undefined, tail.x, tail.y, 1);
      }
    }

    if (player.isPoisoned) {
      player.poisonTimer--;
      if (player.poisonTimer <= 0) {
        player.isPoisoned = false;
      }
    }

    // Calculate Black Hole pulling vectors
    let pullX = 0;
    let pullY = 0;
    const head = player.segments[0];

    for (const bh of bhArray) {
      if (bh.state !== "active") continue;
      const dx = bh.x - head.x;
      const dy = bh.y - head.y;
      const distSq = dx * dx + dy * dy;
      const pullRange = bh.radius * 4;

      if (distSq < pullRange * pullRange) {
        const dist = Math.sqrt(distSq);
        const normalizedDist = Math.max(0, (pullRange - dist) / pullRange);
        const pullStrength = Math.pow(normalizedDist, 2) * 9.0;

        const angleToBh = Math.atan2(dy, dx);
        pullX += Math.cos(angleToBh) * pullStrength;
        pullY += Math.sin(angleToBh) * pullStrength;
      }
    }

    const newHead = {
      x: head.x + Math.cos(player.angle) * currentSpeed + pullX,
      y: head.y + Math.sin(player.angle) * currentSpeed + pullY,
    };

    // Boundary check
    if (newHead.x < 0) newHead.x = 0;
    if (newHead.x > GAME_WIDTH) newHead.x = GAME_WIDTH;
    if (newHead.y < 0) newHead.y = 0;
    if (newHead.y > GAME_HEIGHT) newHead.y = GAME_HEIGHT;

    // Portal teleportation check
    if (player.portalCooldown > 0) {
      player.portalCooldown--;
    } else {
      for (const wh of whArray) {
        if (wh.state !== "active") continue;

        let teleported = false;
        let destX = 0;
        let destY = 0;
        let srcX = 0;
        let srcY = 0;

        // Check Portal 1
        const dx1 = newHead.x - wh.x1;
        const dy1 = newHead.y - wh.y1;
        if (dx1 * dx1 + dy1 * dy1 < wh.radius * wh.radius) {
          srcX = wh.x1; srcY = wh.y1;
          destX = wh.x2; destY = wh.y2;
          teleported = true;
        }

        // Check Portal 2
        if (!teleported) {
          const dx2 = newHead.x - wh.x2;
          const dy2 = newHead.y - wh.y2;
          if (dx2 * dx2 + dy2 * dy2 < wh.radius * wh.radius) {
            srcX = wh.x2; srcY = wh.y2;
            destX = wh.x1; destY = wh.y1;
            teleported = true;
          }
        }

        if (teleported) {
          const offsetX = destX - srcX;
          const offsetY = destY - srcY;
          newHead.x += offsetX;
          newHead.y += offsetY;

          // Translate the entire body so it doesn't stretch across the map
          for (const seg of player.segments) {
            seg.x += offsetX;
            seg.y += offsetY;
          }
          player.portalCooldown = 180;
          break;
        }
      }
    }

    player.segments.unshift(newHead);

    // Determine length based on score — with hard cap
    // Use an aggressive power curve (0.75) so the length grows much faster than the sqrt radius
    const rawLength = Math.floor(20 + Math.pow(player.score, 0.75) * 2);
    const targetLength = Math.min(rawLength, MAX_SEGMENTS);
    while (player.segments.length > targetLength) {
      player.segments.pop();
    }
  }

  // Check collisions (using spatial grid for nearby entities)
  for (const player of playersArray) {
    if (player.isDead) continue;

    const head = player.segments[0];
    const radius = 12 + Math.sqrt(player.score) * 0.8; // Sync with new aggressive global radius

    // 1. Food collision and magnet logic — use spatial grid
    const magnetRadius = (player.activeBuff?.type === "magnet") ? 150 : 0;
    // Authentic Slither.io natural head aura (even without buff, ~1.5x body radius)
    const naturalMagnetRadius = radius * 1.5;
    const searchRadius = Math.max(radius + FOOD_RADIUS + 10, Math.max(magnetRadius, naturalMagnetRadius));
    const nearbyFoods = foodGrid.queryRadius(head.x, head.y, searchRadius);

    for (const food of nearbyFoods) {
      // Check if food still exists (may have been eaten by another player this tick)
      if (!foods.has(food.id)) continue;

      const dx = head.x - food.x;
      const dy = head.y - food.y;
      const distSq = dx * dx + dy * dy;
      const dist = Math.sqrt(distSq);

      // Magnet pull logic
      const isBuffMagnet = magnetRadius > 0 && dist < magnetRadius;
      const isNaturalMagnet = dist < naturalMagnetRadius;

      if ((isBuffMagnet || isNaturalMagnet) && dist > radius) {
        const pullSpeed = isBuffMagnet ? 10 : 4;
        const angle = Math.atan2(head.y - food.y, head.x - food.x);
        const actualFood = foods.get(food.id);
        if (actualFood) {
          actualFood.x += Math.cos(angle) * pullSpeed;
          actualFood.y += Math.sin(angle) * pullSpeed;
        }
      }

      let swallowedByBh = false;
      // Check food vs Black holes
      for (const bh of blackHoles.values()) {
        if (bh.state !== "active") continue;
        const dxBh = bh.x - food.x;
        const dyBh = bh.y - food.y;
        const distBhSq = dxBh * dxBh + dyBh * dyBh;

        if (distBhSq < bh.radius * bh.radius) {
          foods.delete(food.id);
          markFoodsDirty();
          bh.radius = Math.min(bh.radius + 0.1, 800);
          swallowedByBh = true;
          break;
        } else if (distBhSq < (bh.radius * 4) * (bh.radius * 4)) {
          const pullForce = 2.0;
          const pullAngle = Math.atan2(dyBh, dxBh);
          const actualFood = foods.get(food.id);
          if (actualFood) {
            actualFood.x += Math.cos(pullAngle) * pullForce;
            actualFood.y += Math.sin(pullAngle) * pullForce;
          }
        }
      }

      if (swallowedByBh) continue;

      if (dist < radius + FOOD_RADIUS) {
        if (food.type === "magnet" || food.type === "speed" || food.type === "invincibility") {
          player.activeBuff = {
            type: food.type as any,
            expiresAt: Date.now() + 10000
          };
        } else if (food.type === "poison") {
          player.isPoisoned = true;
          player.poisonTimer = 180;
        } else {
          player.score += food.value;
        }
        foods.delete(food.id);
        markFoodsDirty();

        // Respawn the food with correct type
        if (food.type === "normal" || food.type === "powerup") {
          spawnFood(undefined, undefined, undefined, food.value, food.type);
        } else {
          setTimeout(() => {
            spawnFood(undefined, undefined, undefined, 0, food.type);
          }, 2000 + Math.random() * 3000);
        }
      }
    }

    // 2. Snake collision
    if (player.activeBuff?.type === "invincibility") {
      continue;
    }

    // Use spatial grid + check nearby players only
    const nearbyPlayersList = playerGrid.queryRadius(head.x, head.y, 500);
    for (const otherPlayer of nearbyPlayersList) {
      if (player.id === otherPlayer.id || otherPlayer.isDead) continue;
      if (player.isDead) break;

      for (let j = 0; j < otherPlayer.segments.length; j++) {
        const segment = otherPlayer.segments[j];
        const dx = head.x - segment.x;
        const dy = head.y - segment.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < (radius * 1.8) * (radius * 1.8)) {
          if (player.isDashing && !otherPlayer.activeBuff?.type && !otherPlayer.isDashing) {
            otherPlayer.isDead = true;

            (global as any).io?.emit("kill_feed", { killer: player.name, victim: otherPlayer.name });

            for (let i = 0; i < otherPlayer.segments.length; i += 2) {
              const value = otherPlayer.isLeviathan ? 50 : 3;
              const type = otherPlayer.isLeviathan && Math.random() > 0.8 ? "powerup" : "normal";
              spawnFood(undefined, otherPlayer.segments[i].x, otherPlayer.segments[i].y, value, type as any);
            }
            if (otherPlayer.isBot && !otherPlayer.isLeviathan) {
              setTimeout(spawnBot, 3000);
            }
            break;
          } else {
            player.isDead = true;

            (global as any).io?.emit("kill_feed", { killer: otherPlayer.name, victim: player.name });

            for (let i = 0; i < player.segments.length; i += 2) {
              const value = player.isLeviathan ? 50 : 3;
              const type = player.isLeviathan && Math.random() > 0.8 ? "powerup" : "normal";
              spawnFood(undefined, player.segments[i].x, player.segments[i].y, value, type as any);
            }
            if (player.isBot && !player.isLeviathan) {
              setTimeout(spawnBot, 3000);
            }
            break;
          }
        }
      }
    }

    // If dead, skip black hole checks
    if (player.isDead) continue;

    // 3. Black Hole Collision
    for (const bh of blackHoles.values()) {
      if (bh.state !== "active") continue;
      const dx = head.x - bh.x;
      const dy = head.y - bh.y;
      const distSq = dx * dx + dy * dy;

      if (distSq < (bh.radius - 10) * (bh.radius - 10)) {
        if (player.isLeviathan) {
          player.score = Math.max(10, player.score - 5);
          player.targetAngle = player.angle + Math.PI;
          player.portalCooldown = 60;
        } else {
          player.isDead = true;
          for (let i = 0; i < player.segments.length; i += 2) {
            const rx = player.segments[i].x + (Math.random() - 0.5) * 50;
            const ry = player.segments[i].y + (Math.random() - 0.5) * 50;
            spawnFood(undefined, rx, ry, 3);
          }
          if (player.isBot) {
            setTimeout(spawnBot, 3000);
          }
          break;
        }
      }
    }
  }

  // Mark dirty since players might have died / moved
  markPlayersDirty();
}

// ========== Network Broadcast (runs at 20fps) ==========
function broadcastState(ioServer: Server) {
  refreshArrays();

  const bhArray = Array.from(blackHoles.values());
  const whArray = Array.from(wormholes.values());
  const msArray = Array.from(meteorShowers.values());
  const lzArray = Array.from(lootZones.values());

  // Remove dead players (do this in broadcast tick to avoid mid-physics deletion)
  for (const player of playersArray) {
    if (player.isDead) {
      players.delete(player.id);
      ioServer.to(player.id).emit("dead");
      markPlayersDirty();
    }
  }

  // Refresh after removing dead players
  refreshArrays();

  // Global events are always sent (they're tiny)
  const globalEvents = {
    blackHoles: bhArray,
    wormholes: whArray,
    meteorShowers: msArray,
    lootZones: lzArray,
    foodFrenzy: activeFoodFrenzy,
  };

  // For each connected human player, send only nearby entities (viewport-aware)
  const sockets = ioServer.sockets.sockets;
  for (const [socketId, socket] of sockets) {
    const player = players.get(socketId);
    if (!player || player.isDead || player.segments.length === 0) continue;

    const headX = player.segments[0].x;
    const headY = player.segments[0].y;
    const viewRadiusSq = VIEW_RADIUS * VIEW_RADIUS;

    // Filter nearby players
    const nearbyPlayers = [];
    for (const p of playersArray) {
      if (p.segments.length === 0) continue;
      const dx = p.segments[0].x - headX;
      const dy = p.segments[0].y - headY;
      if (dx * dx + dy * dy < viewRadiusSq || p.id === socketId) {
        // Stride segments for network — send ~100 points max
        const stride = Math.max(1, Math.floor(p.segments.length / 100));
        const networkSegments: { x: number; y: number }[] = [];
        for (let i = 0; i < p.segments.length; i += stride) {
          networkSegments.push(p.segments[i]);
        }
        // Always include the last segment for tail rendering
        if (p.segments.length > 1) {
          const lastSeg = p.segments[p.segments.length - 1];
          const lastAdded = networkSegments[networkSegments.length - 1];
          if (lastAdded !== lastSeg) {
            networkSegments.push(lastSeg);
          }
        }

        nearbyPlayers.push({
          id: p.id,
          name: p.name,
          color: p.color,
          segments: networkSegments,
          score: Math.floor(p.score),
          isBot: p.isBot,
          isBoosting: p.isBoosting,
          isDashing: p.isDashing,
          isPoisoned: p.isPoisoned,
          activeBuff: p.activeBuff,
          activeEmote: p.activeEmote,
          isLeviathan: p.isLeviathan,
        });
      }
    }

    // Filter nearby foods
    const nearbyFoods: Food[] = [];
    for (const f of foodsArray) {
      const dx = f.x - headX;
      const dy = f.y - headY;
      if (dx * dx + dy * dy < viewRadiusSq) {
        nearbyFoods.push(f);
      }
    }

    // Send full leaderboard always (it's tiny)
    socket.emit("state", {
      players: nearbyPlayers,
      foods: nearbyFoods,
      ...globalEvents,
      // Include the full leaderboard data for the HUD
      leaderboard: playersArray
        .filter(p => !p.isDead)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(p => ({ id: p.id, name: p.name, score: Math.floor(p.score) })),
    });
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const ioServer = new Server(server, {
    cors: { origin: "*" },
    perMessageDeflate: {
      threshold: 512,  // Compress payloads > 512 bytes
    },
    maxHttpBufferSize: 1e6,
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  // Assign io globally so spawnLeviathan can use it
  Object.assign(global, { io: ioServer });

  ioServer.on("connection", (socket) => {
    // Enforce player cap
    if (players.size >= MAX_PLAYERS) {
      socket.emit("server_full", { message: "Server is full. Try again later." });
      socket.disconnect(true);
      return;
    }

    console.log("Player connected:", socket.id);

    socket.on("join", (data: { name: string; color: string }) => {
      const safePos = getSafeSpawnPosition();
      players.set(socket.id, {
        id: socket.id,
        name: data.name || "Anonymous",
        color: data.color || getRandomColor(),
        segments: [
          { x: safePos.x, y: safePos.y },
        ],
        angle: Math.random() * Math.PI * 2,
        score: 10,
        isDead: false,
        isBoosting: false,
        isDashing: false,
        dashTimer: 0,
        isPoisoned: false,
        poisonTimer: 0,
        portalCooldown: 0,
      });
      markPlayersDirty();

      socket.emit("init", {
        id: socket.id,
        gameWidth: GAME_WIDTH,
        gameHeight: GAME_HEIGHT,
      });
    });

    socket.on("input", (data: { angle: number; isBoosting: boolean; isDashing?: boolean; dropPoison?: boolean }) => {
      const player = players.get(socket.id);
      if (player && !player.isDead) {
        player.targetAngle = data.angle;
        player.isBoosting = data.isBoosting;

        // Handle Dash initialization
        if (data.isDashing && !player.isDashing && player.score > 100 && player.dashTimer <= 0) {
          player.isDashing = true;
          player.dashTimer = 30;
          player.score -= 50;
        }

        // Handle dropping poison
        if (data.dropPoison && player.score > 20) {
          player.score -= 10;
          const tail = player.segments[player.segments.length - 1];
          if (tail) {
            spawnFood(undefined, tail.x, tail.y, 10, "poison" as any);
          }
        }
      }
    });

    socket.on("emote", (emoji: string) => {
      const player = players.get(socket.id);
      if (player && !player.isDead) {
        player.activeEmote = { emoji, timer: 180 };
      }
    });

    socket.on("disconnect", () => {
      console.log("Player disconnected:", socket.id);
      players.delete(socket.id);
      markPlayersDirty();
    });
  });

  // Physics loop (60 FPS) — CPU only, zero I/O
  setInterval(updatePhysics, 1000 / PHYSICS_TICK_RATE);

  // Network loop (20 FPS) — serialize + broadcast
  setInterval(() => broadcastState(ioServer), 1000 / NETWORK_TICK_RATE);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));

    // SPA routing: serve index.html for any unknown routes (Express 5 compatible)
    app.use((_, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
