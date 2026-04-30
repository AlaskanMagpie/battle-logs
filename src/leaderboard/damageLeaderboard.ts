import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { GamePhase } from "../game/types";
import type { MatchMode } from "../net/protocol";

export const DAMAGE_LEADERBOARD_LIMIT = 100;

export interface DamageLeaderboardEntry {
  id: string;
  created_at: string;
  username: string | null;
  damage: number;
  phase: GamePhase;
  duration_ticks: number;
  match_mode: Exclude<MatchMode, "matchmake">;
  map_id: string | null;
  client_match_id: string | null;
}

export interface DamageLeaderboardSubmission {
  username?: string;
  damage: number;
  phase: GamePhase;
  durationTicks: number;
  matchMode: MatchMode;
  mapId?: string;
  clientMatchId?: string;
}

type DamageLeaderboardInsert = {
  username: string | null;
  damage: number;
  phase: GamePhase;
  duration_ticks: number;
  match_mode: Exclude<MatchMode, "matchmake">;
  map_id: string | null;
  client_match_id: string | null;
};

let supabaseClient: SupabaseClient | null | undefined;

export function configuredDamageLeaderboard(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

function damageLeaderboardClient(): SupabaseClient | null {
  if (supabaseClient !== undefined) return supabaseClient;
  const url = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
  const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  supabaseClient = url && anonKey ? createClient(url, anonKey) : null;
  return supabaseClient;
}

export function normalizeDamageSubmission(input: DamageLeaderboardSubmission): DamageLeaderboardInsert | null {
  if (input.phase === "playing") return null;
  const damage = Math.max(0, Math.min(2_000_000_000, Math.round(input.damage)));
  if (!Number.isFinite(damage)) return null;
  const duration_ticks = Math.max(0, Math.min(2_000_000_000, Math.round(input.durationTicks)));
  if (!Number.isFinite(duration_ticks)) return null;
  const username = input.username?.trim().slice(0, 32) || null;
  const map_id = input.mapId?.trim().slice(0, 128) || null;
  const client_match_id = input.clientMatchId?.trim().slice(0, 96) || null;
  return {
    username,
    damage,
    phase: input.phase,
    duration_ticks,
    match_mode: input.matchMode === "matchmake" ? "ai" : input.matchMode,
    map_id,
    client_match_id,
  };
}

export async function submitDamageLeaderboardEntry(input: DamageLeaderboardSubmission): Promise<DamageLeaderboardEntry | null> {
  const row = normalizeDamageSubmission(input);
  if (!row) return null;
  const client = damageLeaderboardClient();
  if (!client) return null;
  const { data, error } = await client
    .from("damage_leaderboard")
    .insert(row)
    .select("id,created_at,username,damage,phase,duration_ticks,match_mode,map_id,client_match_id")
    .single();
  if (error) {
    console.warn("[leaderboard] damage submit failed", error.message);
    return null;
  }
  return data as DamageLeaderboardEntry;
}

export async function readDamageLeaderboard(limit = DAMAGE_LEADERBOARD_LIMIT): Promise<DamageLeaderboardEntry[]> {
  const client = damageLeaderboardClient();
  if (!client) return [];
  const safeLimit = Math.max(1, Math.min(DAMAGE_LEADERBOARD_LIMIT, Math.round(limit)));
  const { data, error } = await client
    .from("damage_leaderboard")
    .select("id,created_at,username,damage,phase,duration_ticks,match_mode,map_id,client_match_id")
    .order("damage", { ascending: false })
    .order("duration_ticks", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(safeLimit);
  if (error) {
    console.warn("[leaderboard] damage read failed", error.message);
    return [];
  }
  return (data ?? []) as DamageLeaderboardEntry[];
}
