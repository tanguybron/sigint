/**
 * AI-powered geopolitical clustering with cross-cluster relationships.
 * Uses OpenRouter to group events and identify cluster relationships.
 */

const TIMEOUT_MS = 30_000;
const MAX_EVENTS_FOR_CLUSTERING = 120;

const PROMPT = (titles) => `Group these prediction market events into geopolitical clusters,
then identify relationships between clusters.

Return ONLY a valid JSON object with exactly two fields, 
no explanation, no markdown, no backticks :

{
  "clusters": [
    {
      "name": "cluster name with flag emoji",
      "eventIds": ["id1", "id2", ...]
    }
  ],
  "relationships": [
    {
      "from": "exact cluster name A",
      "to": "exact cluster name B", 
      "label": "one word describing the link",
      "strength": 0.8
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
  (alliance, conflict, proxy war, nuclear threat, economic dependency...)
- strength is a float between 0.1 (weak link) and 1.0 (direct conflict)
- label must be a single word : "conflict", "alliance", "proxy",
  "sanctions", "nuclear", "diplomacy", "threat", "war", "tension"
- A cluster can have multiple relationships
- Do not create relationships for clusters with no obvious link

Events to analyze :
${JSON.stringify(titles)}`;

/**
 * @param {Array<{id: string, title: string, score?: number, probability?: number, ...}>} events
 * @returns {Promise<{ clusters: Array, relationships: Array }>}
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
    parsed = JSON.parse(clean);
  } catch (err) {
    console.warn(
      "  ⚠ Impossible de parser la réponse IA, brut (200 chars):",
      clean.slice(0, 200)
    );
    throw err;
  }

  // Support both new format { clusters, relationships } and legacy array format
  const aiClusters = Array.isArray(parsed) ? parsed : (parsed.clusters || []);
  const relationships = Array.isArray(parsed) ? [] : (parsed.relationships || []);

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

  return { clusters, relationships };
}

module.exports = { computeClustersWithAI };
