import { NextResponse } from 'next/server';

type Forecast = {
  tempC: number | null;
  windSpeed: number | null; // m/s
  cloud: number | null; // %
  precipMm: number | null; // mm over day
  precipProb: number | null; // % if available
};

function toISODate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function normalizeDateISO(maybe: string | undefined): string | undefined {
  if (!maybe) return undefined;
  // already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(maybe)) return maybe;
  const date = new Date(maybe);
  if (!isNaN(date.getTime())) return toISODate(date);
  return undefined;
}

function sanitizeLocationString(input?: string): string | undefined {
  if (!input) return undefined;
  let s = String(input).trim();
  // Remove trailing date fragment like "le 10 octobre 2025"
  s = s.replace(/\ble\s*\d{1,2}\s*[a-zA-Zéèêëàâôûùîïç]+(?:\s*\d{4})?/gi, '').trim();
  // Prefer capture after "à " if present
  const m = s.match(/(?:\bà|\ba)\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]+)/i);
  if (m) s = m[1].trim();
  // Remove common leading activity words if mistakenly included
  s = s.replace(/^\s*(vacances|rando|plage|mariage|sport)\s+/i, '').trim();
  // Collapse spaces and remove trailing commas
  s = s.replace(/\s{2,}/g, ' ').replace(/[,.]$/g, '').trim();
  return s || undefined;
}

function extractCandidateLocation(query: string): string | undefined {
  const q = (query || '').trim();
  if (!q) return undefined;
  // Try capitalized sequences not in stopwords/months
  const months = new Set([
    'janvier','février','fevrier','mars','avril','mai','juin','juillet','août','aout','septembre','octobre','novembre','décembre','decembre'
  ]);
  const stops = new Set(['vacances','le','la','les','à','a','en','au','aux','de','du','des']);
  const tokens = q.match(/[A-ZÀ-Ö][A-Za-zÀ-ÖØ-öø-ÿ' -]+/g) || [];
  for (const t of tokens) {
    const norm = t.trim().toLowerCase();
    if (months.has(norm) || stops.has(norm)) continue;
    // Avoid pure years
    if (/^20\d{2}$/.test(norm)) continue;
    return t.trim();
  }
  return undefined;
}

function labelWind(ms: number | null) {
  if (ms == null) return 'inconnu';
  if (ms > 10) return 'fort';
  if (ms > 5) return 'modéré';
  return 'faible';
}

function riskFromPrecipMm(mm: number | null) {
  if (mm == null) return 50;
  const x = Math.max(0, mm);
  // Logistic-ish mapping from mm to probability
  const risk = Math.round(100 / (1 + Math.exp(-(x - 3))));
  return Math.min(100, Math.max(0, risk));
}

// Partie 3.1 — Fouille des prévisions (GFS via Open‑Meteo)
// Récupère pour une journée les variables clés (temp, vent, nuages, précipitations/risque)
async function fetchGFSviaOpenMeteo(lat: number, lon: number, dateISO: string): Promise<Forecast> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'temperature_2m,wind_speed_10m,cloud_cover,precipitation,precipitation_probability');
  url.searchParams.set('models', 'gfs_seamless');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('windspeed_unit', 'ms');
  url.searchParams.set('start_date', dateISO);
  url.searchParams.set('end_date', dateISO);

  // Étape 3.1 — Accès GFS via Open‑Meteo (journalisation détaillée)
  console.log('[Étape 3.1][GFS] Envoi de la requête Open‑Meteo (modèle GFS) pour la date/journée cible', {
    url: url.toString(),
    dateISO,
    latitude: lat,
    longitude: lon,
  });

  const res = await fetch(url.toString(), { next: { revalidate: 1800 } });
  if (!res.ok) throw new Error('Open-Meteo forecast failed');
  const data = await res.json();

  const time: string[] = data?.hourly?.time ?? [];
  const t2m: number[] = data?.hourly?.temperature_2m ?? [];
  const ws10: number[] = data?.hourly?.wind_speed_10m ?? [];
  const cc: number[] = data?.hourly?.cloud_cover ?? [];
  const pr: number[] = data?.hourly?.precipitation ?? [];
  const prp: number[] | undefined = data?.hourly?.precipitation_probability;

  // Pick noon (12:00Z) if present else median index
  const noonIdx = time.findIndex((t) => t.endsWith('T12:00'));
  const idx = noonIdx >= 0 ? noonIdx : Math.floor(time.length / 2);

  // Daily sums/means (simple)
  const precipDaySum = pr.reduce((a, b) => a + (b ?? 0), 0);
  const precipProbAvg = prp && prp.length > 0 ? Math.round(prp.reduce((a, b) => a + (b ?? 0), 0) / prp.length) : null;
  const cloudAvg = cc.length ? Math.round(cc.reduce((a, b) => a + (b ?? 0), 0) / cc.length) : null;

  // Journalisation des résultats GFS
  console.log('[Étape 3.1][GFS] Résultats agrégés journée', {
    'Nombre d\'heures disponibles': time.length,
    'Précipitations (somme jour, mm)': precipDaySum,
    'Probabilité de précipitations (moyenne, %)': precipProbAvg ?? 'n/a',
    'Couverture nuageuse (moyenne, %)': cloudAvg ?? 'n/a',
  });

  return {
    tempC: t2m[idx] ?? null,
    windSpeed: ws10[idx] ?? null,
    cloud: cloudAvg,
    precipMm: precipDaySum ?? null,
    precipProb: precipProbAvg,
  };
}

// Partie 3.2 — Historique (ERA5 ici; MERRA‑2/GPM nécessitent des accès spécifiques)
// On agrège la même date (jour/mois) sur les N dernières années pour estimer des probabilités et moyennes
async function fetchHistoricalERA5ForDay(lat: number, lon: number, dateISO: string, yearsBack = 10) {
  const target = new Date(dateISO);
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  const day = String(target.getUTCDate()).padStart(2, '0');
  const year = target.getUTCFullYear();
  const years = Array.from({ length: yearsBack }, (_, i) => year - 1 - i);

  // Log démarrage historique
  console.log('[Étape 3.2][ERA5] Démarrage de la collecte historique (fenêtre de 10 ans)', { dateISO, yearsBack, années: years });

  const fetchOne = async (y: number) => {
    const start = `${y}-${month}-${day}`;
    const url = new URL('https://archive-api.open-meteo.com/v1/era5');
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    url.searchParams.set('start_date', start);
    url.searchParams.set('end_date', start);
    url.searchParams.set('daily', 'precipitation_sum,temperature_2m_mean,wind_speed_10m_max');
    url.searchParams.set('timezone', 'UTC');
    console.log('[Étape 3.2][ERA5] Récupération des données pour une année donnée', { année: y, url: url.toString() });
    const res = await fetch(url.toString(), { next: { revalidate: 86400 } });
    if (!res.ok) throw new Error('ERA5 fetch failed');
    const d = await res.json();
    const p = d?.daily?.precipitation_sum?.[0] ?? null;
    const t = d?.daily?.temperature_2m_mean?.[0] ?? null;
    const w = d?.daily?.wind_speed_10m_max?.[0] ?? null;
    return { p, t, w } as { p: number | null; t: number | null; w: number | null };
  };

  const results = await Promise.allSettled(years.map(fetchOne));
  const values = results
    .filter((r): r is PromiseFulfilledResult<{ p: number | null; t: number | null; w: number | null }> => r.status === 'fulfilled')
    .map((r) => r.value);

  const precipThreshold = 1; // mm
  const rainOccurrences = values.filter((v) => (v.p ?? 0) >= precipThreshold).length;
  const histProb = values.length ? Math.round((rainOccurrences / values.length) * 100) : null;
  const meanTemp = values.length ? Math.round((values.reduce((a, b) => a + ((b.t ?? 0)), 0) / values.length) * 10) / 10 : null;
  const meanWind = values.length ? Math.round((values.reduce((a, b) => a + ((b.w ?? 0)), 0) / values.length) * 10) / 10 : null;

  console.log('[Étape 3.2][ERA5] Synthèse des 10 années', { 'Nombre d\'années prises en compte': values.length, 'Probabilité pluie (%)': histProb, 'Température moyenne (°C)': meanTemp, 'Vent moyen/max (m/s)': meanWind });
  return { histProb, meanTemp, meanWind } as { histProb: number | null; meanTemp: number | null; meanWind: number | null };
}

// Partie 3.2 — Historique via NASA POWER (MERRA‑2/GPM)
// Agrège la même date (jour/mois) sur les N dernières années avec PRECTOTCORR (GPM corrigé), T2M (°C), WS10M (m/s)
async function fetchHistoricalPOWERForDay(lat: number, lon: number, dateISO: string, yearsBack = 10) {
  const target = new Date(dateISO);
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  const day = String(target.getUTCDate()).padStart(2, '0');
  const year = target.getUTCFullYear();
  const years = Array.from({ length: yearsBack }, (_, i) => year - 1 - i);

  console.log('[Étape 3.2][POWER] Démarrage historique MERRA‑2/GPM (fenêtre 10 ans)', { dateISO, yearsBack, années: years });

  const fetchOne = async (y: number) => {
    const ymd = `${y}${month}${day}`; // YYYYMMDD
    const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
    url.searchParams.set('parameters', 'T2M,WS10M,PRECTOTCORR');
    url.searchParams.set('start', ymd);
    url.searchParams.set('end', ymd);
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('community', 'ag');
    console.log('[Étape 3.2][POWER] fetch', { année: y, url: url.toString() });
    const res = await fetch(url.toString(), { next: { revalidate: 86400 } });
    if (!res.ok) throw new Error(`POWER fetch failed (${res.status})`);
    const d = await res.json();
    const container = (d?.properties?.parameter || d?.parameters || d?.data?.parameters || {}) as any;
    const pRaw = container?.PRECTOTCORR?.[ymd];
    const tRaw = container?.T2M?.[ymd];
    const wRaw = container?.WS10M?.[ymd];
    const toNum = (v: any) => (v == null || v === '' ? null : Number(v));
    const p = toNum(pRaw);
    const t = toNum(tRaw);
    const w = toNum(wRaw);
    return { p, t, w } as { p: number | null; t: number | null; w: number | null };
  };

  const results = await Promise.allSettled(years.map(fetchOne));
  const values = results
    .filter((r): r is PromiseFulfilledResult<{ p: number | null; t: number | null; w: number | null }> => r.status === 'fulfilled')
    .map((r) => r.value);

  const precipThreshold = 1; // mm
  const rainOccurrences = values.filter((v) => (v.p ?? 0) >= precipThreshold).length;
  const histProb = values.length ? Math.round((rainOccurrences / values.length) * 100) : null;
  const meanTemp = values.length ? Math.round((values.reduce((a, b) => a + ((b.t ?? 0)), 0) / values.length) * 10) / 10 : null;
  const meanWind = values.length ? Math.round((values.reduce((a, b) => a + ((b.w ?? 0)), 0) / values.length) * 10) / 10 : null;

  console.log('[Étape 3.2][POWER] Synthèse des 10 années', { 'Nombre d\'années prises en compte': values.length, 'Probabilité pluie (%)': histProb, 'Température moyenne (°C)': meanTemp, 'Vent moyen (m/s)': meanWind });
  return { histProb, meanTemp, meanWind } as { histProb: number | null; meanTemp: number | null; meanWind: number | null };
}

async function parseWithOpenRouter(query: string): Promise<{ location?: string; dateISO?: string; activity?: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return {};
  const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';
  const payload = {
    model,
    messages: [
      {
        role: 'system',
        content:
          'Tu extrais en JSON minifié les champs: location (ville ou lieu), dateISO (YYYY-MM-DD), activity. Réponds UNIQUEMENT avec un objet JSON. La date doit être basée sur la date actuelle si l\'année est absente.'
      },
      {
        role: 'user',
        content: `Texte: ${query}\nDate actuelle: ${toISODate(new Date())}`
      }
    ],
    temperature: 0,
    response_format: { type: 'json_object' }
  } as any;

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'my-weather-app',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000'
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error('OpenRouter parse failed');
  const data = await resp.json();
  console.log('[Étape 1][IA/Parsing] Réponse OpenRouter reçue (chat.completions).');
  const content = data?.choices?.[0]?.message?.content;
  console.log('[Étape 1][IA/Parsing] Contenu renvoyé (brut)', { content });
  if (typeof content !== 'string') return {};
  try {
    const obj = JSON.parse(content);
    // Map synonyms just in case model returns champs FR
    const rawLocation =
      (typeof obj.location === 'string' && obj.location) ||
      (typeof obj.lieu === 'string' && obj.lieu) ||
      (typeof obj.ville === 'string' && obj.ville) || undefined;
    const rawDate =
      (typeof obj.dateISO === 'string' && obj.dateISO) ||
      (typeof obj.date === 'string' && obj.date) || undefined;
    const rawActivity =
      (typeof obj.activity === 'string' && obj.activity) ||
      (typeof obj.activite === 'string' && obj.activite) || undefined;

    console.log('[Étape 1][IA/Parsing] Champs extraits (bruts)', {
      rawLocation,
      rawDate,
      rawActivity,
    });

    const location = sanitizeLocationString(rawLocation);
    const dateISO = normalizeDateISO(rawDate);
    const activity = rawActivity ?? null;

    console.log('[Étape 1][IA/Parsing] Champs normalisés', {
      location,
      dateISO,
      activity,
    });

    return { location, dateISO, activity };
  } catch {
    return {};
  }
}

async function geocodeNominatim(location: string): Promise<{ lat: number; lon: number }> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(location)}&limit=1`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'my-weather-app/1.0',
      'Accept-Language': 'fr',
      Referer: process.env.PUBLIC_APP_URL || 'http://localhost:3000'
    }
  });
  if (!res.ok) throw new Error('Geocoding failed');
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('Lieu introuvable');
  return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
}

function parseFrenchFallback(query: string): { location?: string; dateISO?: string; activity?: string } {
  const q = query || '';
  const activityMatch = q.match(/(vacances|rando|plage|mariage|sport|extérieur|exterieur)/i);
  const locationMatch = q.match(/(?:\bà|\ba)\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]+?)(?:\s+le\b|$)/i);

  const months: Record<string, number> = {
    janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
  };
  const dateMatch = q.match(/\ble\s*(\d{1,2})\s*([a-zA-Zéèêëàâôûùîïç]+)\s*(\d{4})?/i);
  let dateISO: string | undefined;
  if (dateMatch) {
    const today = new Date();
    const day = parseInt(dateMatch[1], 10);
    const monthName = dateMatch[2].toLowerCase();
    const month = months[monthName];
    const yearGiven = dateMatch[3] ? parseInt(dateMatch[3], 10) : undefined;
    if (month && !isNaN(day)) {
      const baseYear = yearGiven && yearGiven > 1900 ? yearGiven : today.getUTCFullYear();
      const target = new Date(Date.UTC(baseYear, month - 1, day));
      const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      // N'incrémente l'année que si aucune année explicite n'a été fournie
      if (!yearGiven && target < todayStart) target.setUTCFullYear(target.getUTCFullYear() + 1);
      dateISO = toISODate(target);
    }
  }
  return {
    location: locationMatch?.[1]?.trim(),
    dateISO,
    activity: activityMatch?.[1]?.toLowerCase(),
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as any;
    // Partie 1 — Réception & parsing (IA + fallback)
    console.log('[predict] request body', { hasQuery: typeof body?.query === 'string', hasLat: 'lat' in (body||{}), hasLon: 'lon' in (body||{}), hasDate: 'date' in (body||{}) });
    let { query, lat, lon, date, activity } = body as {
      query?: string;
      lat?: number;
      lon?: number;
      date?: string;
      activity?: string;
    };

    let location: string | undefined;

    if (query && typeof query === 'string' && query.trim().length > 0) {
      // Parse via OpenRouter (if API key configured)
      const parsed = await parseWithOpenRouter(query).catch(() => ({}));
      location = (parsed as any).location ?? location;
      activity = (parsed as any).activity ?? activity;
      date = (parsed as any).dateISO ?? date;
      // Fallback regex parsing if OpenRouter missing or returned nothing
      const strict = process.env.PARSING_STRICT === 'true';
      console.log('[Étape 1][IA/Parsing] Mode strict activé ?', { strict });
      if (strict && (!location || !date)) {
        console.log('[Étape 1][IA/Parsing] ÉCHEC: le modèle n\'a pas renvoyé les champs requis (location et/ou date). Arrêt en mode strict.');
        return NextResponse.json({
          error: "Extraction par le modèle incomplète: 'location' et/ou 'dateISO' manquent",
          details: { location: !!location, dateISO: !!date, activity: activity ?? null },
        }, { status: 422 });
      }
      if (!location || !date) {
        const fb = parseFrenchFallback(query);
        location = location || fb.location;
        date = date || fb.dateISO;
        activity = activity || fb.activity;
      }
    }

    // Log parsed parameters as requested
    console.log('[predict] parsed params', { location, date, activity });

    // Default date if missing: +7 days from today
    if (!date) {
      const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      date = toISODate(d);
    }

    // If coordinates are missing, geocode location (server-side -> no CORS)
    if ((lat == null || lon == null) && location) {
      const pt = await geocodeNominatim(location);
      lat = pt.lat;
      lon = pt.lon;
      console.log('[predict] geocoded coordinates', { location, lat, lon });
    }

    // As a last resort, try geocoding a cleaned query if still missing coords
    if ((lat == null || lon == null) && query) {
      const candidate = extractCandidateLocation(query);
      if (candidate) {
        try {
          const pt = await geocodeNominatim(candidate);
          lat = pt.lat;
          lon = pt.lon;
          console.log('[predict] geocoded coordinates (candidate)', { candidate, lat, lon });
        } catch {}
      }
      const cleaned = query
        .replace(/\ble\s*\d{1,2}\s*[a-zA-Zéèêëàâôûùîïç]+/gi, '')
        .replace(/\b(vacances|rando|plage|mariage|sport|extérieur|exterieur)\b/gi, '')
        .replace(/\bà\b/gi, '')
        .replace(/\b20\d{2}\b/g, '')
        .replace(/\b\d{1,4}\b/g, '')
        .trim();
      if (cleaned) {
        try {
          const pt = await geocodeNominatim(cleaned);
          lat = pt.lat;
          lon = pt.lon;
          console.log('[predict] geocoded coordinates (cleaned)', { cleaned, lat, lon });
        } catch {}
      }
    }

    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return NextResponse.json({ error: 'Missing coordinates or resolvable location' }, { status: 400 });
    }

    // Partie 2 — Déterminer le type de prédiction (futur vs historique)
    const now = new Date();
    const target = new Date(date);
    const dateISO = toISODate(target);
    const daysAhead = Math.floor((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const isFuture = target > now;
    const within16d = daysAhead <= 16; // Horizon de GFS
    console.log('[predict][part2] type decision', { dateISO, now: toISODate(now), daysAhead, isFuture, within16d });

    // Partie 3 — Fouillage des datasets selon le type
    let forecast: Forecast | null = null;
    let hist: { histProb: number | null; meanTemp: number | null; meanWind: number | null } | null = null;

    if (isFuture && within16d) {
      // Futur proche: utiliser GFS (via Open‑Meteo) et compléter avec historique (POWER: MERRA‑2/GPM)
      console.log('[predict][part3] using GFS (forecast) + POWER MERRA‑2/GPM (historical)');
      const [f, h] = await Promise.allSettled([
        fetchGFSviaOpenMeteo(lat, lon, dateISO),
        fetchHistoricalPOWERForDay(lat, lon, dateISO, 10),
      ]);
      if (f.status === 'fulfilled') forecast = f.value; else forecast = null;
      if (h.status === 'fulfilled') hist = h.value; else hist = null;
    } else {
      // Passé ou >16j: entièrement historique (POWER: MERRA‑2/GPM, fenêtre 10 ans)
      console.log('[predict][part3] using historical only (POWER MERRA‑2/GPM, 10-year window)');
      hist = await fetchHistoricalPOWERForDay(lat, lon, dateISO, 10);
    }

    // Partie 4 — Analyse & combinaison des sources
    let tempC: number | null = forecast?.tempC ?? hist?.meanTemp ?? null;
    let windSpeed: number | null = forecast?.windSpeed ?? hist?.meanWind ?? null;

    // Rain risk
    let rainRisk: number | null = null;
    if (forecast?.precipProb != null) {
      // combine forecast probability and historical
      const fProb = forecast.precipProb;
      const hProb = hist?.histProb ?? fProb;
      rainRisk = Math.round(0.7 * fProb + 0.3 * hProb);
    } else if (forecast?.precipMm != null) {
      const fProb = riskFromPrecipMm(forecast.precipMm);
      const hProb = hist?.histProb ?? fProb;
      rainRisk = Math.round(0.7 * fProb + 0.3 * hProb);
    } else if (hist?.histProb != null) {
      rainRisk = hist.histProb;
    } else {
      rainRisk = 50;
    }

    // Ajustement par activité (simple): activités extérieures => plus conservateur
    if (activity && /vacances|extérieur|rando|plage/i.test(activity)) {
      rainRisk = Math.min(100, Math.round((rainRisk ?? 50) * 1.15));
    }

    const wind = labelWind(windSpeed);
    // Partie 5 — Réponse formatée
    const response = {
      rainRisk: rainRisk ?? 50,
      wind,
      temp: tempC != null ? Math.round(tempC * 10) / 10 : null,
      source: isFuture && within16d ? 'GFS+ERA5' : 'ERA5',
      date: dateISO,
    };
    console.log('[predict] response summary', response);
    return NextResponse.json(response);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Internal error' }, { status: 500 });
  }
}