/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import Game from "./Game";

const COLORS = [
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

export default function App() {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [isPlaying, setIsPlaying] = useState(false);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      setIsPlaying(true);
    }
  };

  if (isPlaying) {
    return (
      <Game
        playerName={name}
        playerColor={color}
        onDeath={() => setIsPlaying(false)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-neutral-900 flex items-center justify-center font-sans text-white">
      <div className="bg-neutral-800 p-8 rounded-2xl shadow-2xl w-full max-w-md border border-white/10">
        <h1 className="text-4xl font-bold text-center mb-2 tracking-tight text-emerald-400">
          Slither Clone
        </h1>
        <p className="text-center text-neutral-400 mb-8">
          Eat to grow, don't hit others!
        </p>

        <form onSubmit={handleJoin} className="space-y-6">
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-neutral-300 mb-1"
            >
              Nickname
            </label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-white placeholder-neutral-500 transition-all"
              placeholder="Enter your name..."
              maxLength={15}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">
              Choose Skin
            </label>
            <div className="flex flex-wrap gap-3 justify-center">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-10 h-10 rounded-full transition-transform ${
                    color === c
                      ? "scale-125 ring-2 ring-white ring-offset-2 ring-offset-neutral-800"
                      : "hover:scale-110"
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={`Select color ${c}`}
                />
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={!name.trim()}
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-bold py-3 px-4 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-4"
          >
            Play Now
          </button>
        </form>
      </div>
    </div>
  );
}
