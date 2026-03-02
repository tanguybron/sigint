/**
 * AI-powered geopolitical clustering with countries and relationships.
 * Uses OpenRouter to group events, extract countries by bloc, and define relationships.
 */

const TIMEOUT_MS = 30_000;
const MAX_EVENTS_FOR_CLUSTERING = 120;

const PROMPT = (titles) => `Analyze these prediction market events and return a JSON object
with exactly three fields. No explanation, no markdown, no backticks.

{
  "clusters": [
    {
      "name": "cluster name with flag emoji",
      "eventIds": ["id1", "id2", ...]
    }
  ],
  "relationships": [
    {
      "from": "cluster name A",
      "to": "cluster name B",
      "label": "one word",
      "strength": 0.8
    }
  ],
  "countries": [
    {
      "name": "Country name in English",
      "flag": "🇺🇸",
      "bloc": "western" | "eastern" | "neutral" | "conflict_zone",
      "activity": 0.85,
      "involvedEventIds": ["id1", "id2"],
      "relationships": [
        {
          "with": "Other Country name",
          "type": "ally" | "enemy" | "proxy" | "tension" | "neutral",
          "strength": 0.9
        }
      ]
    }
  ]
}

Rules for clusters :
- Group by geopolitical situation, conflict, or region
- Minimum 2 events per cluster
- Events without a clear group go into "🌍 Other"
- Be specific with cluster names, not generic

Rules for relationships :
- Only create a relationship if there is a real geopolitical link
- strength is a float between 0.1 and 1.0
- label must be a single word

Rules for countries :
- Extract every country that appears or is strongly implied in the events
- Include both direct actors (US strikes Iran → US and Iran) 
  and indirect actors (proxy wars, alliances)
- activity = float 0 to 1 representing how active/involved this country 
  is based on the number and probability of events involving it
- bloc assignment :
  "western"      → US, UK, France, Germany, Israel, NATO members, Japan, Australia
  "eastern"     → Russia, China, Iran, North Korea, Belarus, Syria
  "neutral"     → India, Turkey, Saudi Arabia, UAE, Brazil, Pakistan, Qatar
  "conflict_zone"→ Ukraine, Gaza/Palestine, Yemen, Iraq, Lebanon, Taiwan
- For relationships, only include pairs with a real geopolitical link
- type definitions :
  "ally"    → fighting on the same side or formal alliance
  "enemy"   → in direct conflict or declared adversaries
  "proxy"   → one supports a proxy force against the other
  "tension" → hostile but not in direct conflict
  "neutral" → diplomatic or trade relationship only
- strength 0.1 to 1.0

Events to analyze :
${JSON.stringify(titles)}`;

/**
 * @param {Array<{id: string, title: string, score?: number, probability?: number, ...}>} events
 * @returns {Promise<{ clusters: Array, relationships: Array, countries: Array }>}
 */
async function computeClustersWithAI(events) {
  const selected = [...events]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MAX_EVENTS_FOR_CLUSTERING);

  const titles = selected.map((e) => ({ id: e.id, title: e.title }));

  const fetchPromise = fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "FRONTRUN",
    },
    body: JSON.stringify({
      model: "google/gemma-3-27b-it:free",
      messages: [{ role: "user", content: PROMPT(titles) }],
    }),
  });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`OpenRouter timeout (${TIMEOUT_MS / 1000}s)`)),
      TIMEOUT_MS
    )
  );

  let response;
  try {
    response = await Promise.race([fetchPromise, timeoutPromise]);
  } catch (err) {
    console.warn(`  ⚠ ${err.message} — clustering annulé`);
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text();
    console.warn(
      "  ⚠ OpenRouter HTTP error",
      response.status,
      String(errText).slice(0, 300)
    );
    throw new Error(`OpenRouter HTTP ${response.status}`);
  }

  const data = await response.json();
  console.log(
    "  → OpenRouter response (tronc. 500):",
    JSON.stringify(data).slice(0, 500)
  );
  let text = data.choices?.[0]?.message?.content || "";
  if (Array.isArray(text)) {
    text = text.map((p) => p.text || p).join("");
  }
  const clean = String(text).replace(/```json|```/g, "").trim();

  let parsed;
  try {
    let jsonStr = clean;
    const objStart = jsonStr.indexOf("{");
    const arrStart = jsonStr.indexOf("[");
    if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
      const objEnd = jsonStr.lastIndexOf("}");
      if (objEnd > objStart) jsonStr = jsonStr.slice(objStart, objEnd + 1);
    } else if (arrStart >= 0) {
      const arrEnd = jsonStr.lastIndexOf("]");
      if (arrEnd > arrStart) jsonStr = jsonStr.slice(arrStart, arrEnd + 1);
    }
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    console.warn(
      "  ⚠ Impossible de parser la réponse IA, brut (200 chars):",
      clean.slice(0, 200)
    );
    throw err;
  }

  const aiClusters = Array.isArray(parsed) ? parsed : (parsed.clusters || []);
  const relationships = Array.isArray(parsed) ? [] : (parsed.relationships || []);
  const countries = Array.isArray(parsed) ? [] : (parsed.countries || []);

  const clusters = aiClusters
    .map((cluster) => {
      const clusterEvents = (cluster.eventIds || [])
        .map((id) => events.find((e) => String(e.id) === String(id)))
        .filter(Boolean);

      if (clusterEvents.length === 0) return null;

      const topEvent = clusterEvents.reduce(
        (best, e) => ((e.score || 0) > (best.score || 0) ? e : best),
        clusterEvents[0]
      );

      const avgProbability =
        clusterEvents.reduce((sum, e) => sum + (e.probability || 0), 0) /
        clusterEvents.length;

      const hotCount = clusterEvents.filter(
        (e) => (e.probability || 0) > 0.5
      ).length;

      const clusterScore = Math.min(100, (topEvent.score || 0) + hotCount * 8);

      return {
        name: cluster.name,
        events: clusterEvents,
        eventCount: clusterEvents.length,
        topEvent,
        avgProbability: Math.round(avgProbability * 100) / 100,
        hotCount,
        clusterScore,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.clusterScore - a.clusterScore);

  if (clusters.length === 0 && events.length > 0) {
    console.warn("  ⚠ IA a retourné 0 clusters, fallback 'All Markets'");
    return {
      clusters: [{
        name: "🌍 All Markets",
        events,
        eventCount: events.length,
        topEvent: events[0],
        avgProbability: 0,
        hotCount: 0,
        clusterScore: 0,
      }],
      relationships: [],
      countries: [],
    };
  }

  return { clusters, relationships, countries };
}

module.exports = { computeClustersWithAI };
