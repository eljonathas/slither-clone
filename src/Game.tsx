import React, { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Joystick } from "react-joystick-component";
import bgImageSrc from "./assets/bg.png";

const bgImg = new Image();
bgImg.src = bgImageSrc;
let bgPattern: CanvasPattern | null = null;

interface GameProps {
  playerName: string;
  playerColor: string;
  onDeath: () => void;
}

interface Player {
  id: string;
  name: string;
  color: string;
  segments: { x: number; y: number }[];
  score: number;
  isBoosting?: boolean;
  activeBuff?: {
    type: "magnet" | "speed" | "invincibility";
    expiresAt: number;
  };
  isDashing?: boolean;
  isPoisoned?: boolean;
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
  timer: number;
}

interface Wormhole {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  radius: number;
  state: "warning" | "active";
  timer: number;
}

interface MeteorShower {
  id: string;
  x: number;
  y: number;
  radius: number;
  state: "warning" | "active";
  timer: number;
}

interface FoodFrenzy {
  id: string;
  state: "active";
  timer: number;
}

interface LootZone {
  id: string;
  x: number;
  y: number;
  timer: number;
}

interface LeaderboardEntry {
  id: string;
  name: string;
  score: number;
}

interface GameState {
  players: Player[];
  foods: Food[];
  blackHoles?: BlackHole[];
  wormholes?: Wormhole[];
  meteorShowers?: MeteorShower[];
  lootZones?: LootZone[];
  foodFrenzy?: FoodFrenzy;
  leaderboard?: LeaderboardEntry[];
}

function resolveSocketUrl() {
  const envUrl = import.meta.env.VITE_SOCKET_URL?.trim();
  if (envUrl) return envUrl;

  const serverPort = import.meta.env.PORT?.trim();

  // In local Vite dev, the frontend can run on a different port than the socket server.
  if (
    import.meta.env.DEV &&
    serverPort &&
    window.location.port !== serverPort
  ) {
    return `${window.location.protocol}//${window.location.hostname}:${serverPort}`;
  }

  return undefined;
}

export default function Game({ playerName, playerColor, onDeath }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const [score, setScore] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const leaderboardRef = useRef<LeaderboardEntry[]>([]); // Stale closure bypass
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  // Game state refs for rendering loop — state buffer for smooth interpolation
  const gameStateRef = useRef<GameState>({
    players: [],
    foods: [],
    blackHoles: [],
  });
  const stateBufferRef = useRef<{ state: GameState; time: number }[]>([]);
  const RENDER_DELAY = 60; // Render 60ms behind real-time (just over 1 tick at 20fps) for smooth interpolation
  const myIdRef = useRef<string>("");
  const killFeedRef = useRef<
    { id: string; killer: string; victim: string; timer: number }[]
  >([]);
  const gameSizeRef = useRef({ width: 3000, height: 3000 });
  const mousePosRef = useRef({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  const cameraRef = useRef({ x: 0, y: 0 });
  const cameraInitializedRef = useRef(false);
  const lastInputAngleRef = useRef<number | null>(null);
  const lastInputTimeRef = useRef<number>(0);
  const lastBoostingRef = useRef(false);

  const keysRef = useRef<{ [key: string]: boolean }>({});
  const isBoostingRef = useRef(false);
  const isDashingRef = useRef(false);
  const dropPoisonRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      keysRef.current[e.key] = true;
      if (e.code === "Space") {
        isBoostingRef.current = true;
      }
      if (e.key === "q" || e.key === "Q") {
        dropPoisonRef.current = true;
      }
      // Emote shortcuts
      const emoteMap: Record<string, string> = {
        "1": "😂",
        "2": "😡",
        "3": "😭",
        "4": "💀",
        "5": "🎯",
        "6": "🔥",
      };
      if (emoteMap[e.key] && socketRef.current) {
        socketRef.current.emit("emote", emoteMap[e.key]);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      keysRef.current[e.key] = false;
      if (e.code === "Space") {
        isBoostingRef.current = false;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    // Mobile detection
    const checkMobile = () => {
      setIsMobile(
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
          navigator.userAgent,
        ) || navigator.maxTouchPoints > 0,
      );
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("resize", checkMobile);
    };
  }, []);

  const [isDead, setIsDead] = useState(false);

  useEffect(() => {
    // Connect to server
    const socketUrl = resolveSocketUrl();
    const socket = socketUrl ? io(socketUrl) : io();
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnectionError(null);
      myIdRef.current = socket.id || "";
      socket.emit("join", { name: playerName, color: playerColor });
    });

    socket.on("init", (data) => {
      myIdRef.current = data.id;
      gameSizeRef.current = { width: data.gameWidth, height: data.gameHeight };
      if (!cameraInitializedRef.current) {
        cameraRef.current = { x: data.gameWidth / 2, y: data.gameHeight / 2 };
      }
    });

    socket.on("state", (state: GameState) => {
      // Push to state buffer with timestamp for smooth interpolation
      stateBufferRef.current.push({ state, time: performance.now() });
      // Keep only last 10 states to avoid memory leak
      while (stateBufferRef.current.length > 10) {
        stateBufferRef.current.shift();
      }

      // Update score
      const me = state.players.find((p) => p.id === myIdRef.current);
      if (me) {
        setScore(me.score);
        if (!cameraInitializedRef.current && me.segments.length > 0) {
          const head = me.segments[0];
          cameraRef.current = { x: head.x, y: head.y };
          cameraInitializedRef.current = true;
        }
      }

      // Use server-provided leaderboard (includes all players, not just viewport)
      if (state.leaderboard) {
        setLeaderboard(state.leaderboard);
        leaderboardRef.current = state.leaderboard;
      }
    });

    socket.on("connect_error", () => {
      setConnectionError(
        "Nao foi possivel conectar ao servidor do jogo. Verifique se o backend esta rodando na porta 3000.",
      );
    });

    socket.on("kill_feed", (data: { killer: string; victim: string }) => {
      killFeedRef.current.push({
        id: Math.random().toString(36).substr(2, 9),
        killer: data.killer,
        victim: data.victim,
        timer: 300, // 5 seconds at 60fps approx
      });
      if (killFeedRef.current.length > 5) {
        killFeedRef.current.shift();
      }
    });

    socket.on("dead", () => {
      setIsDead(true);
      setTimeout(() => {
        onDeath();
      }, 2000); // Wait 2s before going back to menu
    });

    return () => {
      socket.disconnect();
    };
  }, [playerName, playerColor, onDeath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;

    const render = () => {
      // Resize canvas if needed
      if (
        canvas.width !== window.innerWidth ||
        canvas.height !== window.innerHeight
      ) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
      }

      // State Buffer Interpolation: render at (now - RENDER_DELAY) for perfectly smooth movement
      // This ensures we always have two complete server snapshots to interpolate between
      const buffer = stateBufferRef.current;
      const renderTime = performance.now() - RENDER_DELAY;

      let state: GameState;

      if (buffer.length >= 2) {
        // Find the two states that bracket our render time
        let fromIdx = 0;
        for (let i = buffer.length - 1; i > 0; i--) {
          if (buffer[i - 1].time <= renderTime) {
            fromIdx = i - 1;
            break;
          }
        }
        const toIdx = Math.min(fromIdx + 1, buffer.length - 1);

        const fromState = buffer[fromIdx].state;
        const toState = buffer[toIdx].state;
        const fromTime = buffer[fromIdx].time;
        const toTime = buffer[toIdx].time;
        const duration = toTime - fromTime;
        const t =
          duration > 0
            ? Math.max(0, Math.min(1, (renderTime - fromTime) / duration))
            : 1;

        // Interpolate player positions
        const interpolatedPlayers = toState.players.map((np) => {
          const pp = fromState.players.find((p) => p.id === np.id);
          if (!pp || pp.segments.length === 0 || np.segments.length === 0)
            return np;

          const interpSegments = np.segments.map((ns, i) => {
            const ps = pp.segments[i] || pp.segments[pp.segments.length - 1];
            return {
              x: ps.x + (ns.x - ps.x) * t,
              y: ps.y + (ns.y - ps.y) * t,
            };
          });

          return { ...np, segments: interpSegments };
        });

        state = {
          ...toState,
          players: interpolatedPlayers,
        };
      } else if (buffer.length === 1) {
        state = buffer[0].state;
      } else {
        state = gameStateRef.current;
      }

      gameStateRef.current = state;

      const myId = myIdRef.current;
      const me = state.players.find((p) => p.id === myId);

      // Update camera position to follow player smoothly
      if (me && me.segments.length > 0) {
        const head = me.segments[0];
        // Lerp camera
        cameraRef.current.x += (head.x - cameraRef.current.x) * 0.2;
        cameraRef.current.y += (head.y - cameraRef.current.y) * 0.2;
      }

      const cx = cameraRef.current.x;
      const cy = cameraRef.current.y;
      const hw = canvas.width / 2;
      const hh = canvas.height / 2;

      // Calculate camera zoom level dynamically based on score
      let baseZoom = 1.0;
      if (me) {
        // Make the Zoom Out math mirror the Sqrt Growth Math so it never artificially shrinks back down
        // 10k score -> zoom ~0.66. 50k score -> zoom ~0.47
        baseZoom = Math.max(0.15, 1.0 / (1 + Math.sqrt(me.score) / 200));
      }

      let targetZoom = baseZoom;
      if (me?.isBoosting) {
        targetZoom = baseZoom * 0.85; // Extra 15% zoom out when boosting
      }

      // We need a ref for smooth zoom interpolation
      if (!(window as any).currentZoom) {
        (window as any).currentZoom = 1.0;
      }
      (window as any).currentZoom +=
        (targetZoom - (window as any).currentZoom) * 0.05;
      const zoom = (window as any).currentZoom;

      // Clear background
      ctx.fillStyle = "#111111";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Add screen shake for active meteors and Event Horizon (Black Hole Terror)
      let shakeX = 0;
      let shakeY = 0;
      let voidGravityRatio = 0;

      if (state.meteorShowers) {
        for (const ms of state.meteorShowers) {
          if (ms.state === "warning" && ms.timer < 30) {
            shakeX += (Math.random() - 0.5) * 30;
            shakeY += (Math.random() - 0.5) * 30;
          }
        }
      }

      if (me && state.blackHoles) {
        const myHead = me.segments[0];
        if (myHead) {
          for (const bh of state.blackHoles) {
            if (bh.state === "active" || bh.state === "imploding") {
              const dx = bh.x - myHead.x;
              const dy = bh.y - myHead.y;
              const dist = Math.sqrt(dx * dx + dy * dy);

              // If within pull radius, calculate terror ratio
              if (dist < bh.radius * 4 && dist > 10) {
                const gravityRatio = 1 - dist / (bh.radius * 4); // 0 = far, 1 = event horizon
                voidGravityRatio = Math.max(voidGravityRatio, gravityRatio);

                const terrorShake = gravityRatio * 20; // up to 20px violent shake
                shakeX += (Math.random() - 0.5) * terrorShake;
                shakeY += (Math.random() - 0.5) * terrorShake;
              }
            }
          }
        }
      }

      ctx.save();

      // Apply zoom from screen center and screen shake
      ctx.translate(hw + shakeX, hh + shakeY);
      ctx.scale(zoom, zoom);
      ctx.translate(-cx, -cy);

      // Draw grid
      ctx.strokeStyle = "#222222";
      ctx.lineWidth = 1;
      const gridSize = 50;

      const viewW = canvas.width / zoom;
      const viewH = canvas.height / zoom;
      const viewHW = viewW / 2;
      const viewHH = viewH / 2;

      // Draw across entire visible camera bounds, stopping at map edges
      const startX = Math.max(
        0,
        Math.floor((cx - viewHW) / gridSize) * gridSize,
      );
      const startY = Math.max(
        0,
        Math.floor((cy - viewHH) / gridSize) * gridSize,
      );
      const endX = Math.min(gameSizeRef.current.width, cx + viewHW);
      const endY = Math.min(gameSizeRef.current.height, cy + viewHH);

      // Frustum Culling limits (Screen bounds + 200px buffer)
      const cullStartX = cx - viewHW - 200;
      const cullStartY = cy - viewHH - 200;
      const cullEndX = cx + viewHW + 200;
      const cullEndY = cy + viewHH + 200;

      // Draw custom background seamlessly over the viewport
      if (!bgPattern && bgImg.complete) {
        bgPattern = ctx.createPattern(bgImg, "repeat");
      }

      if (bgPattern) {
        ctx.globalAlpha = 0.3; // Low opacity for contrast
        ctx.fillStyle = bgPattern;
        // The pattern aligns to canvas 0,0 automatically even if we only fill a subsection
        ctx.fillRect(startX, startY, endX - startX, endY - startY);
        ctx.globalAlpha = 1.0;
      }

      ctx.beginPath();
      for (let x = startX; x <= endX; x += gridSize) {
        ctx.moveTo(x, startY);
        ctx.lineTo(x, endY);
      }
      for (let y = startY; y <= endY; y += gridSize) {
        ctx.moveTo(startX, y);
        ctx.lineTo(endX, y);
      }
      ctx.stroke();

      // Draw bounds
      ctx.strokeStyle = "#FF3333";
      ctx.lineWidth = 5;
      ctx.strokeRect(
        0,
        0,
        gameSizeRef.current.width,
        gameSizeRef.current.height,
      );

      // Draw Black Holes
      const blackHoles = state.blackHoles || [];
      for (const bh of blackHoles) {
        if (bh.state === "warning") {
          // Draw blinking red marker. Blinks faster when timer is < 60 fps (last second)
          const blinkRate = bh.timer < 60 ? 100 : 250;
          const blink = Math.floor(Date.now() / blinkRate) % 2 === 0;
          ctx.beginPath();
          ctx.arc(bh.x, bh.y, bh.radius, 0, Math.PI * 2);
          ctx.fillStyle = blink
            ? "rgba(255, 0, 0, 0.5)"
            : "rgba(255, 0, 0, 0.1)";
          ctx.fill();

          ctx.beginPath();
          ctx.arc(bh.x, bh.y, bh.radius, 0, Math.PI * 2);
          ctx.strokeStyle = "red";
          ctx.lineWidth = 4;
          ctx.stroke();

          // Crosshair lines
          ctx.beginPath();
          ctx.moveTo(bh.x - bh.radius * 1.5, bh.y);
          ctx.lineTo(bh.x + bh.radius * 1.5, bh.y);
          ctx.moveTo(bh.x, bh.y - bh.radius * 1.5);
          ctx.lineTo(bh.x, bh.y + bh.radius * 1.5);
          ctx.strokeStyle = "red";
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (bh.state === "active") {
          ctx.beginPath();
          ctx.arc(bh.x, bh.y, bh.radius, 0, Math.PI * 2);

          // Gradient for black hole
          const grad = ctx.createRadialGradient(
            bh.x,
            bh.y,
            0,
            bh.x,
            bh.y,
            bh.radius,
          );
          grad.addColorStop(0, "black");
          grad.addColorStop(0.7, "rgba(20, 0, 40, 0.8)");
          grad.addColorStop(1, "rgba(50, 0, 100, 0)");

          ctx.fillStyle = grad;
          ctx.fill();

          // Accretion disk spin
          ctx.save();
          ctx.translate(bh.x, bh.y);
          ctx.rotate(Date.now() / 300); // slow spin
          ctx.beginPath();
          ctx.arc(
            0,
            0,
            bh.radius + Math.sin(Date.now() / 150) * 15,
            0,
            Math.PI * 2,
          );
          ctx.strokeStyle = "rgba(168, 85, 247, 0.4)"; // purple glowing edge
          ctx.lineWidth = 5;
          ctx.setLineDash([20, 15]);
          ctx.stroke();
          ctx.setLineDash([]); // reset
          ctx.restore();
        }
      }

      // Draw Wormholes
      const wormholes = state.wormholes || [];
      for (const wh of wormholes) {
        if (wh.state === "warning") {
          // Draw blinking rings
          const blink = Math.floor(Date.now() / 200) % 2 === 0;
          if (blink) {
            ctx.beginPath();
            ctx.arc(wh.x1, wh.y1, wh.radius, 0, Math.PI * 2);
            ctx.strokeStyle = "cyan";
            ctx.lineWidth = 4;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(wh.x2, wh.y2, wh.radius, 0, Math.PI * 2);
            ctx.strokeStyle = "orange";
            ctx.lineWidth = 4;
            ctx.stroke();
          }
        } else if (wh.state === "active") {
          // Portal 1: Cyan
          ctx.beginPath();
          ctx.arc(wh.x1, wh.y1, wh.radius, 0, Math.PI * 2);
          const grad1 = ctx.createRadialGradient(
            wh.x1,
            wh.y1,
            0,
            wh.x1,
            wh.y1,
            wh.radius,
          );
          grad1.addColorStop(0, "black");
          grad1.addColorStop(0.8, "rgba(0, 255, 255, 0.5)");
          grad1.addColorStop(1, "rgba(0, 255, 255, 0)");
          ctx.fillStyle = grad1;
          ctx.fill();

          ctx.save();
          ctx.translate(wh.x1, wh.y1);
          ctx.rotate(Date.now() / -200);
          ctx.beginPath();
          ctx.arc(0, 0, wh.radius, 0, Math.PI * 2);
          ctx.strokeStyle = "cyan";
          ctx.lineWidth = 4;
          ctx.setLineDash([15, 10]);
          ctx.stroke();
          ctx.restore();

          // Portal 2: Orange
          ctx.beginPath();
          ctx.arc(wh.x2, wh.y2, wh.radius, 0, Math.PI * 2);
          const grad2 = ctx.createRadialGradient(
            wh.x2,
            wh.y2,
            0,
            wh.x2,
            wh.y2,
            wh.radius,
          );
          grad2.addColorStop(0, "black");
          grad2.addColorStop(0.8, "rgba(255, 165, 0, 0.5)");
          grad2.addColorStop(1, "rgba(255, 165, 0, 0)");
          ctx.fillStyle = grad2;
          ctx.fill();

          ctx.save();
          ctx.translate(wh.x2, wh.y2);
          ctx.rotate(Date.now() / 200);
          ctx.beginPath();
          ctx.arc(0, 0, wh.radius, 0, Math.PI * 2);
          ctx.strokeStyle = "orange";
          ctx.lineWidth = 4;
          ctx.setLineDash([15, 10]);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Draw Meteor Showers
      const meteorShowers = state.meteorShowers || [];
      for (const ms of meteorShowers) {
        if (
          ms.x + ms.radius < cullStartX ||
          ms.x - ms.radius > cullEndX ||
          ms.y + ms.radius < cullStartY ||
          ms.y - ms.radius > cullEndY
        )
          continue;

        if (ms.state === "warning") {
          ctx.beginPath();
          ctx.arc(ms.x, ms.y, ms.radius, 0, Math.PI * 2);

          // Pulsing red transparency for impact zone
          const pulse = Math.abs(Math.sin(Date.now() / 200));
          ctx.fillStyle = `rgba(255, 30, 30, ${0.1 + pulse * 0.15})`;
          ctx.fill();

          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(255, 0, 0, 0.8)";
          ctx.setLineDash([15, 15]);
          ctx.stroke();
          ctx.setLineDash([]); // reset

          // Cinematic meteor drop animation
          const progress = 1 - ms.timer / 300; // 0 at start, 1 at impact
          if (progress >= 0 && progress <= 1) {
            const altitude = (1 - progress) * 3000;
            const meteorX = ms.x + altitude;
            const meteorY = ms.y - altitude;

            ctx.save();
            // Fire trail
            const grad = ctx.createLinearGradient(
              meteorX,
              meteorY,
              meteorX + 500,
              meteorY - 500,
            );
            grad.addColorStop(0, "rgba(255, 200, 0, 1)");
            grad.addColorStop(0.5, "rgba(255, 50, 0, 0.8)");
            grad.addColorStop(1, "rgba(0, 0, 0, 0)");

            ctx.beginPath();
            ctx.moveTo(meteorX, meteorY);
            ctx.lineTo(
              meteorX + 200 + altitude * 0.2,
              meteorY - 150 - altitude * 0.2,
            );
            ctx.lineTo(
              meteorX + 150 + altitude * 0.2,
              meteorY - 200 - altitude * 0.2,
            );
            ctx.fillStyle = grad;
            ctx.fill();

            // Meteor core rock
            ctx.beginPath();
            ctx.arc(meteorX, meteorY, 30 + progress * 20, 0, Math.PI * 2);
            ctx.fillStyle = "#ff5500";
            ctx.shadowBlur = 50;
            ctx.shadowColor = "#ff0000";
            ctx.fill();
            ctx.restore();
          }
        }
      }

      // Draw foods — BATCH RENDERING: group simple foods by color to minimize draw calls
      // First pass: collect normal low-value foods by color for batching
      const foodsByColor = new Map<
        string,
        { x: number; y: number; r: number }[]
      >();
      const specialFoods: Food[] = [];

      for (const food of state.foods) {
        // Frustum Culling: Skip rendering if food is completely off-screen
        if (
          food.x < cullStartX ||
          food.x > cullEndX ||
          food.y < cullStartY ||
          food.y > cullEndY
        ) {
          continue;
        }

        if (food.type === "normal" && food.value < 3) {
          // Batch these simple circle foods
          const baseRadius = Math.max(5, Math.sqrt(food.value) * 5);
          const arr = foodsByColor.get(food.color) || [];
          arr.push({ x: food.x, y: food.y, r: baseRadius });
          foodsByColor.set(food.color, arr);
        } else {
          specialFoods.push(food);
        }
      }

      // Batch draw normal foods — one beginPath+fill per color (~10 draw calls instead of ~200)
      ctx.shadowBlur = 0;
      for (const [color, items] of foodsByColor) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const item of items) {
          ctx.moveTo(item.x + item.r, item.y);
          ctx.arc(item.x, item.y, item.r, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      // Draw special foods individually (powerups, buffs, poison, high-value)
      for (const food of specialFoods) {
        ctx.beginPath();
        if (food.type === "powerup") {
          // Draw star for powerup
          const spikes = 5;
          const outerRadius = 15;
          const innerRadius = 7;
          let rot = (Math.PI / 2) * 3;
          let x = food.x;
          let y = food.y;
          const step = Math.PI / spikes;

          ctx.moveTo(x, y - outerRadius);
          for (let i = 0; i < spikes; i++) {
            x = food.x + Math.cos(rot) * outerRadius;
            y = food.y + Math.sin(rot) * outerRadius;
            ctx.lineTo(x, y);
            rot += step;

            x = food.x + Math.cos(rot) * innerRadius;
            y = food.y + Math.sin(rot) * innerRadius;
            ctx.lineTo(x, y);
            rot += step;
          }
          ctx.lineTo(food.x, food.y - outerRadius);
          ctx.closePath();

          ctx.shadowBlur = 0;
          ctx.shadowColor = "#FFFFFF";
          ctx.fillStyle = "#FFD700"; // Gold
        } else if (
          food.type === "magnet" ||
          food.type === "speed" ||
          food.type === "invincibility"
        ) {
          // Draw floating crystal for buffs
          const size = 18;
          ctx.arc(food.x, food.y, size, 0, Math.PI * 2);

          const pulse = Math.sin(Date.now() / 150) * 5;
          ctx.shadowBlur = 15 + pulse;

          let emoji = "";

          if (food.type === "magnet") {
            ctx.fillStyle = "rgba(59, 130, 246, 0.4)";
            ctx.shadowColor = "#60a5fa";
            emoji = "🧲";
          } else if (food.type === "speed") {
            ctx.fillStyle = "rgba(234, 179, 8, 0.4)";
            ctx.shadowColor = "#fde047";
            emoji = "⚡";
          } else if (food.type === "invincibility") {
            ctx.fillStyle = "rgba(248, 113, 113, 0.4)";
            ctx.shadowColor = "#fca5a5";
            emoji = "🛡️";
          }
          ctx.fill();

          // Draw icon — clear path first so the loop's trailing fill() doesn't repaint
          ctx.beginPath();
          ctx.shadowBlur = 0;
          ctx.font = "bold 20px Arial";
          ctx.fillStyle = "black"; // Neutral fillStyle lets emoji render with natural colors
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(emoji, food.x, food.y + 2);
          // beginPath resets so final ctx.fill() is a no-op
          ctx.beginPath();
        } else if (food.type === "poison") {
          ctx.beginPath();
          ctx.arc(food.x, food.y, 14, 0, Math.PI * 2);
          const pulse = Math.sin(Date.now() / 150) * 5;
          ctx.shadowBlur = 15 + pulse;
          ctx.fillStyle = "rgba(168, 85, 247, 0.4)";
          ctx.shadowColor = "#a855f7";
          ctx.fill();

          ctx.shadowBlur = 0;
          ctx.font = "16px Arial";
          ctx.fillStyle = "black";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("☠️", food.x, food.y + 1);
          // Reset path so loop's trailing fill() is a no-op
          ctx.beginPath();
        } else {
          ctx.beginPath();
          const baseRadius = Math.max(5, Math.sqrt(food.value) * 5);
          const pulse =
            food.value >= 3 ? Math.sin(Date.now() / 150 + food.x) * 3 : 0;
          ctx.arc(food.x, food.y, baseRadius + pulse, 0, Math.PI * 2);

          ctx.fillStyle = food.color;
          if (food.value >= 3) {
            ctx.shadowBlur = 15 + pulse * 2;
            ctx.shadowColor = food.color;
          } else {
            ctx.shadowBlur = 0;
          }
        }

        ctx.fill();
        ctx.shadowBlur = 0; // Reset
      }

      // Draw players
      for (const player of state.players) {
        if (player.segments.length === 0) continue;

        // Compute dynamic radius based on same logic as server
        // EXPONENTIAL SCALING: Aggressive growth with clear visual differences
        const radius = 12 + Math.sqrt(player.score) * 0.8;

        // Bounding box culling for player segments (check head + tail + giant radius buffer)
        const head = player.segments[0];
        const tail = player.segments[player.segments.length - 1];

        // If BOTH head and tail are far off-screen, skip render. If one is inside, draw.
        const headOffScreen =
          head.x < cullStartX - 3000 ||
          head.x > cullEndX + 3000 ||
          head.y < cullStartY - 3000 ||
          head.y > cullEndY + 3000;
        const tailOffScreen =
          tail.x < cullStartX - 3000 ||
          tail.x > cullEndX + 3000 ||
          tail.y < cullStartY - 3000 ||
          tail.y > cullEndY + 3000;
        if (headOffScreen && tailOffScreen) {
          continue; // Completely offscreen
        }

        // Draw player buff aura behind them (and Leviathan Boss glow)
        if (
          (player.activeBuff || player.isLeviathan) &&
          player.segments.length > 0
        ) {
          const head = player.segments[0];
          ctx.beginPath();
          ctx.arc(
            head.x,
            head.y,
            radius * 2.5 + Math.sin(Date.now() / 100) * 5,
            0,
            Math.PI * 2,
          );
          if (player.activeBuff?.type === "magnet") {
            ctx.strokeStyle = "rgba(59, 130, 246, 0.5)";
          } else if (player.activeBuff?.type === "speed") {
            ctx.strokeStyle = "rgba(234, 179, 8, 0.5)";
          } else if (player.activeBuff?.type === "invincibility") {
            ctx.strokeStyle = "rgba(248, 113, 113, 0.5)";
          } else if (player.isLeviathan) {
            ctx.strokeStyle = "rgba(255, 69, 0, 0.8)"; // Fiery aura for boss
          }
          ctx.lineWidth = player.isLeviathan ? 8 : 4;
          ctx.stroke();
        }

        // ── Authentic Slither.io Snake Body Rendering ──
        // Technique: 3-layer approach
        //   Layer 1: Dark outline stroke (slightly wider than body)
        //   Layer 2: Main body stroke (smooth continuous tube)
        //   Layer 3: Alternating stripe pattern circles on top
        if (player.segments.length > 1) {
          const bodyColor = (player as any).isPoisoned
            ? "#a855f7"
            : player.color;

          // Parse the player color to create a darker variant for outline and stripes
          const darkerColor = (() => {
            const hex = bodyColor.replace("#", "");
            const r = Math.max(0, parseInt(hex.substring(0, 2), 16) - 50);
            const g = Math.max(0, parseInt(hex.substring(2, 4), 16) - 50);
            const b = Math.max(0, parseInt(hex.substring(4, 6), 16) - 50);
            return `rgb(${r},${g},${b})`;
          })();

          // For very long snakes, use a stride to avoid drawing thousands of path points
          const stride = Math.max(1, Math.floor(radius / 5));

          // Build the path points array (used for all 3 layers)
          const pts: { x: number; y: number }[] = [];
          for (let i = 0; i < player.segments.length; i += stride) {
            pts.push(player.segments[i]);
          }
          // Always include the actual tail
          const lastSeg = player.segments[player.segments.length - 1];
          if (pts[pts.length - 1] !== lastSeg) pts.push(lastSeg);

          // Setup effects
          if ((player as any).isDashing) {
            ctx.shadowBlur = 25;
            ctx.shadowColor = "#ffffff";
            ctx.globalAlpha = 0.6;
          } else if (player.isBoosting) {
            ctx.shadowBlur = 15;
            ctx.shadowColor = player.color;
            ctx.globalAlpha = 0.95;
          } else {
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1.0;
          }

          // ─── Layer 1: Dark outline border ───
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
          }
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.lineWidth = radius * 2 + 4; // slightly wider for the border
          ctx.strokeStyle = darkerColor;
          ctx.stroke();

          // ─── Layer 2: Main body fill ───
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x, pts[i].y);
          }
          ctx.lineWidth = radius * 2;
          ctx.strokeStyle = bodyColor;
          ctx.stroke();

          // ─── Layer 3: Alternating stripe pattern (Slither.io signature look) ───
          // Draw small darker circles at regular intervals along the body
          ctx.shadowBlur = 0;
          const stripeSpacing = Math.max(8, radius * 1.2); // distance between stripes
          let distAccum = 0;
          let stripeToggle = false;
          let prevPt = player.segments[0];

          for (let i = 1; i < player.segments.length; i++) {
            const seg = player.segments[i];
            const dx = seg.x - prevPt.x;
            const dy = seg.y - prevPt.y;
            distAccum += Math.sqrt(dx * dx + dy * dy);

            if (distAccum >= stripeSpacing) {
              distAccum = 0;
              stripeToggle = !stripeToggle;
              if (stripeToggle) {
                ctx.beginPath();
                // Slightly smaller circle sitting inside the tube
                ctx.arc(seg.x, seg.y, radius * 0.75, 0, Math.PI * 2);
                ctx.fillStyle = darkerColor;
                ctx.globalAlpha = 0.25;
                ctx.fill();
                ctx.globalAlpha = 1.0;
              }
            }
            prevPt = seg;
          }

          ctx.globalAlpha = 1.0;
          ctx.shadowBlur = 0;
        }

        // ─── Head Circle ───
        // The head always sits on top, drawn last with a slight highlight
        ctx.beginPath();
        ctx.arc(head.x, head.y, radius, 0, Math.PI * 2);
        const headColor = (player as any).isPoisoned ? "#a855f7" : player.color;
        ctx.fillStyle = headColor;

        if ((player as any).isDashing) {
          ctx.shadowBlur = 25;
          ctx.shadowColor = "#ffffff";
        } else if (player.isBoosting) {
          ctx.shadowBlur = 15;
          ctx.shadowColor = player.color;
        } else {
          ctx.shadowBlur = 4;
          ctx.shadowColor = "rgba(0,0,0,0.4)";
        }
        ctx.fill();

        // Head highlight (small white reflection circle for 3D pop)
        ctx.beginPath();
        ctx.arc(
          head.x - radius * 0.2,
          head.y - radius * 0.2,
          radius * 0.3,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.shadowBlur = 0;
        ctx.fill();

        const isHead = true;
        const segment = head;

        // Draw eyes on head
        if (isHead && player.segments.length > 1) {
          const next = player.segments[1];
          const angle = Math.atan2(segment.y - next.y, segment.x - next.x);

          const isPredator = player.score >= 500;
          const isDragon = player.score >= 2000 || player.isLeviathan;

          if (isDragon) {
            // Draw dragon golden horns
            ctx.fillStyle = "#fbbf24";
            ctx.shadowColor = "#f59e0b";
            ctx.shadowBlur = 10;

            // Left horn
            ctx.beginPath();
            ctx.moveTo(
              segment.x + Math.cos(angle - 0.8) * radius,
              segment.y + Math.sin(angle - 0.8) * radius,
            );
            ctx.lineTo(
              segment.x + Math.cos(angle - 2.5) * (radius * 2.5),
              segment.y + Math.sin(angle - 2.5) * (radius * 2.5),
            );
            ctx.lineTo(
              segment.x + Math.cos(angle - 1.5) * radius,
              segment.y + Math.sin(angle - 1.5) * radius,
            );
            ctx.fill();

            // Right horn
            ctx.beginPath();
            ctx.moveTo(
              segment.x + Math.cos(angle + 0.8) * radius,
              segment.y + Math.sin(angle + 0.8) * radius,
            );
            ctx.lineTo(
              segment.x + Math.cos(angle + 2.5) * (radius * 2.5),
              segment.y + Math.sin(angle + 2.5) * (radius * 2.5),
            );
            ctx.lineTo(
              segment.x + Math.cos(angle + 1.5) * radius,
              segment.y + Math.sin(angle + 1.5) * radius,
            );
            ctx.fill();

            ctx.shadowBlur = 0; // reset
          } else if (isPredator) {
            // Draw spiky mandibles
            ctx.fillStyle = player.color;

            ctx.beginPath();
            ctx.moveTo(
              segment.x + Math.cos(angle - 0.5) * radius,
              segment.y + Math.sin(angle - 0.5) * radius,
            );
            ctx.lineTo(
              segment.x + Math.cos(angle - 0.2) * (radius * 1.5),
              segment.y + Math.sin(angle - 0.2) * (radius * 1.5),
            );
            ctx.lineTo(
              segment.x + Math.cos(angle) * (radius * 0.8),
              segment.y + Math.sin(angle) * (radius * 0.8),
            );
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(
              segment.x + Math.cos(angle + 0.5) * radius,
              segment.y + Math.sin(angle + 0.5) * radius,
            );
            ctx.lineTo(
              segment.x + Math.cos(angle + 0.2) * (radius * 1.5),
              segment.y + Math.sin(angle + 0.2) * (radius * 1.5),
            );
            ctx.lineTo(
              segment.x + Math.cos(angle) * (radius * 0.8),
              segment.y + Math.sin(angle) * (radius * 0.8),
            );
            ctx.fill();
          }

          ctx.fillStyle = "white";
          const eyeDist = radius * 0.5;
          const eyeSize = radius * 0.25;

          // Left eye
          const lex = segment.x + Math.cos(angle - 0.5) * eyeDist;
          const ley = segment.y + Math.sin(angle - 0.5) * eyeDist;
          ctx.beginPath();
          ctx.arc(lex, ley, eyeSize, 0, Math.PI * 2);
          ctx.fill();

          // Right eye
          const rex = segment.x + Math.cos(angle + 0.5) * eyeDist;
          const rey = segment.y + Math.sin(angle + 0.5) * eyeDist;
          ctx.beginPath();
          ctx.arc(rex, rey, eyeSize, 0, Math.PI * 2);
          ctx.fill();

          // Pupils
          ctx.fillStyle = "black";
          const pupilSize = eyeSize * 0.5;
          ctx.beginPath();
          ctx.arc(
            lex + Math.cos(angle) * (eyeSize * 0.3),
            ley + Math.sin(angle) * (eyeSize * 0.3),
            pupilSize,
            0,
            Math.PI * 2,
          );
          ctx.fill();
          ctx.beginPath();
          ctx.arc(
            rex + Math.cos(angle) * (eyeSize * 0.3),
            rey + Math.sin(angle) * (eyeSize * 0.3),
            pupilSize,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }

        // Draw name
        if (player.segments.length > 0) {
          const head = player.segments[0];

          // Check for The Crown of the Apex
          const isRankOne =
            leaderboardRef.current.length > 0 &&
            player.id === leaderboardRef.current[0].id;
          if (isRankOne) {
            ctx.fillStyle = "#fbbf24";
            ctx.shadowColor = "#f59e0b";
            ctx.shadowBlur = 15;
            ctx.font = "20px Arial";
            ctx.textAlign = "center";
            const bounce = Math.sin(Date.now() / 200) * 5;
            ctx.fillText("👑", head.x, head.y - radius - 30 + bounce);
            ctx.shadowBlur = 0;
          }

          ctx.fillStyle = "white";
          ctx.font = "12px Inter, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(player.name, head.x, head.y - radius - 15);

          // Draw Emote Bubble
          if (player.activeEmote && player.activeEmote.timer > 0) {
            const cx = head.x + radius + 15;
            const cy = head.y - radius - 25;

            ctx.fillStyle = "white";
            ctx.beginPath();
            ctx.arc(cx, cy, 20, 0, Math.PI * 2);
            ctx.fill();

            // Bubble tail
            ctx.beginPath();
            ctx.moveTo(cx - 10, cy + 15);
            ctx.lineTo(cx - 20, cy + 25);
            ctx.lineTo(cx + 5, cy + 18);
            ctx.fill();

            ctx.fillStyle = "black";
            ctx.font = "20px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(player.activeEmote.emoji, cx, cy + 2);
          }
        }
      }

      ctx.restore();

      // UI OVERLAYS (DISCREET HUD)

      // Void Vignette (Black Hole Terror)
      if (voidGravityRatio > 0) {
        const outerAlpha = Math.min(0.9, voidGravityRatio * 1.5);
        const innerAlpha = 0;
        const grad = ctx.createRadialGradient(hw, hh, hh * 0.2, hw, hh, hw);
        grad.addColorStop(0, `rgba(0, 0, 0, ${innerAlpha})`);
        grad.addColorStop(1, `rgba(0, 0, 0, ${outerAlpha})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // Draw Loot Zone Pointers
      if (me && state.lootZones) {
        const myHead = me.segments[0];
        if (myHead) {
          for (const lz of state.lootZones) {
            const dx = lz.x - myHead.x;
            const dy = lz.y - myHead.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // If LootZone is off-screen, draw a pointer
            if (dist > canvas.width / 2) {
              const angle = Math.atan2(dy, dx);
              const pointerDist =
                Math.min(canvas.width, canvas.height) / 2 - 40;
              const px = hw + Math.cos(angle) * pointerDist;
              const py = hh + Math.sin(angle) * pointerDist;

              ctx.save();
              ctx.translate(px, py);
              ctx.rotate(angle);

              ctx.beginPath();
              ctx.moveTo(15, 0);
              ctx.lineTo(-10, -10);
              ctx.lineTo(-10, 10);
              ctx.closePath();

              ctx.fillStyle = "white";
              ctx.shadowColor = "white";
              ctx.shadowBlur = 10 + Math.sin(Date.now() / 100) * 5;
              ctx.fill();

              ctx.restore();
            }
          }
        }
      }

      // UI OVERLAYS (DISCREET HUD)
      const activeAlerts: { text: string; color: string }[] = [];

      const warningBh = (state.blackHoles || []).find(
        (bh) => bh.state === "warning",
      );
      const warningMs = (state.meteorShowers || []).find(
        (ms) => ms.state === "warning",
      );
      const warningWh = (state.wormholes || []).find(
        (wh) => wh.state === "warning",
      );

      if (warningMs)
        activeAlerts.push({
          text: "⚠️ METEOR INCOMING - EVACUATE RED ZONE",
          color: "#ff4d4d",
        });
      if (warningBh)
        activeAlerts.push({
          text: "⚠️ GRAVITATIONAL ANOMALY DETECTED",
          color: "#d633ff",
        });
      if (warningWh)
        activeAlerts.push({
          text: "🌀 WORMHOLE RIFTS OPENING",
          color: "#33ccff",
        });

      if (state.foodFrenzy) {
        // Golden overlay
        ctx.fillStyle = "rgba(255, 215, 0, 0.08)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        activeAlerts.push({
          text: "✨ GOLDEN FOOD FRENZY ACTIVE ✨",
          color: "#FFDF00",
        });
      }

      // Draw stacked alerts
      let alertY = 20;
      for (const alert of activeAlerts) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.beginPath();
        // draw smaller/cleaner rounded rect at top center
        ctx.roundRect(canvas.width / 2 - 220, alertY, 440, 36, 8);
        ctx.fill();

        ctx.fillStyle = alert.color;
        ctx.font = "bold 16px Inter, sans-serif"; // Slightly smaller font for UX
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const pulse = Math.abs(Math.sin(Date.now() / 200));
        ctx.shadowBlur = pulse * 10;
        ctx.shadowColor = alert.color;
        ctx.fillText(alert.text, canvas.width / 2, alertY + 18);
        ctx.shadowBlur = 0; // reset

        alertY += 45; // stack spacing
      }

      // Draw Active Buff Radial Timer (RPG Style) — positioned below score panel
      if (me && me.activeBuff) {
        const timeRemaining = me.activeBuff.expiresAt - Date.now();
        if (timeRemaining > 0) {
          const maxTime = 10000; // Buffs last 10 seconds default
          const progress = Math.max(0, Math.min(1, timeRemaining / maxTime));

          let emoji = "";
          let color = "";
          let buffName = "";
          if (me.activeBuff.type === "magnet") {
            emoji = "🧲";
            color = "#3b82f6";
            buffName = "MAGNET";
          } else if (me.activeBuff.type === "speed") {
            emoji = "⚡";
            color = "#fde047";
            buffName = "SPEED";
          } else if (me.activeBuff.type === "invincibility") {
            emoji = "🛡️";
            color = "#fca5a5";
            buffName = "SHIELD";
          }

          // Position below the score panel to avoid overlap
          const centerX = 60;
          const centerY = 120;
          const radius = 30;

          // Background dark circle
          ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
          ctx.beginPath();
          ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
          ctx.fill();

          // Draw declining radial progress edge
          ctx.strokeStyle = color;
          ctx.lineWidth = 5;
          ctx.lineCap = "round";
          ctx.beginPath();
          const startAngle = -Math.PI / 2;
          const endAngle = startAngle + Math.PI * 2 * progress;
          ctx.arc(centerX, centerY, radius - 3, startAngle, endAngle);
          ctx.stroke();

          // Draw Emoji in center
          ctx.shadowBlur = 0;
          ctx.font = "bold 22px Arial";
          ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(emoji, centerX, centerY + 2);

          // Buff name label
          ctx.font = "bold 9px Inter, sans-serif";
          ctx.fillStyle = color;
          ctx.fillText(buffName, centerX, centerY + radius + 12);

          // Time remaining text
          const secondsLeft = Math.ceil(timeRemaining / 1000);
          ctx.font = "bold 10px Inter, sans-serif";
          ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
          ctx.fillText(`${secondsLeft}s`, centerX, centerY - radius - 8);
        }
      }

      // Draw Kill Feed
      let feedY = 380; // Shift down to avoid Leaderboard overlap completely
      for (let i = 0; i < killFeedRef.current.length; i++) {
        const kf = killFeedRef.current[i];
        kf.timer--;
        if (kf.timer <= 0) continue; // Skip expired

        const alpha = Math.min(1, kf.timer / 30); // Fade out last 30 frames

        ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`;
        ctx.beginPath();
        const feedWidth = 250;
        const feedX = canvas.width - feedWidth - 20;
        ctx.roundRect(feedX, feedY, feedWidth, 30, 8);
        ctx.fill();

        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.font = "bold 13px Inter, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        // Format: [Victor] ⚔️ [Victim]
        ctx.fillText(
          `${kf.killer} ⚔️ ${kf.victim}`,
          feedX + feedWidth - 15,
          feedY + 15,
        );

        feedY += 35;
      }

      // Filter out expired kills
      killFeedRef.current = killFeedRef.current.filter((kf) => kf.timer > 0);

      // Send input to server
      if (me && socketRef.current) {
        let angle = lastInputAngleRef.current || 0;

        // Keyboard movement
        const keys = keysRef.current;
        let dx = 0;
        let dy = 0;
        if (keys["ArrowUp"] || keys["w"] || keys["W"]) dy -= 1;
        if (keys["ArrowDown"] || keys["s"] || keys["S"]) dy += 1;
        if (keys["ArrowLeft"] || keys["a"] || keys["A"]) dx -= 1;
        if (keys["ArrowRight"] || keys["d"] || keys["D"]) dx += 1;

        if (dx !== 0 || dy !== 0) {
          angle = Math.atan2(dy, dx);
        } else {
          // Mouse movement
          const mdx = mousePosRef.current.x - hw;
          const mdy = mousePosRef.current.y - hh;
          // Only update angle if mouse is not exactly at center
          if (mdx !== 0 || mdy !== 0) {
            angle = Math.atan2(mdy, mdx);
          }
        }

        const now = Date.now();
        let angleDiff = 100;
        if (lastInputAngleRef.current !== null) {
          let diff = angle - lastInputAngleRef.current;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          angleDiff = Math.abs(diff);
        }

        const boostChanged = isBoostingRef.current !== lastBoostingRef.current;
        const wantsDash = isDashingRef.current;
        const wantsPoison = dropPoisonRef.current;

        // Send if angle changed significantly, or any input state is active/changed
        if (
          angleDiff > 0.05 ||
          boostChanged ||
          wantsDash ||
          wantsPoison ||
          now - lastInputTimeRef.current > 50
        ) {
          socketRef.current.emit("input", {
            angle,
            isBoosting: isBoostingRef.current,
            isDashing: wantsDash,
            dropPoison: wantsPoison,
          });

          // Reset impulse triggers
          isDashingRef.current = false;
          dropPoisonRef.current = false;

          lastInputAngleRef.current = angle;
          lastBoostingRef.current = isBoostingRef.current;
          lastInputTimeRef.current = now;
        }
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    mousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length > 0) {
      mousePosRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 0) {
      isBoostingRef.current = true; // Left click boost
    } else if (e.button === 2) {
      isDashingRef.current = true; // Right click dash
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 0) {
      isBoostingRef.current = false;
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault(); // Prevent native right click menu
  };

  const handleJoystickMove = (e: any) => {
    if (e.x !== null && e.y !== null) {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      // react-joystick-component: y is positive UP. Browser math: y is positive DOWN.
      const angle = Math.atan2(-e.y, e.x);
      mousePosRef.current = {
        x: centerX + Math.cos(angle) * 100,
        y: centerY + Math.sin(angle) * 100,
      };
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-neutral-900 font-sans">
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onTouchMove={handleTouchMove}
        onContextMenu={handleContextMenu}
        className={`w-full h-full cursor-crosshair transition-opacity duration-1000 ${isDead ? "opacity-20" : "opacity-100"}`}
      />

      {/* Mobile Controls Overlay */}
      {isMobile && !isDead && (
        <div className="absolute inset-0 z-40 pointer-events-none touch-none">
          {/* Joystick */}
          <div className="absolute bottom-12 left-10 pointer-events-auto">
            <Joystick
              size={120}
              baseColor="rgba(255,255,255,0.15)"
              stickColor="rgba(255,255,255,0.5)"
              move={handleJoystickMove}
            />
          </div>

          {/* Action Buttons */}
          <div className="absolute bottom-12 right-10 flex gap-6 pointer-events-auto">
            <button
              className="w-20 h-20 rounded-full bg-white/10 active:bg-white/30 border-2 border-white/40 text-white font-bold select-none touch-none flex items-center justify-center text-sm shadow-lg backdrop-blur-sm"
              onTouchStart={(e) => {
                e.preventDefault();
                isBoostingRef.current = true;
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                isBoostingRef.current = false;
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                isBoostingRef.current = true;
              }}
              onMouseUp={(e) => {
                e.preventDefault();
                isBoostingRef.current = false;
              }}
              onMouseLeave={(e) => {
                e.preventDefault();
                isBoostingRef.current = false;
              }}
            >
              BOOST
            </button>
            <button
              className="w-20 h-20 rounded-full bg-blue-500/20 active:bg-blue-500/50 border-2 border-blue-400/50 text-white font-bold select-none touch-none flex items-center justify-center text-sm shadow-lg backdrop-blur-sm shadow-blue-500/20"
              onTouchStart={(e) => {
                e.preventDefault();
                isDashingRef.current = true;
                setTimeout(() => (isDashingRef.current = false), 100);
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                isDashingRef.current = true;
                setTimeout(() => (isDashingRef.current = false), 100);
              }}
            >
              DASH
            </button>
          </div>
        </div>
      )}

      {isDead && (
        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
          <div className="text-center animate-bounce">
            <h1 className="text-6xl font-bold text-red-500 mb-4 drop-shadow-[0_0_15px_rgba(239,68,68,0.8)]">
              YOU DIED
            </h1>
            <p className="text-xl text-white">Final Score: {score}</p>
          </div>
        </div>
      )}

      {connectionError && (
        <div className="absolute inset-0 flex items-center justify-center z-40 pointer-events-none p-6">
          <div className="bg-red-900/80 border border-red-300/40 text-red-50 px-5 py-4 rounded-xl max-w-lg text-center backdrop-blur-sm">
            {connectionError}
          </div>
        </div>
      )}

      {/* UI Overlay */}
      <div className="absolute top-4 left-4 pointer-events-none">
        <div className="bg-black/50 backdrop-blur-md text-white px-4 py-2 rounded-xl border border-white/10 shadow-lg">
          <span className="text-neutral-400 text-sm font-medium uppercase tracking-wider">
            Score
          </span>
          <div className="text-2xl font-bold text-emerald-400">{score}</div>
        </div>
      </div>

      <div className="absolute top-4 right-4 pointer-events-none w-48">
        <div className="bg-black/50 backdrop-blur-md text-white p-4 rounded-xl border border-white/10 shadow-lg">
          <h3 className="text-neutral-400 text-xs font-bold uppercase tracking-wider mb-3">
            Leaderboard
          </h3>
          <div className="space-y-2">
            {leaderboard.map((p, i) => (
              <div
                key={p.id}
                className="flex justify-between items-center text-sm"
              >
                <div className="flex items-center gap-2 truncate">
                  <span className="text-neutral-500 font-mono text-xs">
                    {i + 1}.
                  </span>
                  <span
                    className={
                      p.id === myIdRef.current
                        ? "text-emerald-400 font-bold"
                        : "text-neutral-200 truncate"
                    }
                  >
                    {p.name}
                  </span>
                </div>
                <span className="font-mono text-neutral-400">
                  {Math.floor(p.score)}
                </span>
              </div>
            ))}
            {leaderboard.length === 0 && (
              <div className="text-neutral-500 text-xs italic">
                Waiting for players...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
