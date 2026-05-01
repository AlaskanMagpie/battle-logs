const AI_ADMIN_STORAGE_KEY = "signalWars_aiAdmin.v1";

const ROSTER = [
  ["local-oss-20b", 1, "Socket Apprentice", "Local gpt-oss:20b / LM Studio"],
  ["groq-llama-3-1-8b", 2, "Needle-Quick Adept", "Groq llama-3.1-8b-instant"],
  ["cloudflare-llama-3-1-8b-fast", 3, "Edge Warlock", "Cloudflare llama-3.1-8b-instruct-fp8-fast"],
  ["cloudflare-qwen3-30b-a3b", 4, "Qwen Tactician", "Cloudflare qwen3-30b-a3b-fp8"],
  ["groq-gpt-oss-20b", 5, "Open-Weight Archmage", "Groq openai/gpt-oss-20b"],
  ["gemini-2-5-flash-lite", 6, "Gemini Rift Oracle", "Gemini 2.5 Flash-Lite"],
];

function readArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

if (hasArg("--list")) {
  for (const [id, tier, name, title] of ROSTER) {
    console.log(`${tier}. ${id} - ${name} (${title})`);
  }
  process.exit(0);
}

const tierOrId = readArg("--tier") ?? readArg("--ai") ?? readArg("--model") ?? "1";
const base = readArg("--base") ?? "http://localhost:5173/";
const map = readArg("--map");
const opponent =
  ROSTER.find(([id, tier]) => tierOrId === id || tierOrId === String(tier)) ??
  (tierOrId === "final" || tierOrId === "gemini" ? ROSTER[ROSTER.length - 1] : undefined);

if (!opponent) {
  console.error(`Unknown AI opponent "${tierOrId}". Run: npm run ai:duel -- --list`);
  process.exit(1);
}

const [id, tier, name, title] = opponent;
const url = new URL(base);
url.searchParams.set("quickMatch", "1");
url.searchParams.set("opponent", "ai");
url.searchParams.set("aiDuel", "1");
url.searchParams.set("aiOpponent", id);
if (map) url.searchParams.set("map", map);

console.log(`AI duel target: tier ${tier} ${name} (${title})`);
console.log("");
console.log("Paste once in your local browser console to enable owner-only AI duels:");
console.log(`localStorage.setItem("${AI_ADMIN_STORAGE_KEY}", "enabled");`);
console.log("");
console.log("Open:");
console.log(url.toString());
