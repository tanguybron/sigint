require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const { supabase } = require("./lib/supabase");
const { computeClustersWithAI } = require("./lib/clustering");

const app = express();
const PORT = 3000;

// Serve static files (index.html, etc.)
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Explicit root + favicon to avoid 404s
app.get("/", (_, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/favicon.ico", (_, res) => res.status(204).end());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const POLL_INTERVAL_MS = 60_000; // 60 secondes
const HISTORY_MAX = 60;           // garder 60 points par marché (~1h)

const SCORE_WEIGHTS = {
  volumeSpike: 40,   // volume actuel vs moyenne 7j
  priceMove:   30,   // move de prix sur 1h
  whaleTrade:  20,   // gros trade individuel
  smartWallet: 10,   // wallet avec bon track record
};

const ALERT_THRESHOLDS = {
  critical: 80,
  high:     60,
  medium:   40,
};

// Tags Polymarket considérés comme géopolitiques
const GEO_TAGS = [
  "politics", "geopolitics", "world", "middle-east",
  "russia", "ukraine", "china", "iran", "nato",
  "nuclear", "elections", "war", "conflict", "sanctions"
];

// Mots-clés dans les titres pour filtrer les marchés géopolitiques
// (centrés sur les acteurs de conflits, pas la politique générale)
const GEO_KEYWORDS = [
  "iran", "israel", "russia", "ukraine", "china", "taiwan", "north korea",
  "khamenei", "putin", "xi jinping", "kim jong", "netanyahou",
  "nuclear", "military", "conflict", "troops", "army", "soldiers",
  "gaza", "palestine", "hezbollah", "syria", "lebanon", "iraq",
  "ceasefire", "embargo", "regime", "supreme leader",
  "ayatollah", "terrorist", "assassination", "assassinated",
  "strait of hormuz", "oil", "energy crisis", "pipeline",
  "military coup", "coup", "rebellion", "insurgency",
  "middle east", "yemen", "saudi", "emirates", "qatar", "gulf",
  "foreign policy", "nato", "europe", "wwiii", "world war"
];

// Focused conflict keywords (wars, strikes, escalations)
const CONFLICT_KEYWORDS = [
  "war", "world war", "armed conflict", "military conflict",
  "strike", "airstrike", "air strike", "missile strike", "drone strike",
  "bomb", "bombing", "shelling", "rocket attack", "rocket strikes",
  "attack", "offensive", "invasion", "incursion", "escalation",
  "troops", "deploy troops", "ground forces", "army", "soldiers",
  "ceasefire", "cease-fire", "peace deal", "peace talks",
  "nuclear test", "nuclear strike", "nuclear attack",
  "blockade", "naval blockade",
  "terrorist attack", "terror attack",
  "coup", "military coup"
];

const EXCLUDED_KEYWORDS = [
  "nba", "nhl", "nfl", "mlb", "football", "soccer", "tennis", "golf",
  "ufc", "boxing", "mma", "fight", "match", "game", "season",
  "counter-strike", "esports", "gaming", "league of legends", "lol", "dota",
  "oilers", "sharks", "borussia", "dortmund", "bundesliga",
  "movie", "film", "oscar", "grammy", "emmy", "netflix", "box office",
  "album", "music", "song", "concert", "tour", "artist", "band",
  "bitcoin", "btc", "ethereum", "crypto", "stock", "price", "trading",
  "governor", "mayor", "senate", "congress", "election", "poll", "vote",
  "fed chair", "federal reserve", "economy", "gdp", "inflation", "rate",
  "approval rating", "win the election", "president election",
  "tariff", "tariffs",
  "win the", " vs ", "versus", "will team", "will player",
  "draft", "trade", "free agency", "transfer", "championship",
  "warrior", "laker", "knick", "celtic", "suns", "liverpool", "manchester",
  "spread", "over/under", "point spread", "coach", "player props",
  "saudi club", "al qadisiyah", "al hilal", "al nassr"
];

const BAD_OUTCOME_KEYWORDS = [
  "iran bomb", "iran strike", "iran attack", "israel bomb", "israel strike", "israel attack",
  "russia bomb", "russia attack", "russia invasion", "china invade", "china attack",
  "war with", "world war", "nuclear war", "military conflict",
  "terrorist attack", "assassination", "assassinated",
  "close the strait", "strike iran", "us strike", "us attack", "attack iran",
  "invasion of", "civil war", "military coup"
];

function isImminent(market) {
  const endDate = market.endDate || market.endDateIso;
  if (!endDate) return false;
  const end = new Date(endDate);
  const now = new Date();
  const hoursUntil = (end - now) / (1000 * 60 * 60);
  return hoursUntil >= -24 && hoursUntil <= 48;
}

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const state = {
  markets: {},       // { marketId: { ...info, history: [], latestScore: 0 } }
  alerts: [],        // alertes générées, les plus récentes en premier
  trades: [],        // gros trades récents
  lastPoll: null,
  useMock: false,
  lastClusterIds: "",
  clusters: [],
  clusterRelationships: [],
  countries: [],
  strategicPoints: [],
  signalLog: [],
  seenSignals: new Set(),
};

// ─────────────────────────────────────────────
// SUPABASE — Persistance
// ─────────────────────────────────────────────
async function loadStateFromDB() {
  if (!supabase) return;
  try {
    const { data: snapshot } = await supabase
      .from("poll_state")
      .select("value")
      .eq("key", "latest_snapshot")
      .single();
    if (snapshot?.value) {
      const parsed = JSON.parse(snapshot.value);
      const m = parsed.markets;
      if (m && typeof m === "object" && !Array.isArray(m)) {
        state.markets = m;
      } else if (Array.isArray(m) && m.length > 0) {
        state.markets = m.reduce((acc, item) => {
          if (item && item.id) acc[item.id] = item;
          return acc;
        }, {});
      }
      state.trades = Array.isArray(parsed.trades) ? parsed.trades : [];
      state.lastPoll = parsed.lastPoll || null;
    }

    const { data: clusterIds } = await supabase
      .from("poll_state")
      .select("value")
      .eq("key", "lastClusterIds")
      .single();
    state.lastClusterIds = clusterIds?.value || "";

    const { data: relationships } = await supabase
      .from("poll_state")
      .select("value")
      .eq("key", "cluster_relationships")
      .single();
    state.clusterRelationships = JSON.parse(relationships?.value || "[]");

    const { data: countries } = await supabase
      .from("poll_state")
      .select("value")
      .eq("key", "countries")
      .single();
    state.countries = JSON.parse(countries?.value || "[]");

    const { data: points } = await supabase
      .from("poll_state")
      .select("value")
      .eq("key", "strategic_points")
      .single();
    state.strategicPoints = JSON.parse(points?.value || "[]");

    const { data: clusters } = await supabase
      .from("clusters")
      .select("*")
      .order("score", { ascending: false });
    const loadedClusters = (clusters || []).map((c) => ({
      name: c.name,
      events: (c.event_ids || [])
        .map((id) => state.markets[id])
        .filter(Boolean),
      eventCount: c.event_count ?? 0,
      topEvent: c.top_event_title
        ? {
            title: c.top_event_title,
            probability: c.top_event_probability ?? 0,
          }
        : null,
      avgProbability: c.avg_probability ?? 0,
      hotCount: c.hot_count ?? 0,
      clusterScore: c.score ?? 0,
    }));

    const validClusters = loadedClusters.filter((c) => (c.events || []).length > 0);
    const marketsArray = Object.values(state.markets || {});
    if (validClusters.length === 0 && marketsArray.length > 0) {
      state.clusters = [{
        name: "🌍 All Markets",
        events: marketsArray,
        eventCount: marketsArray.length,
        topEvent: marketsArray[0],
        avgProbability: 0,
        hotCount: 0,
        clusterScore: 0,
      }];
      console.log("  → Fallback cluster 'All Markets' (clusters DB vides ou event_ids invalides)");
    } else {
      state.clusters = validClusters.length > 0 ? validClusters : loadedClusters;
    }

    const { data: signals } = await supabase
      .from("signals")
      .select("*")
      .order("detected_at", { ascending: false })
      .limit(100);
    state.signalLog = signals || [];

    state.seenSignals = new Set(signals?.map((s) => s.id) || []);

    console.log(
      `  → État chargé depuis Supabase : ${signals?.length || 0} signaux, ${clusters?.length || 0} clusters`
    );
  } catch (err) {
    console.warn(
      "  ⚠ Impossible de charger depuis Supabase, état vide :",
      err.message
    );
  }
}

async function saveStateToDB() {
  if (!supabase) return;
  try {
    await supabase
      .from("poll_state")
      .upsert(
        {
          key: "latest_snapshot",
          value: JSON.stringify({
            markets: state.markets,
            trades: state.trades.slice(0, 50),
            lastPoll: state.lastPoll,
          }),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );

    await supabase
      .from("poll_state")
      .upsert(
        {
          key: "lastClusterIds",
          value: state.lastClusterIds || "",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );

    await supabase
      .from("poll_state")
      .upsert(
        {
          key: "cluster_relationships",
          value: JSON.stringify(state.clusterRelationships || []),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );

    await supabase
      .from("poll_state")
      .upsert(
        {
          key: "countries",
          value: JSON.stringify(state.countries || []),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );

    await supabase
      .from("poll_state")
      .upsert(
        {
          key: "strategic_points",
          value: JSON.stringify(state.strategicPoints || []),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );

    const clientState = buildClientState();
    const threatScore = clientState.stats?.threatScore;
    if (threatScore != null) {
      await supabase.from("threat_history").insert({ score: threatScore });
      await supabase.rpc("trim_threat_history");
    }

    if (state.clusters?.length > 0) {
      await supabase
        .from("clusters")
        .upsert(
          state.clusters.map((c) => ({
            id: c.name,
            name: c.name,
            score: c.clusterScore ?? c.score ?? 0,
            hot_count: c.hotCount ?? 0,
            event_count: c.eventCount ?? 0,
            avg_probability: c.avgProbability ?? 0,
            top_event_title: c.topEvent?.title ?? null,
            top_event_probability: c.topEvent?.probability ?? null,
            event_ids: (c.events || []).map((e) => e.id),
            computed_at: new Date().toISOString(),
          })),
          { onConflict: "id" }
        );
    }
  } catch (err) {
    console.warn("  ⚠ Erreur sauvegarde Supabase :", err.message);
  }
}

// ─────────────────────────────────────────────
// SSE — Server-Sent Events pour le frontend
// ─────────────────────────────────────────────
const sseClients = new Set();

app.get("/events", (req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
  });
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
  // Envoie l'état actuel immédiatement à la connexion
  sendToClient(res, "state", buildClientState());
});

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(msg));
}

function sendToClient(client, event, data) {
  client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────
const CACHE_STALE_MS = 55_000;
let pollInProgress = null;

app.get("/api/state", async (_, res) => {
  if (process.env.VERCEL) {
    const stale = !state.lastPoll || (Date.now() - new Date(state.lastPoll).getTime() > CACHE_STALE_MS);
    const empty = Object.keys(state.markets).length === 0;
    if (empty || stale) {
      if (!pollInProgress) {
        pollInProgress = poll().finally(() => { pollInProgress = null; });
      }
      try {
        await Promise.race([pollInProgress, new Promise(r => setTimeout(r, 25000))]);
      } catch (err) {
        console.warn("  ⚠ Poll failed:", err.message);
      }
    }
    if (Object.keys(state.markets).length === 0) {
      state.useMock = true;
      injectMockData();
    }
  }
  res.json(buildClientState());
});
app.get("/api/alerts", (_, res) => res.json(state.alerts.slice(0, 50)));
app.get("/api/trades", (_, res) => res.json(state.trades.slice(0, 30)));
app.get("/api/clusters", (_, res) => res.json(state.clusters || []));

function buildClientState() {
  const markets = Object.values(state.markets)
    .filter(m => m.probability < 0.99)
    .sort((a, b) => (b.probability || 0) - (a.probability || 0))
    .slice(0, 500);

  const criticalCount = markets.filter(m => m.score >= ALERT_THRESHOLDS.critical).length;
  const highCount     = markets.filter(m => m.score >= ALERT_THRESHOLDS.high && m.score < ALERT_THRESHOLDS.critical).length;
  const mediumCount  = markets.filter(m => m.score >= ALERT_THRESHOLDS.medium && m.score < ALERT_THRESHOLDS.high).length;

  const totalVol1h = markets.reduce((sum, m) => sum + (m.volume1h || 0), 0);
  const avgSpike   = markets.length
    ? markets.reduce((sum, m) => sum + (m.volumeSpike || 1), 0) / markets.length
    : 1;

  // Tension indicator (0–100): combines alert density, severity, bad-outcome pressure, activity, whale
  const density   = Math.min(35, criticalCount * 8 + highCount * 2 + Math.min(mediumCount, 5));
  const topScores = markets.map(m => m.score || 0).sort((a, b) => b - a).slice(0, 5);
  const severity  = topScores.length ? (topScores.reduce((s, v) => s + v, 0) / topScores.length) * 0.25 : 0;
  const badMarkets = markets.filter(m => m.isBadOutcome);
  const badPressure = Math.min(20, badMarkets.reduce((s, m) => s + (m.probability || 0) * 15, 0));
  const activity  = Math.min(15, (avgSpike || 1) * 3);
  const whale     = Math.min(5, markets.filter(m => (m.maxSingleTrade || 0) >= 10000).length);
  const threatScore = Math.min(100, Math.round(density + severity + badPressure + activity + whale));

  return {
    markets,
    alerts:       state.alerts.slice(0, 20),
    trades:       state.trades.slice(0, 20),
    clusters:     state.clusters || [],
    clusterRelationships: state.clusterRelationships || [],
    countries:     state.countries || [],
    strategicPoints: state.strategicPoints || [],
    stats: {
      criticalCount,
      totalVol1h:   Math.round(totalVol1h),
      avgSpike:     Math.round(avgSpike * 10) / 10,
      threatScore,
      useMock:      state.useMock,
      lastPoll:     state.lastPoll,
    },
  };
}

// ─────────────────────────────────────────────
// POLYMARKET API — EVENTS
// ─────────────────────────────────────────────
const GAMMA_URL = "https://gamma-api.polymarket.com";
const CLOB_URL  = "https://clob.polymarket.com";

const EVENTS_LIMIT = 200;
const EVENTS_MAX_PAGES = 5;

/** Geo/conflict filter on event.title / event.description (and tags if present). */
function isGeoEvent(event) {
  const title = (event.title || "").toLowerCase();
  const desc  = (event.description || "").toLowerCase();
  const text  = title + " " + desc;
  const tags  = (event.tags || []).map(t => (t.slug || t.label || t).toLowerCase());

  const hasGeoTag = tags.some(tag => GEO_TAGS.includes(tag));
  const hasGeoKeyword = GEO_KEYWORDS.some(kw => text.includes(kw));
  const hasConflictWord = CONFLICT_KEYWORDS.some(kw => text.includes(kw));
  const mentionsHotState = ["iran", "israel", "russia", "ukraine", "china", "taiwan", "gaza", "nato"]
    .some(kw => text.includes(kw));
  const hasConflict = hasConflictWord && (mentionsHotState || text.includes("world war") || text.includes("wwiii"));
  const hasExcluded = EXCLUDED_KEYWORDS.some(kw => text.includes(kw));

  // On cible les conflits / tensions militaires, pas les procès, tweets, ou politique pure.
  return !hasExcluded && (
    hasConflict ||
    (hasGeoTag && mentionsHotState) ||
    (hasGeoKeyword && (hasConflictWord || mentionsHotState))
  );
}

/** Parse probability from market outcomePrices / lastTradePrice. */
function parseOutcomeProbability(market) {
  const raw = market.outcomePrices || market.lastTradePrice || market.probability;
  if (raw == null) return 0;
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? parseFloat(arr[0]) || 0 : parseFloat(raw) || 0;
    } catch {
      return parseFloat(raw) || 0;
    }
  }
  if (Array.isArray(raw) && raw[0] != null) return parseFloat(raw[0]) || 0;
  return parseFloat(raw) || 0;
}

// YES-only probability helper (always index 0, never NO)
function yesProbability(market) {
  const raw = market.outcomePrices;
  if (!raw) return 0;
  try {
    if (typeof raw === "string") {
      const arr = JSON.parse(raw);
      return parseFloat(Array.isArray(arr) ? arr[0] : arr) || 0;
    }
    return parseFloat(raw[0] ?? 0) || 0;
  } catch {
    return 0;
  }
}

function getOutcomePrices(market) {
  const raw = market.outcomePrices || market.lastTradePrice || market.probability;
  if (raw == null) return [];
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(p => parseFloat(p) || 0) : [parseFloat(raw) || 0];
    } catch { return [parseFloat(raw) || 0]; }
  }
  if (Array.isArray(raw)) return raw.map(p => parseFloat(p) || 0);
  return [parseFloat(raw) || 0];
}

function expandEventMarketsToOutcomes(apiEvent) {
  const eventMarkets = apiEvent.markets || [];
  const outcomes = [];
  for (let i = 0; i < eventMarkets.length; i++) {
    const m = eventMarkets[i];
    const prices = getOutcomePrices(m);
    const labels = (typeof m.outcomes === "string" ? JSON.parse(m.outcomes || "[]") : m.outcomes) || [];
    const vol24 = parseFloat(m.volume24hr ?? m.volume ?? 0) / Math.max(1, prices.length);
    for (let j = 0; j < prices.length; j++) {
      outcomes.push({
        question: (labels[j] || m.question || `Outcome ${outcomes.length + 1}`).trim(),
        probability: prices[j],
        volume24h: vol24,
        marketId: m.id || m.conditionId || m.slug || `${apiEvent.id}-${i}-${j}`,
      });
    }
  }
  if (outcomes.length === 0 && eventMarkets.length > 0) {
    eventMarkets.forEach((m, i) => {
      outcomes.push({
        question: m.question || m.title || `Outcome ${i + 1}`,
        probability: parseOutcomeProbability(m),
        volume24h: parseFloat(m.volume24hr ?? m.volume ?? 0),
        marketId: m.id || m.conditionId || m.slug || `${apiEvent.id}-${i}`,
      });
    });
  }
  return outcomes;
}

function updateClusterStats(events) {
  if (!state.clusters || state.clusters.length === 0) return;

  state.clusters = state.clusters.map(cluster => {
    const updatedEvents = cluster.events
      .map(ce => events.find(e => String(e.id) === String(ce.id)))
      .filter(Boolean);

    if (updatedEvents.length === 0) return cluster;

    const topEvent = updatedEvents.reduce((best, e) =>
      (e.score || 0) > (best.score || 0) ? e : best
    , updatedEvents[0]);

    const avgProbability = updatedEvents.reduce((sum, e) =>
      sum + (e.probability || 0), 0
    ) / updatedEvents.length;

    const hotCount = updatedEvents.filter(e => (e.probability || 0) > 0.5).length;

    return {
      ...cluster,
      events: updatedEvents,
      topEvent,
      avgProbability: Math.round(avgProbability * 100) / 100,
      hotCount,
      clusterScore: Math.min(100, (topEvent.score || 0) + hotCount * 8)
    };
  });

  state.clusters.sort((a, b) => {
    if (b.clusterScore !== a.clusterScore) return b.clusterScore - a.clusterScore;
    if (b.hotCount !== a.hotCount) return b.hotCount - a.hotCount;
    return b.eventCount - a.eventCount;
  });
}

/** Compute signal for multiple-outcome event from history. */
function computeSignal(probsNow, probs1hAgo) {
  if (!probsNow.length || !probs1hAgo || probs1hAgo.length !== probsNow.length) return null;
  const getSum = arr => arr.reduce((a, b) => a + b, 0);

  // Concentration: one outcome > 60%
  const maxProb = Math.max(...probsNow);
  if (maxProb >= 0.6) return "concentration";

  // New leader: outcome was < 15% 1h ago and is now > 25%
  for (let i = 0; i < probsNow.length; i++) {
    if ((probs1hAgo[i] || 0) < 0.15 && probsNow[i] >= 0.25) return "new_leader";
  }

  // Redistribution: one outcome +8% in 1h while others drop (total roughly stable)
  const sumNow = getSum(probsNow);
  const sum1h = getSum(probs1hAgo);
  if (Math.abs(sumNow - sum1h) < 0.05) {
    for (let i = 0; i < probsNow.length; i++) {
      const delta = (probsNow[i] || 0) - (probs1hAgo[i] || 0);
      if (delta >= 0.08) return "redistribution";
    }
  }

  return null;
}

/** Find index with largest absolute prob change vs 1h ago. */
function findTopMover(probsNow, probs1hAgo) {
  if (!probs1hAgo || probsNow.length !== probs1hAgo.length) return null;
  let maxDelta = 0;
  let idx = -1;
  for (let i = 0; i < probsNow.length; i++) {
    const d = Math.abs((probsNow[i] || 0) - (probs1hAgo[i] || 0));
    if (d > maxDelta) {
      maxDelta = d;
      idx = i;
    }
  }
  return idx >= 0 ? { index: idx, delta: Math.round(maxDelta * 100) } : null;
}

async function fetchGeoEvents() {
  const allEvents = [];
  const maxPages = process.env.VERCEL ? 4 : EVENTS_MAX_PAGES;
  for (let offset = 0; offset < maxPages * EVENTS_LIMIT; offset += EVENTS_LIMIT) {
    const url = `${GAMMA_URL}/events?active=true&closed=false&limit=${EVENTS_LIMIT}&offset=${offset}&order=volume24hr&ascending=false`;
    const res = await fetch(url, { timeout: process.env.VERCEL ? 8_000 : 10_000 });
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);
    const data = await res.json();
    if (!data || !data.length) break;
    allEvents.push(...data);
    if (data.length < EVENTS_LIMIT) break;
  }

  const geo = allEvents.filter(e => isGeoEvent(e));
  console.log(`  → Fetched ${allEvents.length} events, ${geo.length} geo`);
  return geo;
}

/** Build structured event from API event + previous state (for history). */
function buildEventPayload(apiEvent, previousState) {
  const id = String(apiEvent.id);
  const title = apiEvent.title || "—";
  const outcomes = expandEventMarketsToOutcomes(apiEvent);
  const type = outcomes.length > 2 ? "multiple" : "binary";

  const outcomeProbs = [];
  const markets = [];
  let totalVolume24h = 0;

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    outcomeProbs.push(o.probability);
    totalVolume24h += o.volume24h || 0;
    markets.push({
      id: o.marketId,
      question: o.question,
      probability: o.probability,
      volume24h: o.volume24h || 0,
      priceMove1h: 0,
    });
  }

  // Lead outcome based on YES (index 0) probability only, across all original markets
  let leadProb = 0;
  let leadLabel = null;
  const apiMarkets = apiEvent.markets || [];
  for (let i = 0; i < apiMarkets.length; i++) {
    const m = apiMarkets[i];
    const pYes = yesProbability(m);
    if (pYes > leadProb) {
      leadProb = pYes;
      leadLabel = m.question || m.groupItemTitle || title;
    }
  }

  const prevPerIndexForMove = previousState?.outcomeHistoryPerIndex;
  if (prevPerIndexForMove) {
    for (let i = 0; i < markets.length; i++) {
      const hist = prevPerIndexForMove[i];
      const hourAgo = hist && hist.length >= 60 ? hist[hist.length - 60] : (hist && hist[0]);
      if (hourAgo != null) markets[i].priceMove1h = Math.round((outcomeProbs[i] - hourAgo) * 100);
    }
  }

  const leadOutcome = leadLabel != null
    ? { index: 0, question: leadLabel, probability: leadProb }
    : null;

  const outcomeHistory = previousState?.outcomeHistory || [];
  const probs1hAgo = outcomeHistory.length >= 60
    ? outcomeHistory[outcomeHistory.length - 60]
    : outcomeHistory[0];
  const topMoverInfo = findTopMover(outcomeProbs, probs1hAgo);
  const topMover = topMoverInfo && markets[topMoverInfo.index]
    ? {
        index: topMoverInfo.index,
        question: markets[topMoverInfo.index].question,
        probability: markets[topMoverInfo.index].probability,
        delta: topMoverInfo.delta,
      }
    : null;

  const signal = type === "multiple" && probs1hAgo
    ? computeSignal(outcomeProbs, probs1hAgo)
    : null;

  const prevPerIndex = previousState?.outcomeHistoryPerIndex;
  const outcomeHistoryPerIndex = outcomeProbs.map((p, i) => {
    const arr = (prevPerIndex && prevPerIndex[i]) ? [...prevPerIndex[i]] : [];
    arr.push(p);
    return arr.length > HISTORY_MAX ? arr.slice(-HISTORY_MAX) : arr;
  });

  const newOutcomeHistory = [...outcomeHistory.slice(-(HISTORY_MAX - 1)), outcomeProbs];

  const volHistory = previousState?.volumeHistory || [];
  const newVolHistory = [...volHistory.slice(-(HISTORY_MAX - 1)), totalVolume24h];
  let volumeSpike = 1;
  if (newVolHistory.length >= 3) {
    const recent = newVolHistory.slice(-7);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg > 0) volumeSpike = Math.round((totalVolume24h / avg) * 10) / 10;
  }

  return {
    id,
    title,
    type,
    markets,
    leadOutcome,
    topMover,
    totalVolume24h,
    signal,
    outcomeProbs,
    outcomeHistory: newOutcomeHistory,
    outcomeHistoryPerIndex,
    volumeHistory: newVolHistory.length > HISTORY_MAX ? newVolHistory.slice(-HISTORY_MAX) : newVolHistory,
    volumeSpike,
  };
}

function isBadOutcome(title) {
  const t = (title || "").toLowerCase();
  const hasBadWord = BAD_OUTCOME_KEYWORDS.some(kw => t.includes(kw));
  const hasSport = t.includes("warrior") || t.includes("laker") || t.includes("nba") || t.includes("counter-strike") || t.includes("ufc") || t.includes("boxing");
  return hasBadWord && !hasSport;
}

async function fetchRecentTrades(conditionId) {
  const res = await fetch(
    `${CLOB_URL}/trades?market=${conditionId}&limit=50`,
    { timeout: 8_000 }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || data || [];
}

// ─────────────────────────────────────────────
// SCORING ENGINE
// ─────────────────────────────────────────────
function scoreMarket(market, newData) {
  let score = 0;
  const breakdown = {};

  // — Volume spike (use API real-time or historical)
  const spike = market.volumeSpike || computeVolumeSpike(market, newData.volume24h);
  breakdown.volumeSpike = spike;
  if (spike >= 10) score += SCORE_WEIGHTS.volumeSpike;
  else if (spike >= 5)  score += SCORE_WEIGHTS.volumeSpike * 0.7;
  else if (spike >= 3)  score += SCORE_WEIGHTS.volumeSpike * 0.4;

  // — Price move (use API real-time oneHourPriceChange or historical)
  let priceMoveAbs = Math.abs(market.oneHourPriceChange || 0);
  if (priceMoveAbs === 0) {
    priceMoveAbs = computePriceMove1h(market, newData.probability);
  }
  breakdown.priceMove = priceMoveAbs;
  if (priceMoveAbs >= 25) score += SCORE_WEIGHTS.priceMove;
  else if (priceMoveAbs >= 15) score += SCORE_WEIGHTS.priceMove * 0.7;
  else if (priceMoveAbs >= 8)  score += SCORE_WEIGHTS.priceMove * 0.4;

  // — Whale trade
  const maxTrade = newData.maxSingleTrade || 0;
  breakdown.whaleTrade = maxTrade;
  if (maxTrade >= 50_000) score += SCORE_WEIGHTS.whaleTrade;
  else if (maxTrade >= 20_000) score += SCORE_WEIGHTS.whaleTrade * 0.7;
  else if (maxTrade >= 10_000) score += SCORE_WEIGHTS.whaleTrade * 0.4;

  // — Smart wallet (simplifié : on considère un wallet "smart" si winRate > 0.7)
  if (newData.hasSmartWallet) score += SCORE_WEIGHTS.smartWallet;

  // — High probability on bad outcomes (wars, attacks, etc.)
  if (market.isBadOutcome && newData.probability >= 0.8) {
    score += 15;
  } else if (market.isBadOutcome && newData.probability >= 0.5) {
    score += 8;
  }

  return { score: Math.round(Math.min(100, score)), breakdown };
}

/** Score an event (binary or multiple). Binary uses legacy logic; multiple adds signal-based points. */
function scoreEvent(ev) {
  const prob = ev.leadOutcome ? ev.leadOutcome.probability : 0;
  const vol24 = ev.totalVolume24h || 0;

  if (ev.type === "binary") {
    const market = {
      probability: prob,
      volume24h: vol24,
      volumeSpike: ev.volumeSpike ?? 1,
      oneHourPriceChange: ev.markets[0]?.priceMove1h ?? 0,
      isBadOutcome: isBadOutcome(ev.title),
      history: (ev.outcomeHistory || []).map(probs => ({ probability: probs[0] || 0, volume24h: vol24 })),
    };
    const newData = {
      volume24h: vol24,
      probability: prob,
      maxSingleTrade: ev.maxSingleTrade || 0,
      hasSmartWallet: ev.hasSmartWallet || false,
    };
    return scoreMarket(market, newData);
  }

  let score = 0;
  const breakdown = { volumeSpike: ev.volumeSpike ?? 1, priceMove: 0, whaleTrade: ev.maxSingleTrade || 0 };

  if ((ev.volumeSpike || 1) >= 10) score += SCORE_WEIGHTS.volumeSpike;
  else if ((ev.volumeSpike || 1) >= 5) score += SCORE_WEIGHTS.volumeSpike * 0.7;
  else if ((ev.volumeSpike || 1) >= 3) score += SCORE_WEIGHTS.volumeSpike * 0.4;

  const maxMove = Math.max(0, ...(ev.markets || []).map(m => Math.abs(m.priceMove1h || 0)));
  breakdown.priceMove = maxMove;
  if (maxMove >= 25) score += SCORE_WEIGHTS.priceMove;
  else if (maxMove >= 15) score += SCORE_WEIGHTS.priceMove * 0.7;
  else if (maxMove >= 8) score += SCORE_WEIGHTS.priceMove * 0.4;

  if ((ev.maxSingleTrade || 0) >= 50_000) score += SCORE_WEIGHTS.whaleTrade;
  else if ((ev.maxSingleTrade || 0) >= 20_000) score += SCORE_WEIGHTS.whaleTrade * 0.7;
  else if ((ev.maxSingleTrade || 0) >= 10_000) score += SCORE_WEIGHTS.whaleTrade * 0.4;
  if (ev.hasSmartWallet) score += SCORE_WEIGHTS.smartWallet;

  if (ev.signal === "new_leader") score += 20;
  else if (ev.signal === "redistribution") score += 15;
  else if (ev.signal === "concentration") score += 10;

  if (isBadOutcome(ev.title) && prob >= 0.8) score += 15;
  else if (isBadOutcome(ev.title) && prob >= 0.5) score += 8;

  return { score: Math.round(Math.min(100, score)), breakdown };
}

function computeVolumeSpike(market, currentVol24h) {
  if (!market.history || market.history.length < 3) return 1;
  const historicVols = market.history.slice(-7).map(h => h.volume24h).filter(Boolean);
  if (!historicVols.length) return 1;
  const avg = historicVols.reduce((a, b) => a + b, 0) / historicVols.length;
  if (!avg) return 1;
  return Math.round((currentVol24h / avg) * 10) / 10;
}

function computePriceMove1h(market, currentProb) {
  if (!market.history || market.history.length < 2) return 0;
  // Cherche le point il y a ~1h (60 points à 60s = 60 entrées max)
  const hourAgo = market.history[Math.max(0, market.history.length - 60)];
  if (!hourAgo) return 0;
  return Math.abs(Math.round((currentProb - hourAgo.probability) * 100));
}

function computeVolume1h(market) {
  if (!market.history || market.history.length < 5) return 0;
  // Approximation : différence de volume cumulé sur les 60 derniers points
  const recent = market.history.slice(-60);
  if (recent.length < 2) return 0;
  return Math.max(0, (recent[recent.length - 1].volumeCumul || 0) - (recent[0].volumeCumul || 0));
}

// ─────────────────────────────────────────────
// ALERT ENGINE
// ─────────────────────────────────────────────
function maybeFireAlert(marketId, market, score, breakdown) {
  const level =
    score >= ALERT_THRESHOLDS.critical ? "critical" :
    score >= ALERT_THRESHOLDS.high     ? "high" :
    score >= ALERT_THRESHOLDS.medium   ? "medium" : null;

  if (!level) return;

  // Ne re-déclenche pas une alerte si le score n'a pas progressé de 10pts
  const lastAlert = state.alerts.find(a => a.marketId === marketId);
  if (lastAlert && Math.abs(lastAlert.score - score) < 10) return;

  const alert = {
    id:        `${marketId}-${Date.now()}`,
    marketId,
    title:     market.title,
    score,
    level,
    breakdown,
    probability:  Math.round((market.probability || 0) * 100),
    volumeSpike:  breakdown.volumeSpike,
    priceMove:    breakdown.priceMove,
    whaleTrade:   breakdown.whaleTrade,
    timestamp:    new Date().toISOString(),
  };

  state.alerts.unshift(alert);
  if (state.alerts.length > 200) state.alerts.pop();

  broadcast("alert", alert);
  console.log(`🚨 [${level.toUpperCase()}] ${market.title} — Score: ${score}`);

  if (level === "high" && process.env.WEBHOOK_URL) {
    sendDiscordNotification(alert).catch(err =>
      console.warn("  ⚠ Discord webhook failed:", err.message)
    );
  }
}

async function sendDiscordNotification(alert) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;

  const body = {
    embeds: [{
      title: `🚨 HIGH ALERT — Score ${alert.score}/100`,
      description: alert.title,
      color: 0xFEE75C,
      fields: [
        { name: "Probability", value: `${alert.probability}%`, inline: true },
        { name: "Vol Spike", value: `${alert.volumeSpike ?? "—"}×`, inline: true },
        { name: "Price Move 1h", value: `${alert.priceMove ?? 0}%`, inline: true },
        { name: "Whale Trade", value: alert.whaleTrade ? `$${Math.round(alert.whaleTrade).toLocaleString()}` : "—", inline: true },
      ],
      timestamp: alert.timestamp,
    }],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeout: 5000,
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

// ─────────────────────────────────────────────
// CLUSTER UPDATE (extracted for reuse)
// ─────────────────────────────────────────────
async function runClusterUpdate() {
  const eventsArray = Object.values(state.markets);
  const currentIds = eventsArray.map((e) => e?.id).filter(Boolean).sort().join(",");

  try {
    if (currentIds !== state.lastClusterIds) {
      console.log("  → Liste d'events modifiée, recalcul des clusters IA...");
      if (process.env.OPENROUTER_API_KEY) {
        const { clusters, relationships, countries, strategicPoints } = await computeClustersWithAI(eventsArray);
        state.clusters = clusters || [];
        state.clusterRelationships = relationships || [];
        state.countries = countries || [];
        state.strategicPoints = strategicPoints || [];
        state.lastClusterIds = currentIds;
        console.log(`  → ${state.clusters.length} clusters, ${state.clusterRelationships.length} rels, ${state.countries.length} countries, ${state.strategicPoints.length} points`);
      } else {
        state.lastClusterIds = currentIds;
        console.warn("  ⚠ OPENROUTER_API_KEY manquant, clustering IA désactivé");
      }
    } else {
      updateClusterStats(eventsArray);
    }

    if ((!state.clusters || state.clusters.length === 0) && eventsArray.length > 0) {
      state.clusters = [{
        name: "🌍 All Markets",
        events: eventsArray,
        eventCount: eventsArray.length,
        topEvent: eventsArray[0],
        avgProbability: 0,
        hotCount: 0,
        clusterScore: 0,
      }];
      console.log("  → Fallback cluster 'All Markets'");
    }
  } catch (err) {
    console.warn("  ⚠ Clustering IA échoué, fallback cluster unique:", err.message);
    if (eventsArray.length > 0) {
      state.clusters = [{
        name: "🌍 All Markets",
        events: eventsArray,
        eventCount: eventsArray.length,
        topEvent: eventsArray[0],
        avgProbability: 0,
        hotCount: 0,
        clusterScore: 0,
      }];
    }
  }
}

// ─────────────────────────────────────────────
// MAIN POLLER
// ─────────────────────────────────────────────
async function poll() {
  console.log(`[${new Date().toISOString()}] Polling Polymarket...`);
  try {
    const geoEvents = await fetchGeoEvents();
    state.useMock = false;

    if (geoEvents.length === 0) {
      console.warn("  ⚠ Polymarket a retourné 0 événements géo — conservation des données existantes");
      if (Object.keys(state.markets).length === 0) {
        state.useMock = true;
        injectMockData();
      }
      await runClusterUpdate();
      await saveStateToDB();
      state.lastPoll = new Date().toISOString();
      broadcast("state", buildClientState());
      return;
    }

    const validIds = new Set();

    for (let i = 0; i < geoEvents.length; i++) {
      const apiEvent = geoEvents[i];
      const id = String(apiEvent.id);
      validIds.add(id);
      const previous = state.markets[id] || null;

      const ev = buildEventPayload(apiEvent, previous);

      let maxSingleTrade = 0;
      let hasSmartWallet = false;
      const firstMarket = apiEvent.markets && apiEvent.markets[0];
      const conditionId = firstMarket?.conditionId || firstMarket?.id || id;
      if (!process.env.VERCEL) {
      try {
        const trades = await fetchRecentTrades(conditionId);
        for (const t of trades) {
          const size = parseFloat(t.size || t.amount || 0);
          if (size > maxSingleTrade) maxSingleTrade = size;
          if (size >= 10_000) {
            state.trades.unshift({
              marketId: id,
              marketTitle: ev.title,
              amount: Math.round(size),
              side: t.side || (t.outcomeIndex === 0 ? "YES" : "NO"),
              wallet: t.maker || t.transactionHash?.slice(0, 10) || "0x???",
              timestamp: t.createdAt || new Date().toISOString(),
            });
            hasSmartWallet = true;
          }
        }
        if (state.trades.length > 100) state.trades = state.trades.slice(0, 100);
      } catch (_) {}
      }

      ev.maxSingleTrade = maxSingleTrade;
      ev.hasSmartWallet = hasSmartWallet;

      const { score, breakdown } = scoreEvent(ev);
      ev.score = score;
      ev.breakdown = breakdown;

      ev.probability = ev.leadOutcome ? ev.leadOutcome.probability : 0;
      ev.volume24h = ev.totalVolume24h;
      ev.volume1h = (ev.volumeHistory && ev.volumeHistory.length >= 2)
        ? Math.max(0, (ev.volumeHistory[ev.volumeHistory.length - 1] || 0) - (ev.volumeHistory[ev.volumeHistory.length - 2] || 0))
        : 0;
      ev.priceMove1h = ev.type === "binary" && ev.markets[0]
        ? (ev.markets[0].priceMove1h || 0)
        : (ev.topMover ? ev.topMover.delta : 0);
      ev.isBadOutcome = isBadOutcome(ev.title);
      ev.endDate = apiEvent.endDate || apiEvent.endDateIso || null;
      ev.isImminent = isImminent({ endDate: ev.endDate, endDateIso: ev.endDate });
      ev.history = (ev.outcomeHistory || []).map(probs => ({
        timestamp: Date.now(),
        probability: probs[0] ?? 0,
        volume24h: ev.totalVolume24h,
        volumeCumul: ev.totalVolume24h,
      }));

      state.markets[id] = ev;
      maybeFireAlert(id, ev, score, breakdown);
    }

    for (const existingId of Object.keys(state.markets)) {
      if (!validIds.has(existingId) && !existingId.startsWith("mock-")) {
        delete state.markets[existingId];
      }
    }

  } catch (err) {
    console.warn(`  ⚠ API injoignable (${err.message}) — passage en mode mock`);
    state.useMock = true;
    injectMockData();
  }

  await runClusterUpdate();
  await saveStateToDB();
  state.lastPoll = new Date().toISOString();
  broadcast("state", buildClientState());
}

// ─────────────────────────────────────────────
// MOCK DATA (pour tester sans internet)
// ─────────────────────────────────────────────
function injectMockData() {
  const mockMarkets = [
    {
      id: "mock-iran-strike",
      title: "Israël frappera un site nucléaire iranien avant juillet 2025",
      probability: 0.68, volume24h: 847_000, volumeSpike: 14.2,
      priceMove1h: 41, maxSingleTrade: 84_200, hasSmartWallet: true,
      score: 94, level: "critical",
    },
    {
      id: "mock-gaza-ceasefire",
      title: "Cessez-le-feu permanent à Gaza avant fin mars 2025",
      probability: 0.52, volume24h: 312_000, volumeSpike: 8.1,
      priceMove1h: 19, maxSingleTrade: 51_800, hasSmartWallet: true,
      score: 71, level: "high",
    },
    {
      id: "mock-russia-offensive",
      title: "La Russie lancera une offensive majeure en Ukraine avant Q3 2025",
      probability: 0.39, volume24h: 198_000, volumeSpike: 4.7,
      priceMove1h: 12, maxSingleTrade: 0, hasSmartWallet: false,
      score: 58, level: "high",
    },
    {
      id: "mock-kim-putin",
      title: "Kim Jong-Un rencontrera Poutine en personne en 2025",
      probability: 0.61, volume24h: 87_000, volumeSpike: 3.2,
      priceMove1h: 18, maxSingleTrade: 0, hasSmartWallet: false,
      score: 44, level: "medium",
    },
    {
      id: "mock-taiwan-blockade",
      title: "La Chine imposera un blocus naval à Taïwan en 2025",
      probability: 0.22, volume24h: 64_000, volumeSpike: 2.1,
      priceMove1h: 5, maxSingleTrade: 0, hasSmartWallet: false,
      score: 22, level: null,
    },
    {
      id: "mock-iran-nuclear",
      title: "L'Iran atteindra la capacité nucléaire militaire en 2025",
      probability: 0.31, volume24h: 145_000, volumeSpike: 5.8,
      priceMove1h: 14, maxSingleTrade: 32_000, hasSmartWallet: true,
      score: 65, level: "high",
    },
  ];

  // Simule une légère variation des prix à chaque tick
  for (const m of mockMarkets) {
    if (!state.markets[m.id]) {
      state.markets[m.id] = { ...m, history: [], breakdown: {} };
      for (let i = 60; i >= 0; i--) {
        const jitter = (Math.random() - 0.5) * 0.06;
        state.markets[m.id].history.push({
          timestamp: Date.now() - i * 60_000,
          probability: Math.max(0, Math.min(1, m.probability - (i / 60) * 0.3 + jitter)),
          volume24h: m.volume24h * (0.5 + (i / 60) * 0.5),
        });
      }
    } else {
      const prev = state.markets[m.id];
      const jitter = (Math.random() - 0.5) * 0.015;
      prev.probability = Math.max(0, Math.min(1, (prev.probability || m.probability) + jitter));
      prev.volume24h   = m.volume24h * (1 + (Math.random() - 0.5) * 0.05);
      prev.score       = m.score + Math.round((Math.random() - 0.5) * 5);
      prev.history.push({
        timestamp:   Date.now(),
        probability: prev.probability,
        volume24h:   prev.volume24h,
      });
      if (prev.history.length > HISTORY_MAX) prev.history.shift();
    }
  }

  // Mock trades
  const mockTrades = [
    { marketId: "mock-iran-strike", marketTitle: "Israël frappe site nucléaire iranien", amount: 84200, side: "YES", wallet: "0x4f2a...3c9b", isSmartWallet: true, timestamp: new Date(Date.now() - 4 * 60_000).toISOString() },
    { marketId: "mock-gaza-ceasefire", marketTitle: "Cessez-le-feu Gaza avant mars", amount: 51800, side: "YES", wallet: "0x9e3f...b12a", isSmartWallet: false, timestamp: new Date(Date.now() - 9 * 60_000).toISOString() },
    { marketId: "mock-iran-nuclear", marketTitle: "Iran capacité nucléaire militaire", amount: 32000, side: "YES", wallet: "0x2d8c...a07f", isSmartWallet: true, timestamp: new Date(Date.now() - 18 * 60_000).toISOString() },
  ];
  state.trades = mockTrades;

  // Mock clusters (when no AI clustering)
  const mockMarketsArray = mockMarkets.map((m) => state.markets[m.id]).filter(Boolean);
  if (mockMarketsArray.length > 0 && (!state.clusters || state.clusters.length === 0)) {
    state.clusters = [{
      name: "🌍 All Markets",
      events: mockMarketsArray,
      eventCount: mockMarketsArray.length,
      topEvent: mockMarketsArray[0],
      avgProbability: 0,
      hotCount: 0,
      clusterScore: 0,
    }];
  }

  // Mock alerts
  if (state.alerts.length === 0) {
    state.alerts = [
      { id: "a1", marketId: "mock-iran-strike", title: "Israël frappe site nucléaire iranien", score: 94, level: "critical", probability: 68, volumeSpike: 14.2, priceMove: 41, whaleTrade: 84200, timestamp: new Date(Date.now() - 4 * 60_000).toISOString() },
      { id: "a2", marketId: "mock-iran-nuclear", title: "Iran capacité nucléaire militaire", score: 65, level: "high", probability: 31, volumeSpike: 5.8, priceMove: 14, whaleTrade: 32000, timestamp: new Date(Date.now() - 18 * 60_000).toISOString() },
      { id: "a3", marketId: "mock-gaza-ceasefire", title: "Cessez-le-feu Gaza", score: 71, level: "high", probability: 52, volumeSpike: 8.1, priceMove: 19, whaleTrade: 51800, timestamp: new Date(Date.now() - 24 * 60_000).toISOString() },
    ];
  }
}

// ─────────────────────────────────────────────
// DÉMARRAGE (skip on Vercel serverless)
// ─────────────────────────────────────────────
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    console.log(`\n🚀 SIGINT Dashboard → http://localhost:${PORT}\n`);

    await loadStateFromDB();

    if (Object.keys(state.markets).length === 0) {
      console.log("  → Aucune donnée chargée, premier poll immédiat...");
    }

    poll();
    setInterval(poll, POLL_INTERVAL_MS);
  });
}

module.exports = app;
