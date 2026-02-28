require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SERP_API_KEY = process.env.SERP_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function callGroq(prompt) {
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "Tu es un expert hôtelier. Tu réponds UNIQUEMENT avec du JSON valide, sans texte ni backticks.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.5,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) throw new Error(`Groq error ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function searchRealLink(hotelName, destination, checkin, checkout) {
  try {
    const query = encodeURIComponent(`${hotelName} ${destination} réservation booking site:booking.com OR site:expedia.com OR site:hotels.com`);
    const url = `https://serpapi.com/search.json?q=${query}&api_key=${SERP_API_KEY}&num=3&hl=fr`;

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const results = data.organic_results || [];

    for (const result of results) {
      const link = result.link || "";
      if (
        link.includes("booking.com/hotel") ||
        link.includes("expedia.com") ||
        link.includes("hotels.com") ||
        link.includes("tripadvisor")
      ) {
        return link;
      }
    }

    if (results.length > 0) return results[0].link;
    return null;
  } catch {
    return null;
  }
}

function buildFallbackLink(hotelName, destination, checkin, checkout, rooms, adults, children) {
  const query = encodeURIComponent(`${hotelName} ${destination}`);
  const [cy, cm, cd] = (checkin || "").split("-");
  const [oy, om, od] = (checkout || "").split("-");
  let url = `https://www.booking.com/search.html?ss=${query}&lang=fr`;
  url += `&checkin_year=${cy}&checkin_month=${cm}&checkin_monthday=${cd}`;
  url += `&checkout_year=${oy}&checkout_month=${om}&checkout_monthday=${od}`;
  url += `&no_rooms=${rooms || 1}&group_adults=${adults || 2}&group_children=${children || 0}`;
  return url;
}

function buildPrompt(body) {
  const { destination, travelType, checkin, checkout, rooms, adults, children, childrenAges, budgetMin, budgetMax, stars, amenities, aiPrompt } = body;
  const amenitiesList = amenities?.length > 0 ? amenities.join(", ") : "Aucun";

  return `Tu es expert hôtelier. Propose 3 hôtels RÉELS qui existent vraiment à ${destination}.

Critères :
- Destination : ${destination}
- Type : ${travelType || "Non précisé"}
- Arrivée : ${checkin} / Départ : ${checkout}
- Chambres : ${rooms || 1}
- Adultes : ${adults || 2}
- Enfants : ${children || 0}${childrenAges && childrenAges.length > 0 ? " (âges: " + childrenAges.join(", ") + " ans)" : ""}
- Budget : ${budgetMin} à ${budgetMax} DT/nuit
- Étoiles : ${stars}
- Équipements : ${amenitiesList}
- Demande : ${aiPrompt || "Aucune"}

JSON UNIQUEMENT, pas de texte autour :
[
  {
    "nom": "Nom exact de l'hôtel",
    "etoiles": 4,
    "adresse": "Adresse complète",
    "prix_par_nuit": 250,
    "devise": "DT",
    "description": "Description en 2 phrases.",
    "points_forts": ["Point 1", "Point 2", "Point 3"],
    "equipements": ["Piscine", "Spa"],
    "note": 8.5,
    "image_url": ""
  }
]`;
}

app.post("/api/search", async (req, res) => {
  const { destination, checkin, checkout, rooms, adults, children, childrenAges } = req.body;

  if (!destination || !checkin || !checkout) {
    return res.status(400).json({ error: "Champs obligatoires manquants." });
  }

  if (!GROQ_API_KEY) return res.status(500).json({ error: "Clé GROQ manquante." });

  try {
    const prompt = buildPrompt(req.body);
    const text = await callGroq(prompt);
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error: "JSON invalide.", raw: text });

    const hotels = JSON.parse(jsonMatch[0]);

    const hotelsWithLinks = await Promise.all(
      hotels.map(async (hotel) => {
        let lien = null;

        if (SERP_API_KEY) {
          console.log(`🔍 Recherche lien réel pour : ${hotel.nom}`);
          lien = await searchRealLink(hotel.nom, destination, checkin, checkout);
          if (lien) console.log(`✅ Lien trouvé : ${lien}`);
          else console.log(`⚠️ Lien non trouvé, utilisation fallback`);
        }

        if (!lien) {
          lien = buildFallbackLink(hotel.nom, destination, checkin, checkout, rooms, adults, children);
        }

        return { ...hotel, lien };
      })
    );

    return res.json({ hotels: hotelsWithLinks });
  } catch (error) {
    console.error("Erreur :", error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => res.json({ status: "✅ LuXIA server en ligne" }));

app.get("/test-api", async (req, res) => {
  const results = { groq: "❌", serp: "❌" };

  try {
    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "OK" }], max_tokens: 5 }),
    });
    if (r.ok) results.groq = "✅ Groq valide";
  } catch {}

  if (SERP_API_KEY) {
    try {
      const r = await fetch(`https://serpapi.com/search.json?q=test&api_key=${SERP_API_KEY}&num=1`);
      if (r.ok) results.serp = "✅ SerpAPI valide";
    } catch {}
  } else {
    results.serp = "⚠️ Clé SerpAPI non configurée (liens fallback Booking)";
  }

  res.json(results);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Serveur LuXIA sur http://localhost:${PORT}`);
  console.log(`🔑 Groq : ${GROQ_API_KEY ? "✅" : "❌ MANQUANTE"}`);
  console.log(`🔍 SerpAPI : ${SERP_API_KEY ? "✅" : "⚠️ non configuré (fallback actif)"}`);
});