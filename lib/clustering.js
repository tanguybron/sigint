/**
 * AI-powered geopolitical clustering with countries and relationships.
 * Uses OpenRouter to group events, extract countries by bloc, and define relationships.
 */

const TIMEOUT_MS = 30_000;
const MAX_EVENTS_FOR_CLUSTERING = 120;

const PROMPT = (titles) => `Analyze these prediction market events and return a JSON object
with exactly four fields. No explanation, no markdown, no backticks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLUSTERS RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Create one cluster per distinct geopolitical situation or dynamic
- Prefer specificity : a situation with 3 sub-themes becomes 3 clusters
- An event can belong to multiple clusters if relevant
- "🌍 Other" only as absolute last resort
- Minimum 2 events per cluster

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COUNTRIES RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STRICT RULE — NO INVENTION :
- Only include countries that are explicitly named in at least one event title
- Do NOT add countries based on geopolitical logic, alliances, or assumptions
- If a country is not named in any event title, it does not exist for this analysis
- Same rule for relationships : only link two countries if both are
  explicitly named in the events

For each country that passes the above rule :

involvedEventIds must include all events where the country is explicitly named.

activity : float 0.0 to 1.0
- Score based on how many events involve this country
  and how high their probabilities are
- Spread the scores to reflect real differences in involvement
- Do not cluster all countries at the same value

bloc : assign based on current geopolitical alignment
- "western"       → formal or de facto US/NATO aligned
- "eastern"       → aligned with Russia, China, or both
- "neutral"       → balancing between blocs or non-aligned
- "conflict_zone" → country currently experiencing active conflict on its soil

relationships : only between countries both explicitly named in the events
- List every meaningful pair based strictly on what the events describe
- type : "ally" | "enemy" | "proxy" | "tension" | "neutral"
- strength : 0.1 to 1.0, spread values to reflect real differences

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLUSTER RELATIONSHIPS RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Link clusters only when a real geopolitical connection exists
  based on the events themselves
- label : single English word describing the nature of the link
- strength : 0.1 to 1.0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRATEGIC POINTS RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Only include locations explicitly named in at least one event title
- Do NOT invent or infer locations not present in the events
- type : "oil_infrastructure" | "nuclear_site" | "military_base"
        | "city" | "chokepoint" | "other"
- importance : 0.1 to 1.0 based on centrality to escalation risk
- Spread importance scores — not everything should be 0.9

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{
  "clusters": [
    { "name": "string with flag emoji", "eventIds": ["id1", "id2"] }
  ],
  "relationships": [
    { "from": "cluster name", "to": "cluster name", "label": "word", "strength": 0.0 }
  ],
  "countries": [
    {
      "name": "English country name",
      "flag": "emoji",
      "bloc": "western|eastern|neutral|conflict_zone",
      "activity": 0.0,
      "involvedEventIds": ["id1"],
      "relationships": [
        { "with": "English country name", "type": "ally|enemy|proxy|tension|neutral", "strength": 0.0 }
      ]
    }
  ],
  "strategicPoints": [
    {
      "name": "location name",
      "countryName": "English country name",
      "type": "oil_infrastructure|nuclear_site|military_base|city|chokepoint|other",
      "importance": 0.0,
      "eventIds": ["id1"]
    }
  ]
}

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
      // Use a stronger default model, but keep it overridable via env
      model: process.env.OPENROUTER_MODEL || "google/gemma-3-12b-it:free",
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
  const strategicPoints = Array.isArray(parsed) ? [] : (parsed.strategicPoints || parsed.points || []);

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
      strategicPoints: [],
    };
  }

  return { clusters, relationships, countries, strategicPoints };
}

module.exports = { computeClustersWithAI };
