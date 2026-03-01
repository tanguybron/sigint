# SIGINT — Polymarket Geopolitical Intelligence

Dashboard de surveillance des marchés géopolitiques Polymarket en temps réel.

## Démarrage rapide

```bash
npm install
npm start
```

Puis ouvre → http://localhost:3000

## Ce que ça fait

- Poll l'API Polymarket toutes les 60 secondes
- Filtre automatiquement les marchés géopolitiques (Iran, Russie, élections, nucléaire...)
- Calcule un score d'alerte 0-100 basé sur :
  - Volume spike vs moyenne 7j (×40 pts)
  - Move de prix sur 1h (×30 pts)
  - Gros trade individuel whale (×20 pts)
  - Smart wallet connu (×10 pts)
- Déclenche des alertes visuelles temps réel via SSE
- Mode démo automatique si l'API est injoignable

## Détail du calcul du score

Pour chaque marché, le backend calcule un score \(0–100\) dans `server.js` via `scoreMarket` :

- **Spike de volume (max 40 pts)**  
  - On calcule un ratio `volume24h / moyenne(volume24h des ~7 derniers points)` via `computeVolumeSpike`.  
  - Si `spike ≥ 10` → **+40 pts**  
  - Si `5 ≤ spike < 10` → **+28 pts**  
  - Si `3 ≤ spike < 5` → **+16 pts**

- **Move de prix sur 1h (max 30 pts)**  
  - On prend `oneHourPriceChange` renvoyé par l'API.  
  - Si c'est 0, on recalcule un move absolu via `computePriceMove1h` (différence du prix entre maintenant et il y a ~1h, en points de probabilité).  
  - Si `|move| ≥ 25` → **+30 pts**  
  - Si `15 ≤ |move| < 25` → **+21 pts**  
  - Si `8 ≤ |move| < 15` → **+12 pts**

- **Whale trade (max 20 pts)**  
  - On regarde `maxSingleTrade` (taille du plus gros trade récent sur le marché).  
  - Si `maxSingleTrade ≥ 50 000 $` → **+20 pts**  
  - Si `20 000 ≤ maxSingleTrade < 50 000` → **+14 pts**  
  - Si `10 000 ≤ maxSingleTrade < 20 000` → **+8 pts**

- **Présence de smart wallet (10 pts)**  
  - Si `hasSmartWallet` est `true` (gros trade récent considéré “smart”) → **+10 pts**.

- **Bonus “mauvaise issue probable” (jusqu'à 15 pts)**  
  - `isBadOutcome(title)` est `true` si le titre contient des mots-clés du type *« nuclear war », « iran strike », « invasion of »*, etc.  
  - Si `isBadOutcome` et `probability ≥ 0.8` → **+15 pts** supplémentaires.  
  - Si `isBadOutcome` et `0.5 ≤ probability < 0.8` → **+8 pts**.

- **Normalisation**  
  - Le score final est **borné entre 0 et 100** puis arrondi: `score = round(min(100, score))`.  
  - Le détail par composante est renvoyé dans `breakdown` pour l’UI (volSpike, priceMove, whaleTrade, etc.).

## Indicateur de tension (Global Score)

Le score global (0–100) mesure la « tension » géopolitique collective des marchés :

| Composante | Poids | Description |
|------------|-------|-------------|
| **Densité d'alertes** | 0–35 | critical × 8 + high × 2 + medium (cap 5) |
| **Sévérité** | 0–25 | Moyenne des 5 meilleurs scores × 0,25 |
| **Pression bad outcome** | 0–20 | Marchés guerre/attaque × probabilité (×15) |
| **Activité** | 0–15 | Volume spike moyen × 3 |
| **Whale** | 0–5 | Nombre de marchés avec trade ≥ 10k$ |

## Seuils d'alerte

| Score | Niveau |
|-------|--------|
| ≥ 80  | 🔴 CRITIQUE |
| ≥ 60  | 🟡 ÉLEVÉ |
| ≥ 40  | 🔵 MOYEN |

## Structure

```
server.js          ← Backend : poller + scoring + SSE
public/index.html  ← Frontend : dashboard temps réel
```

## Prochaines étapes (V2)

- Notifications Telegram/Discord
- Tracking des smart wallets avec win rate réel
- Corrélations entre marchés liés
- Historique persistant (SQLite)
- Backtesting des alertes passées
